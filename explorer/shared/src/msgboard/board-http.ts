import type { Hex } from "viem";
import type { JsonResponse } from "../connection.js";
import type { BoardMessage } from "./board.js";

/** The request that a JSON-RPC call needs. A plain `JsonFetcher` ignores it and sends a GET request. */
export interface JsonRequestInit {
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * Fetches a URL and parses the JSON of the answer. It takes the same input as a `JsonFetcher` and an optional second
 * argument, so that a call can post a body. `fetchJsonResponse` of the connection module does not post.
 */
export type BoardJsonFetcher = (url: string, init?: JsonRequestInit) => Promise<JsonResponse>;

/** The fetcher that uses `fetch` and posts the body. An answer that is not JSON has the body null. */
export const postJsonResponse: BoardJsonFetcher = async (url, init) => {
  const response = await fetch(url, init === undefined ? undefined : { ...init, signal: AbortSignal.timeout(10_000) });
  const body: unknown = await response.json().catch(() => null);
  return { status: response.status, body };
};

/** The board answered with something that is not the documented shape. */
export class BoardReadError extends Error {
  override readonly name = "BoardReadError";
}

const HEX_TEXT = /^0x[0-9a-fA-F]*$/;

function isBoardMessage(value: unknown): value is BoardMessage {
  if (typeof value !== "object" || value === null) return false;
  const { category, data, hash } = value as Record<string, unknown>;
  return [category, data, hash].every((field) => typeof field === "string" && HEX_TEXT.test(field));
}

/** The request endpoint that matches a board endpoint: `wss` becomes `https`, `ws` becomes `http`. */
function httpEndpoint(boardUrl: string): string {
  return boardUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
}

/**
 * Reads the messages now on the board for one category, over HTTP, with `msgboard_content`. It has no Node import, so
 * the web bundle can load it. A message of another category in the answer is dropped.
 *
 * @throws BoardReadError when the board answers with an error status, a JSON-RPC error, or an unknown shape.
 */
export async function readBoardMessages(input: { boardUrl: string; category: Hex; fetchJson: BoardJsonFetcher }): Promise<readonly BoardMessage[]> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "msgboard_content", params: [{ category: input.category }] });
  const answer = await input.fetchJson(httpEndpoint(input.boardUrl), { method: "POST", headers: { "content-type": "application/json" }, body });
  if (answer.status < 200 || answer.status >= 300) throw new BoardReadError(`the board answered with status ${answer.status}`);
  const envelope = answer.body as { error?: { message?: unknown }; result?: unknown } | null;
  if (envelope === null || typeof envelope !== "object") throw new BoardReadError("the board answer is not a JSON object");
  if (envelope.error !== undefined) throw new BoardReadError("the board refused msgboard_content");
  const result = envelope.result;
  if (typeof result !== "object" || result === null) throw new BoardReadError("the board answer has no result object");
  const messages = Object.values(result).flat();
  if (!messages.every(isBoardMessage)) throw new BoardReadError("the board answer holds a message of an unknown shape");
  return messages
    .filter((message) => message.category.toLowerCase() === input.category.toLowerCase())
    .map((message) => ({ category: message.category, data: message.data, hash: message.hash }));
}
