import { createClient, http, hexToBytes, type Hex } from "viem";
import { MsgBoardWsClient } from "@msgboard/sdk/ws";
import type { LogSink } from "../log-sink.js";
import type { GrindFunction } from "./grind-types.js";

/** One message as the runner sees it. */
export interface BoardMessage {
  readonly category: Hex;
  readonly data: Hex;
  readonly hash: Hex;
}

/** A standing wish to receive messages. */
export interface BoardSubscription {
  close(): Promise<void>;
}

/** The side of msgboard that the publisher uses. */
export interface BoardPublisher {
  /**
   * Grinds the proof of work and posts the message.
   * @throws MessageTooLargeError when the payload is over the limit.
   */
  post(input: { readonly category: Hex; readonly payload: Hex }): Promise<{ readonly messageHash: Hex; readonly grindMilliseconds: number; readonly difficulty: bigint; readonly threads: number }>;
}

/** The side of msgboard that the runner uses. */
export interface BoardFeed {
  /** Calls `onMessage` for each message of the category, and keeps doing so across reconnects. */
  subscribe(category: Hex, onMessage: (message: BoardMessage) => void): Promise<BoardSubscription>;
  /** The messages now on the board for the category. It fills the gaps that a dropped socket leaves. */
  recent(category: Hex): Promise<readonly BoardMessage[]>;
  close(): Promise<void>;
}

/** The payload is larger than the board accepts. */
export class MessageTooLargeError extends Error {
  override readonly name = "MessageTooLargeError";
  constructor(
    readonly size: number,
    readonly limit: number,
  ) {
    super(`the message has ${size} bytes, over the limit of ${limit} bytes`);
  }
}

/** Input of {@link createBoardPublisher}. */
export interface BoardPublisherInput {
  readonly boardUrl: string;
  /** The largest payload in bytes. The node default is 8192. */
  readonly maximumMessageBytes: number;
  readonly grind: GrindFunction;
  readonly grindTimeoutMilliseconds: number;
  readonly logger: LogSink;
}

/** The scheme of the socket that matches an endpoint: `https` becomes `wss`, `http` becomes `ws`. */
export function toWebSocketUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === "https:") parsed.protocol = "wss:";
  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  return parsed.toString();
}

/** The scheme of the request endpoint that matches a socket: `wss` becomes `https`. */
export function toHttpUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === "wss:") parsed.protocol = "https:";
  if (parsed.protocol === "ws:") parsed.protocol = "http:";
  return parsed.toString();
}

/**
 * Builds the publishing side of msgboard. The size check runs first, so a payload that the node would refuse costs no
 * proof of work. The work runs through `grind`, which is a worker thread in production. `msgboard_addMessage` then
 * posts the message in the length prefix encoding.
 */
export function createBoardPublisher(input: BoardPublisherInput): BoardPublisher {
  const client = createClient({ transport: http(toHttpUrl(input.boardUrl), { timeout: 30_000, retryCount: 2 }) });
  return {
    async post({ category, payload }) {
      const size = hexToBytes(payload).length;
      if (size > input.maximumMessageBytes) throw new MessageTooLargeError(size, input.maximumMessageBytes);
      const work = await input.grind({
        boardUrl: toHttpUrl(input.boardUrl),
        category,
        payload,
        timeoutMilliseconds: input.grindTimeoutMilliseconds,
      });
      const messageHash = (await client.request({ method: "msgboard_addMessage", params: [work.rlp] } as never)) as Hex;
      input.logger.debug("board_message_posted", { messageHash, size, difficulty: work.difficulty, iterations: work.iterations, threads: work.threads, grindMilliseconds: work.durationMilliseconds });
      return { messageHash, grindMilliseconds: work.durationMilliseconds, difficulty: work.difficulty, threads: work.threads };
    },
  };
}

/** The part of the socket client of `@msgboard/sdk` that the feed uses. */
export type BoardSocket = Pick<MsgBoardWsClient, "subscribeMessages" | "content" | "close">;

/** Input of {@link createBoardFeed}. */
export interface BoardFeedInput {
  readonly boardUrl: string;
  readonly reconnectDelayMilliseconds: number;
  readonly logger: LogSink;
  /** Replaces the socket client. The default one opens the global `WebSocket`. */
  readonly createSocket?: (url: string, options: { readonly reconnectDelayMs: number }) => BoardSocket;
}

/**
 * Builds the reading side of msgboard. The socket client of `@msgboard/sdk` routes each notification by subscription
 * identifier, reconnects after a close (the valve.city public sockets close after 60 seconds with code 4008) and opens
 * every subscription again. `recent` reads `msgboard_content` over the same socket for the messages that arrived while
 * the socket was down.
 */
export function createBoardFeed(input: BoardFeedInput): BoardFeed {
  const open = input.createSocket ?? ((url, options) => new MsgBoardWsClient(url, options));
  const socket = open(toWebSocketUrl(input.boardUrl), { reconnectDelayMs: input.reconnectDelayMilliseconds });
  return {
    async subscribe(category, onMessage) {
      const subscription = await socket.subscribeMessages(
        (message) => onMessage({ category: message.category, data: message.data, hash: message.hash }),
        { category },
      );
      input.logger.info("board_subscribed", { category });
      return { close: () => subscription.unsubscribe() };
    },
    async recent(category) {
      const content = await socket.content({ category });
      return Object.values(content)
        .flat()
        .map((message) => ({ category: message.category, data: message.data, hash: message.hash }));
    },
    close: () => socket.close(),
  };
}
