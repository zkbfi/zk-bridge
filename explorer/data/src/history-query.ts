import type { Hex } from "viem";
import { parseFeedQuery, type FeedFilters } from "./feed-query.js";
import type { MessageStatus } from "./status.js";

/** The kinds of event in the history. They sort in this order (by name) when two events share a timestamp. */
export const HISTORY_EVENT_KINDS = ["delivered", "head-update", "sent"] as const;

/** One kind of history event: a send, a delivery, or a stored head of the light client. */
export type HistoryEventKind = (typeof HISTORY_EVENT_KINDS)[number];

/** One event on one chain, as the history shows it. */
export type HistoryEvent = {
  readonly kind: HistoryEventKind;
  /** The chain where the event happened. */
  readonly chainId: number;
  /** Block time in Unix seconds. */
  readonly timestamp: bigint;
  readonly transactionHash: Hex;
  /** The message of a send or a delivery. Null for a head update. */
  readonly messageId: Hex | null;
  /** The slot of a head update. Null for a send or a delivery. */
  readonly slot: bigint | null;
  /** The status of the message now. Null for a head update. */
  readonly status: MessageStatus | null;
};

/**
 * The position after the last event of a page. Events sort by time, newest first, then by kind name, then by key,
 * both descending. The key is the message identifier, or `<chainId>-<slot>` for a head update.
 */
export type HistoryCursor = { readonly timestamp: bigint; readonly kind: HistoryEventKind; readonly key: string };

/** The filters of the history: the filters of the feed (without its cursor) plus a chain and an event kind. */
export type HistoryFilters = Omit<FeedFilters, "cursor"> & {
  /** Only events that happened on this chain. */
  readonly chain: number | null;
  readonly eventKind: HistoryEventKind | null;
  readonly cursor: HistoryCursor | null;
};

/** The result of parsing the query string of the history. */
export type HistoryQueryResult =
  | { readonly ok: true; readonly filters: HistoryFilters }
  | { readonly ok: false; readonly problem: string };

/** A page of the history, as the client reads it. */
export type HistoryPage = {
  readonly items: HistoryEvent[];
  readonly nextCursor: string | null;
  readonly partial: boolean;
};

/**
 * The filters that can match only messages. One table holds them: a head update belongs to no message, so a filter in
 * the table leaves head updates out, and a history read from the chains cannot apply the filter, because the scan does
 * not read the token or the sender of a message.
 */
const MESSAGE_ONLY_FILTERS = [
  { name: "message kind", isSet: (filters: HistoryFilters) => filters.kind !== null },
  { name: "status", isSet: (filters: HistoryFilters) => filters.statuses.length > 0 },
  { name: "token", isSet: (filters: HistoryFilters) => filters.token !== null },
  { name: "address", isSet: (filters: HistoryFilters) => filters.address !== null },
] as const;

/**
 * The names of the message-only filters that are on.
 *
 * @param filters The filters.
 */
export const messageOnlyFilterNames = (filters: HistoryFilters): readonly string[] =>
  MESSAGE_ONLY_FILTERS.filter((filter) => filter.isSet(filters)).map((filter) => filter.name);

/**
 * True when a filter can match only messages, so head updates are left out of the history.
 *
 * @param filters The filters.
 */
export const picksMessagesOnly = (filters: HistoryFilters): boolean => MESSAGE_ONLY_FILTERS.some((filter) => filter.isSet(filters));

const isEventKind = (text: string): text is HistoryEventKind => (HISTORY_EVENT_KINDS as readonly string[]).includes(text);

/**
 * The key of an event inside its kind. It is the message identifier, or `<chainId>-<slot>` for a head update.
 *
 * @param event The event.
 */
export const historyEventKey = (event: HistoryEvent): string =>
  event.messageId === null ? `${event.chainId}-${event.slot}` : event.messageId;

/**
 * Encodes a cursor as `<timestamp>:<kind>:<key>`.
 *
 * @param cursor The position.
 */
export const encodeHistoryCursor = (cursor: HistoryCursor): string => `${cursor.timestamp}:${cursor.kind}:${cursor.key}`;

/**
 * Parses a cursor that `encodeHistoryCursor` wrote.
 *
 * @param text The cursor text.
 * @returns The cursor, or null when the text is not a cursor.
 */
export const parseHistoryCursor = (text: string): HistoryCursor | null => {
  const match = /^(\d+):(delivered|head-update|sent):(0x[0-9a-f]{64}|\d+-\d+)$/.exec(text);
  if (match === null) return null;
  return { timestamp: BigInt(match[1] as string), kind: match[2] as HistoryEventKind, key: match[3] as string };
};

