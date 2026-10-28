import { db } from "ponder:api";
import { headUpdates, messages, transfers } from "ponder:schema";
import { and, desc, eq, gte, isNotNull, lt, lte, or } from "ponder";
import type { Hono } from "hono";
import type { Hex } from "viem";
import {
  compareHistoryEvents,
  encodeHistoryCursor,
  historyEventKey,
  historyEventView,
  parseHistoryQuery,
  type HistoryEvent,
  type HistoryEventKind,
  type HistoryFilters,
  type MessageStatus,
} from "@zk-bridge/shared";
import { messageConditionsOf } from "./feed";

/** A SQL condition, as the Drizzle operators build it. */
type SQL = ReturnType<typeof eq>;
type Condition = SQL | undefined;

/** What the cursor says about one source of events. */
type CursorTerms = {
  readonly kind: HistoryEventKind;
  readonly timestamp: Parameters<typeof lt>[0];
  /** True for the events of this source that sort after the cursor within the same timestamp. */
  readonly keyAfter: (key: string) => SQL;
};

/**
 * The condition that keeps the events after the cursor. Events sort newest first, then by kind name, then by key,
 * both descending. A source whose kind name sorts after the cursor kind has no event left at the cursor time.
 */
const afterCursorOf = (filters: HistoryFilters, terms: CursorTerms): Condition => {
  const { cursor } = filters;
  if (cursor === null) return undefined;
  if (terms.kind > cursor.kind) return lt(terms.timestamp, cursor.timestamp);
  if (terms.kind < cursor.kind) return lte(terms.timestamp, cursor.timestamp);
  return or(lt(terms.timestamp, cursor.timestamp), and(eq(terms.timestamp, cursor.timestamp), terms.keyAfter(cursor.key)));
};

const timeRangeOf = (filters: HistoryFilters, timestamp: Parameters<typeof lt>[0]): Condition[] => [
  filters.from === null ? undefined : gte(timestamp, filters.from),
  filters.to === null ? undefined : lte(timestamp, filters.to),
];

/** True when a filter can only match messages, so a head update never matches. */
const picksMessagesOnly = (filters: HistoryFilters): boolean =>
  filters.kind !== null || filters.statuses.length > 0 || filters.token !== null || filters.address !== null;

const wantsKind = (filters: HistoryFilters, kind: HistoryEventKind): boolean =>
  filters.eventKind === null || filters.eventKind === kind;

const sentEvents = async (filters: HistoryFilters): Promise<HistoryEvent[]> => {
  if (!wantsKind(filters, "sent")) return [];
  const rows = await db
    .select()
    .from(messages)
    .leftJoin(transfers, eq(messages.messageId, transfers.messageId))
    .where(
      and(
        isNotNull(messages.sentTimestamp),
        isNotNull(messages.sentTransactionHash),
        ...messageConditionsOf(filters),
        filters.chain === null ? undefined : eq(messages.sourceChainId, filters.chain),
        ...timeRangeOf(filters, messages.sentTimestamp),
        afterCursorOf(filters, {
          kind: "sent",
          timestamp: messages.sentTimestamp,
          keyAfter: (key) => lt(messages.messageId, key as Hex),
        }),
      ),
    )
    .orderBy(desc(messages.sentTimestamp), desc(messages.messageId))
    .limit(filters.limit + 1);
  return rows.map(({ messages: row }) => ({
    kind: "sent",
    chainId: row.sourceChainId,
    timestamp: row.sentTimestamp as bigint,
    transactionHash: row.sentTransactionHash as Hex,
    messageId: row.messageId,
    slot: null,
    status: row.status as MessageStatus,
  }));
};

