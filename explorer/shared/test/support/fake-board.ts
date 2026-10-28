import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fromRLP } from "@msgboard/sdk";
import { keccak256, numberToHex, type Hex } from "viem";
import { WebSocketServer, type WebSocket } from "ws";
import { word } from "./prover-builders.js";

/** One message as the fake board stores it. */
export interface StoredMessage {
  readonly category: Hex;
  readonly data: Hex;
  readonly hash: Hex;
  readonly rlp: Hex;
}

/** A msgboard node in this process: the JSON-RPC methods and the subscription that the bots use. It checks no proof of work. */
export interface FakeBoard {
  /** The request endpoint (http). The socket endpoint is the same address with the scheme `ws`. */
  readonly url: string;
  readonly messages: StoredMessage[];
  /** Every request, in order. */
  readonly requests: Array<{ readonly method: string; readonly params: unknown[] }>;
  /** Closes every open socket with a code, as valve.city does after 60 seconds (4008). */
  dropSockets(code: number): void;
  stop(): Promise<void>;
}

/**
 * Starts the fake node.
 *
 * @param options `workDivisor` sets the difficulty: the default makes the proof of work trivial.
 */
export async function startFakeBoard(options: { workDivisor?: string } = {}): Promise<FakeBoard> {
  const messages: StoredMessage[] = [];
  const requests: FakeBoard["requests"] = [];
  const subscriptions = new Map<string, { socket: WebSocket; category: string | undefined }>();
  let nextSubscription = 1;

  const answer = (method: string, params: unknown[], socket: WebSocket | null): unknown => {
    if (method === "eth_getBlockByNumber") return { hash: word(0x11), number: "0x10" };
    if (method === "msgboard_status") {
      return { enabled: true, count: numberToHex(messages.length), size: "0x0", workMultiplier: "0x1", workDivisor: options.workDivisor ?? "0xf4240" };
    }
    if (method === "msgboard_addMessage") {
      const rlp = params[0] as Hex;
      const seed = fromRLP(rlp);
      const stored = { category: seed.category, data: seed.data, hash: keccak256(rlp), rlp };
      messages.push(stored);
      for (const [id, subscription] of subscriptions) {
        if (subscription.category !== undefined && subscription.category !== stored.category) continue;
        subscription.socket.send(JSON.stringify({ jsonrpc: "2.0", method: "msgboard_subscription", params: { subscription: id, result: { ...stored, version: "0x1" } } }));
      }
      return stored.hash;
    }
    if (method === "msgboard_content") {
      const category = (params[0] as { category?: string } | undefined)?.category;
      const wanted = messages.filter((message) => category === undefined || message.category === category);
      return wanted.length === 0 ? {} : { [wanted[0]?.category as string]: wanted.map((message) => ({ ...message, version: "0x1" })) };
    }
    if (method === "msgboard_subscribe" && socket !== null) {
      const id = `0x${(nextSubscription++).toString(16).padStart(32, "0")}`;
      subscriptions.set(id, { socket, category: (params[1] as { category?: string } | undefined)?.category });
      return id;
    }
    if (method === "msgboard_unsubscribe") return subscriptions.delete(params[0] as string);
    return null;
  };

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: number; method: string; params: unknown[] };
      requests.push({ method: body.method, params: body.params });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: answer(body.method, body.params, null) }));
    });
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) => {
    socket.on("close", () => {
      for (const [id, subscription] of subscriptions) if (subscription.socket === socket) subscriptions.delete(id);
    });
    socket.on("message", (raw) => {
      const body = JSON.parse(String(raw)) as { id: number; method: string; params: unknown[] };
      requests.push({ method: body.method, params: body.params });
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: answer(body.method, body.params, socket) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    messages,
    requests,
    dropSockets: (code) => sockets.clients.forEach((client) => client.close(code, "session limit")),
    stop: () =>
      new Promise<void>((resolve) => {
        sockets.clients.forEach((client) => client.terminate());
        server.closeAllConnections();
        sockets.close(() => server.close(() => resolve()));
      }),
  };
}