/**
 * Compares two keys of the same kind in descending order. Head updates compare by chain, then by slot, as numbers:
 * the database sorts them that way, and "369-9" would sort after "369-10" as text. Messages compare by identifier,
 * which is fixed-width hex.
 */
const compareKeys = (left: HistoryEvent, right: HistoryEvent): number => {
  if (left.kind === "head-update") {
    // A head update always has a slot, and two events of one kind are both head updates or both messages.
    const [leftSlot, rightSlot] = [left.slot as bigint, right.slot as bigint];
    if (left.chainId !== right.chainId) return right.chainId - left.chainId;
    if (leftSlot === rightSlot) return 0;
    return leftSlot > rightSlot ? -1 : 1;
  }
  const [leftId, rightId] = [left.messageId as string, right.messageId as string];
  if (leftId === rightId) return 0;
  return leftId > rightId ? -1 : 1;
};

/**
 * Orders two events newest first. Time decides, then the kind name, then the key, both in descending order. This is
 * the order of the SQL in the indexer, so a cursor taken from the last event of a page splits the list exactly.
 *
 * @param left The first event.
 * @param right The second event.
 */
export const compareHistoryEvents = (left: HistoryEvent, right: HistoryEvent): number => {
  if (left.timestamp !== right.timestamp) return left.timestamp > right.timestamp ? -1 : 1;
  if (left.kind !== right.kind) return left.kind > right.kind ? -1 : 1;
  return compareKeys(left, right);
};

/**
 * Parses the query string of `GET /api/history`. It takes every parameter of the feed, except that `cursor` is a
 * history cursor, and adds `chain` (a chain identifier) and `eventKind` (`sent`, `delivered` or `head-update`).
 *
 * @param params The parsed query string.
 */
export const parseHistoryQuery = (params: URLSearchParams): HistoryQueryResult => {
  const feedParams = new URLSearchParams(params);
  feedParams.delete("cursor");
  const parsed = parseFeedQuery(feedParams);
  if (!parsed.ok) return parsed;

  const chainText = params.get("chain");
  if (chainText !== null && !/^\d+$/.test(chainText)) return { ok: false, problem: `invalid chain: ${chainText}` };

  const eventKind = params.get("eventKind");
  if (eventKind !== null && !isEventKind(eventKind)) return { ok: false, problem: `invalid eventKind: ${eventKind}` };

  const cursorText = params.get("cursor");
  const cursor = cursorText === null ? null : parseHistoryCursor(cursorText);
  if (cursorText !== null && cursor === null) return { ok: false, problem: `invalid cursor: ${cursorText}` };

  const { direction, kind, statuses, token, address, from, to, limit } = parsed.filters;
  return {
    ok: true,
    filters: {
      direction,
      kind,
      statuses,
      token,
      address,
      from,
      to,
      limit,
      chain: chainText === null ? null : Number(chainText),
      eventKind,
      cursor,
    },
  };
};

/**
 * The JSON form of an event. Timestamps and slots are JSON numbers, as everywhere in the API.
 *
 * @param event The event.
 */
export const historyEventView = (event: HistoryEvent) => ({
  kind: event.kind,
  chainId: event.chainId,
  timestamp: Number(event.timestamp),
  transactionHash: event.transactionHash,
  messageId: event.messageId,
  slot: event.slot === null ? null : Number(event.slot),
  status: event.status,
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const parseEvent = (value: unknown): HistoryEvent | null => {
  if (!isRecord(value)) return null;
  const { kind, chainId, timestamp, transactionHash, messageId, slot, status } = value;
  if (typeof kind !== "string" || !isEventKind(kind)) return null;
  if (typeof chainId !== "number" || typeof timestamp !== "number" || typeof transactionHash !== "string") return null;
  return {
    kind,
    chainId,
    timestamp: BigInt(timestamp),
    transactionHash: transactionHash as Hex,
    messageId: typeof messageId === "string" ? (messageId as Hex) : null,
    slot: typeof slot === "number" ? BigInt(slot) : null,
    status: typeof status === "string" ? (status as MessageStatus) : null,
  };
};

/**
 * Reads the body of `GET /api/history`.
 *
 * @param body The parsed JSON body.
 * @returns The page, or null when the body is not a page of the history or an item is not an event. The caller then
 * asks another source.
 */
export const parseHistoryEvents = (body: unknown): HistoryPage | null => {
  if (!isRecord(body) || !Array.isArray(body.items)) return null;
  const items = body.items.map(parseEvent);
  if (items.some((item) => item === null)) return null;
  const nextCursor = typeof body.nextCursor === "string" ? body.nextCursor : null;
  return { items: items as HistoryEvent[], nextCursor, partial: body.partial === true };
};