const deliveredEvents = async (filters: HistoryFilters): Promise<HistoryEvent[]> => {
  if (!wantsKind(filters, "delivered")) return [];
  const rows = await db
    .select()
    .from(messages)
    .leftJoin(transfers, eq(messages.messageId, transfers.messageId))
    .where(
      and(
        isNotNull(messages.deliveredTimestamp),
        isNotNull(messages.deliveredTransactionHash),
        ...messageConditionsOf(filters),
        filters.chain === null ? undefined : eq(messages.destinationChainId, filters.chain),
        ...timeRangeOf(filters, messages.deliveredTimestamp),
        afterCursorOf(filters, {
          kind: "delivered",
          timestamp: messages.deliveredTimestamp,
          keyAfter: (key) => lt(messages.messageId, key as Hex),
        }),
      ),
    )
    .orderBy(desc(messages.deliveredTimestamp), desc(messages.messageId))
    .limit(filters.limit + 1);
  return rows.map(({ messages: row }) => ({
    kind: "delivered",
    chainId: row.destinationChainId,
    timestamp: row.deliveredTimestamp as bigint,
    transactionHash: row.deliveredTransactionHash as Hex,
    messageId: row.messageId,
    slot: null,
    status: row.status as MessageStatus,
  }));
};

/** The key of a head update after the cursor key `<chainId>-<slot>`: a lower chain, or the same chain and a lower slot. */
const headKeyAfter = (key: string): SQL => {
  const [chainText, slotText] = key.split("-") as [string, string];
  return or(
    lt(headUpdates.chainId, Number(chainText)),
    and(eq(headUpdates.chainId, Number(chainText)), lt(headUpdates.slot, BigInt(slotText))),
  ) as SQL;
};

const headEvents = async (filters: HistoryFilters): Promise<HistoryEvent[]> => {
  if (!wantsKind(filters, "head-update") || picksMessagesOnly(filters)) return [];
  const rows = await db
    .select()
    .from(headUpdates)
    .where(
      and(
        filters.chain === null ? undefined : eq(headUpdates.chainId, filters.chain),
        // The light client sits on the destination chain.
        filters.direction === null ? undefined : eq(headUpdates.chainId, filters.direction.destinationChainId),
        ...timeRangeOf(filters, headUpdates.timestamp),
        afterCursorOf(filters, { kind: "head-update", timestamp: headUpdates.timestamp, keyAfter: headKeyAfter }),
      ),
    )
    .orderBy(desc(headUpdates.timestamp), desc(headUpdates.chainId), desc(headUpdates.slot))
    .limit(filters.limit + 1);
  return rows.map((row) => ({
    kind: "head-update",
    chainId: row.chainId,
    timestamp: row.timestamp,
    transactionHash: row.transactionHash,
    messageId: null,
    slot: row.slot,
    status: null,
  }));
};

/**
 * Registers `GET /api/history`: the sends, the deliveries and the stored heads of both chains in one list, newest
 * first. Each source gives its newest `limit + 1` events after the cursor, so the merged page and the next cursor are
 * exact.
 *
 * Query, all optional: the filters of `GET /api/feed` (a time range applies to the time of the event), `chain` (events
 * that happened on this chain), `eventKind` (`sent`, `delivered` or `head-update`) and `cursor`. A head update
 * belongs to no message, so a filter on kind, status, token or address leaves head updates out. The answer is
 * `{ items, nextCursor, partial: false }`.
 *
 * @param app The Hono application.
 */
export const registerHistoryRoute = (app: Hono): void => {
  app.get("/api/history", async (c) => {
    const parsed = parseHistoryQuery(new URL(c.req.url).searchParams);
    if (!parsed.ok) return c.json({ error: parsed.problem }, 400);
    const { filters } = parsed;
    const sources = await Promise.all([sentEvents(filters), deliveredEvents(filters), headEvents(filters)]);
    const merged = sources.flat().sort(compareHistoryEvents);
    const page = merged.slice(0, filters.limit);
    // A page is full only when the sources found more events than the limit, so the page has a last event.
    const last = page[page.length - 1] as HistoryEvent;
    const nextCursor =
      merged.length > filters.limit
        ? encodeHistoryCursor({ timestamp: last.timestamp, kind: last.kind, key: historyEventKey(last) })
        : null;
    return c.json({ items: page.map(historyEventView), nextCursor, partial: false });
  });
};
