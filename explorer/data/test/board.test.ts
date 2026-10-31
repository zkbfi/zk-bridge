import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fromRLP } from "@msgboard/sdk";
import { keccak256, stringToBytes, type Hex } from "viem";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { MessageTooLargeError, createBoardFeed, createBoardPublisher, toHttpUrl, toWebSocketUrl } from "../src/index.js";
import { grindInProcess } from "./support/grind-in-process.js";
import { memoryLogger, word } from "./support/builders.js";
import { startFakeBoard } from "./support/fake-board.js";

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

async function fakeNode() {
  const board = await startFakeBoard();
  closers.push(() => board.stop());
  return board;
}

describe("publishing on the board", () => {
  const category = keccak256(stringToBytes("zk-bridge/eth-pls/ethereum-to-pulsechain/light-client-update/v1"));

  it("grinds in a worker thread and posts the message with msgboard_addMessage", async () => {
    const node = await fakeNode();
    const { logger } = memoryLogger();
    const board = createBoardPublisher({ boardUrl: node.url, maximumMessageBytes: 8192, grind: grindInProcess, grindTimeoutMilliseconds: 60_000, logger });
    const payload: Hex = `0x${"ab".repeat(823)}`;
    const posted = await board.post({ category, payload });
    const add = node.requests.find((request) => request.method === "msgboard_addMessage");
    expect(add).toBeDefined();
    expect(posted.messageHash).toBe(keccak256(add?.params[0] as Hex));
    // The posted bytes are the length prefix encoding of a message that carries our category and our payload.
    const message = fromRLP(add?.params[0] as Hex);
    expect(message.category).toBe(category);
    expect(message.data).toBe(payload);
    expect(message.workMultiplier).toBe(1n);
    expect(message.workDivisor).toBe(1_000_000n);
  });

  it("refuses a payload over the size limit before it does any work", async () => {
    const node = await fakeNode();
    const { logger } = memoryLogger();
    const board = createBoardPublisher({ boardUrl: node.url, maximumMessageBytes: 822, grind: grindInProcess, grindTimeoutMilliseconds: 60_000, logger });
    await expect(board.post({ category, payload: `0x${"ab".repeat(823)}` })).rejects.toBeInstanceOf(MessageTooLargeError);
    expect(node.requests).toEqual([]);
  });

  it("reports a node without the msgboard module", async () => {
    const { logger } = memoryLogger();
    // A node whose status says that the module is off.
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { enabled: false, count: "0x0", size: "0x0", workMultiplier: "0x1", workDivisor: "0x1" } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const board = createBoardPublisher({
      boardUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      maximumMessageBytes: 8192,
      grind: grindInProcess,
      grindTimeoutMilliseconds: 20_000,
      logger,
    });
    await expect(board.post({ category, payload: "0x00" })).rejects.toThrow(/does not run the msgboard module/);
  });

  it("maps endpoint schemes between the request and the socket form", () => {
    expect(toWebSocketUrl("https://one.valve.city/rpc/vk_demo/evm/369")).toBe("wss://one.valve.city/rpc/vk_demo/evm/369");
    expect(toWebSocketUrl("http://127.0.0.1:8545/")).toBe("ws://127.0.0.1:8545/");
    expect(toHttpUrl("wss://one.valve.city/rpc/vk_demo/evm/369")).toBe("https://one.valve.city/rpc/vk_demo/evm/369");
    expect(toHttpUrl("ws://127.0.0.1:8545/")).toBe("http://127.0.0.1:8545/");
  });
});

