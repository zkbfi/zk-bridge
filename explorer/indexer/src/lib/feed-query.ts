import { MESSAGE_STATUSES, normalizeAddress, type MessageStatus } from "@zk-bridge/shared";
import type { Address, Hex } from "viem";

/** The filters of the feed, parsed and normalized. */
export type FeedFilters = {
  readonly direction: { readonly sourceChainId: number; readonly destinationChainId: number } | null;
  readonly kind: "token" | "message" | null;
  readonly statuses: readonly MessageStatus[];
  /** A token address on either side of a transfer. */
  readonly token: Address | null;
  /** An account that is the sender, executor, recipient, fallback or payee. */
  readonly address: Address | null;
  /** The send time range in seconds, inclusive. */
  readonly from: bigint | null;
  readonly to: bigint | null;
  readonly limit: number;
  readonly cursor: FeedCursor | null;
};

/** The position after the last item of a page. Items sort by send time, newest first, then by identifier. */
export type FeedCursor = { readonly sentTimestamp: bigint; readonly messageId: Hex };

/** The result of parsing the query string of the feed. */
export type FeedQueryResult =
  | { readonly ok: true; readonly filters: FeedFilters }
  | { readonly ok: false; readonly problem: string };

/** The largest page the feed returns. */
export const MAX_FEED_LIMIT = 200;
/** The page size when the request names none. */
export const DEFAULT_FEED_LIMIT = 50;

/**
 * Encodes a cursor as `<sentTimestamp>:<messageId>`.
 *
 * @param cursor The position.
 */
export const encodeCursor = (cursor: FeedCursor): string => `${cursor.sentTimestamp}:${cursor.messageId}`;

const parseCursor = (text: string): FeedCursor | null => {
  const match = /^(\d+):(0x[0-9a-f]{64})$/.exec(text);
  if (match === null) return null;
  return { sentTimestamp: BigInt(match[1] as string), messageId: match[2] as Hex };
};

const parseDirection = (text: string): FeedFilters["direction"] | undefined => {
  const match = /^(\d+)[>-](\d+)$/.exec(text);
  if (match === null) return undefined;
  return { sourceChainId: Number(match[1]), destinationChainId: Number(match[2]) };
};

const parseStatuses = (text: string): readonly MessageStatus[] | null => {
  const names = text.split(",").filter((name) => name !== "");
  const known = names.every((name) => (MESSAGE_STATUSES as readonly string[]).includes(name));
  return known ? (names as MessageStatus[]) : null;
};

const parseSeconds = (text: string): bigint | null => (/^\d+$/.test(text) ? BigInt(text) : null);

const parseLimit = (text: string | null): number | null => {
  if (text === null) return DEFAULT_FEED_LIMIT;
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return value >= 1 && value <= MAX_FEED_LIMIT ? value : null;
};

const parseAddress = (text: string): Address | null => {
  try {
    return normalizeAddress(text);
  } catch {
    return null;
  }
};

/**
 * Parses the query string of `GET /api/feed`. Addresses are lowercased here, because the database holds lowercase.
 *
 * Parameters: `direction` (`1>369` or `1-369`), `kind` (`token` or `message`), `status` (comma list), `token`,
 * `address`, `from`, `to` (Unix seconds), `limit` (1 to 200, default 50) and `cursor` (from `nextCursor`).
 *
 * @param params The parsed query string.
 */
export const parseFeedQuery = (params: URLSearchParams): FeedQueryResult => {
  const fail = (name: string, value: string): FeedQueryResult => ({ ok: false, problem: `invalid ${name}: ${value}` });
  const direction = params.get("direction");
  const parsedDirection = direction === null ? null : parseDirection(direction);
  if (parsedDirection === undefined) return fail("direction", direction ?? "");

  const kind = params.get("kind");
  if (kind !== null && kind !== "token" && kind !== "message") return fail("kind", kind);

  const status = params.get("status");
  const statuses = status === null ? [] : parseStatuses(status);
  if (statuses === null) return fail("status", status ?? "");

  const tokenText = params.get("token");
  const token = tokenText === null ? null : parseAddress(tokenText);
  if (tokenText !== null && token === null) return fail("token", tokenText);

  const addressText = params.get("address");
  const address = addressText === null ? null : parseAddress(addressText);
  if (addressText !== null && address === null) return fail("address", addressText);

  const fromText = params.get("from");
  const from = fromText === null ? null : parseSeconds(fromText);
  if (fromText !== null && from === null) return fail("from", fromText);
  const toText = params.get("to");
  const to = toText === null ? null : parseSeconds(toText);
  if (toText !== null && to === null) return fail("to", toText);

  const limit = parseLimit(params.get("limit"));
  if (limit === null) return fail("limit", params.get("limit") ?? "");

  const cursorText = params.get("cursor");
  const cursor = cursorText === null ? null : parseCursor(cursorText);
  if (cursorText !== null && cursor === null) return fail("cursor", cursorText);

  return { ok: true, filters: { direction: parsedDirection, kind, statuses, token, address, from, to, limit, cursor } };
};