describe("reading the board", () => {
  const category = word(0x31);

  /** A socket node. It answers msgboard_subscribe with a new id per socket, and closes a socket on demand. */
  async function fakeSocketNode(notificationMethod: string) {
    const sockets: WebSocket[] = [];
    const subscriptions: Array<{ id: string; category: unknown }> = [];
    const unsubscribed: string[] = [];
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    server.on("connection", (socket) => {
      sockets.push(socket);
      socket.on("message", (raw) => {
        const request = JSON.parse(String(raw)) as { id: number; method: string; params: Array<{ category?: string }> };
        if (request.method === "msgboard_subscribe") {
          const id = `0x${(subscriptions.length + 1).toString(16).padStart(32, "0")}`;
          subscriptions.push({ id, category: request.params[1]?.category });
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: id }));
          return;
        }
        if (request.method === "msgboard_unsubscribe") {
          unsubscribed.push(String(request.params[0]));
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: true }));
          return;
        }
        if (request.method === "msgboard_content") {
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { [category]: [{ category, data: "0xaa", hash: word(9) }] } }));
        }
      });
    });
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const notify = (socket: WebSocket, id: string, data: Hex, method = notificationMethod) =>
      socket.send(JSON.stringify({ jsonrpc: "2.0", method, params: { subscription: id, result: { category, data, hash: word(7) } } }));
    return { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, sockets, subscriptions, unsubscribed, notify };
  }

  const waitFor = async (condition: () => boolean) => {
    for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(condition()).toBe(true);
  };

  it("filters by category on the node, routes by subscription id, and survives a close with code 4008", async () => {
    const node = await fakeSocketNode("msgboard_subscription");
    const { logger } = memoryLogger();
    const feed = createBoardFeed({ boardUrl: node.url, reconnectDelayMilliseconds: 20, logger });
    closers.push(() => feed.close());
    const received: Hex[] = [];
    await feed.subscribe(category, (message) => received.push(message.data));
    expect(node.subscriptions[0]?.category).toBe(category);

    node.notify(node.sockets[0] as WebSocket, node.subscriptions[0]?.id as string, "0x01");
    await waitFor(() => received.length === 1);

    // valve.city closes the public socket after 60 seconds with code 4008.
    (node.sockets[0] as WebSocket).close(4008, "session limit");
    await waitFor(() => node.subscriptions.length === 2);
    node.notify(node.sockets[1] as WebSocket, node.subscriptions[1]?.id as string, "0x02");
    await waitFor(() => received.length === 2);
    expect(received).toEqual(["0x01", "0x02"]);

    // A notification for an id that no subscription holds is dropped, not delivered.
    node.notify(node.sockets[1] as WebSocket, "0xdeadbeef", "0x03");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(received).toEqual(["0x01", "0x02"]);
  });

  it("routes on the subscription id and not on the notification name, so both node builds work", async () => {
    const node = await fakeSocketNode("msgboard_subscribe");
    const { logger } = memoryLogger();
    const feed = createBoardFeed({ boardUrl: node.url, reconnectDelayMilliseconds: 20, logger });
    closers.push(() => feed.close());
    const received: Hex[] = [];
    await feed.subscribe(category, (message) => received.push(message.data));
    node.notify(node.sockets[0] as WebSocket, node.subscriptions[0]?.id as string, "0x05");
    await waitFor(() => received.length === 1);
  });

  it("closes a subscription on the node, and delivers nothing after it", async () => {
    const node = await fakeSocketNode("msgboard_subscription");
    const { logger } = memoryLogger();
    const feed = createBoardFeed({ boardUrl: node.url, reconnectDelayMilliseconds: 20, logger });
    closers.push(() => feed.close());
    const received: Hex[] = [];
    const subscription = await feed.subscribe(category, (message) => received.push(message.data));
    const id = node.subscriptions[0]?.id as string;
    await subscription.close();
    expect(node.unsubscribed).toEqual([id]);
    node.notify(node.sockets[0] as WebSocket, id, "0x09");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(received).toEqual([]);
  });

  it("reads the messages now on the board, to fill the gap that a dropped socket leaves", async () => {
    const node = await fakeSocketNode("msgboard_subscription");
    const { logger } = memoryLogger();
    const feed = createBoardFeed({ boardUrl: node.url, reconnectDelayMilliseconds: 20, logger });
    closers.push(() => feed.close());
    expect((await feed.recent(category)).map((message) => message.data)).toEqual(["0xaa"]);
  });
});

describe("a socket that the caller passes", () => {
  it("is used instead of the global WebSocket, with the socket form of the address", async () => {
    const opened: Array<{ url: string; reconnectDelayMs: number }> = [];
    const message = { category: word(1), data: "0xbb" as Hex, hash: word(2) };
    const feed = createBoardFeed({
      boardUrl: "https://board.example/rpc",
      reconnectDelayMilliseconds: 5,
      logger: memoryLogger().logger,
      createSocket: (url, options) => {
        opened.push({ url, ...options });
        return {
          subscribeMessages: async (onMessage: (next: { category: Hex; data: Hex; hash: Hex }) => void) => {
            onMessage(message);
            return { unsubscribe: async () => undefined };
          },
          content: async () => ({ [message.category]: [message] }),
          close: async () => undefined,
        } as never;
      },
    });
    const received: Hex[] = [];
    await feed.subscribe(message.category, (next) => received.push(next.data));
    expect(received).toEqual(["0xbb"]);
    expect(await feed.recent(message.category)).toEqual([message]);
    expect(opened).toEqual([{ url: "wss://board.example/rpc", reconnectDelayMs: 5 }]);
    await feed.close();
  });
});
