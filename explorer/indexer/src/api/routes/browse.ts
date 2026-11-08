import { db } from "ponder:api";
import { headUpdates, messages, tokens, transfers } from "ponder:schema";
import { and, asc, desc, eq, gte, isNotNull, lt, lte, or, sql } from "ponder";
import type { Hono } from "hono";
import {
  feedItemView,
  headUpdateView,
  indexTokens,
  parseBrowseAddressesQuery,
  parseBrowseMessagesQuery,
  parseBrowseProofsQuery,
  parseBrowseTokensQuery,
  tokenListItemView,
  type BrowseAddressesQuery,
  type BrowseMessagesQuery,
  type BrowseProofsQuery,
  type BrowseTokensQuery,
} from "@zk-bridge/shared";
import { cachedFor } from "../browse-cache";
import { messageConditionsOf } from "./feed";

const COUNT = sql<number>`count(*)::int`;
const secondsNow = (): number => Math.floor(Date.now() / 1000);

/** The conditions of the message list: the feed's filters, the account roles, the time range and the `asOf` snapshot. */
const messageConditions = (query: BrowseMessagesQuery) => {
  const { sender, recipient, from, to, asOf } = query;
  return and(
    isNotNull(messages.sentTimestamp),
    ...messageConditionsOf(query),
    sender === null ? undefined : or(eq(messages.sender, sender), eq(transfers.sender, sender)),
    recipient === null ? undefined : or(eq(transfers.recipient, recipient), eq(transfers.paidTo, recipient), eq(transfers.finalRecipient, recipient)),
    from === null ? undefined : gte(messages.sentTimestamp, from),
    to === null ? undefined : lte(messages.sentTimestamp, to),
    asOf === null ? undefined : lte(messages.sentTimestamp, asOf),
  );
};

/** The order of the message list. Ties break on the identifier, so a page never repeats or skips a row. */
const messageOrder = (sort: BrowseMessagesQuery["sort"]) => {
  switch (sort) {
    case "oldest":
      return [asc(messages.sentTimestamp), asc(messages.messageId)];
    case "amount-high":
      return [sql`${transfers.value} desc nulls last`, desc(messages.sentTimestamp), desc(messages.messageId)];
    case "amount-low":
      return [sql`${transfers.value} asc nulls last`, desc(messages.sentTimestamp), desc(messages.messageId)];
    default:
      return [desc(messages.sentTimestamp), desc(messages.messageId)];
  }
};

/** The conditions of the proof list. */
const proofConditions = (query: BrowseProofsQuery) => {
  const { chainId, poster, from, to, asOf } = query;
  return and(
    chainId === null ? undefined : eq(headUpdates.chainId, chainId),
    poster === null ? undefined : eq(headUpdates.poster, poster),
    from === null ? undefined : gte(headUpdates.timestamp, from),
    to === null ? undefined : lte(headUpdates.timestamp, to),
    asOf === null ? undefined : lte(headUpdates.timestamp, asOf),
  );
};

const proofOrder = (sort: BrowseProofsQuery["sort"]) => {
  switch (sort) {
    case "oldest":
      return [asc(headUpdates.timestamp), asc(headUpdates.slot), asc(headUpdates.chainId)];
    case "slot-high":
      return [desc(headUpdates.slot), desc(headUpdates.chainId)];
    case "slot-low":
      return [asc(headUpdates.slot), asc(headUpdates.chainId)];
    default:
      return [desc(headUpdates.timestamp), desc(headUpdates.slot), desc(headUpdates.chainId)];
  }
};

/** What one address did, from the indexed rows. */
export type AddressActivity = { address: string; sent: number; received: number; posted: number; lastActive: number | null };

const SECONDS = (column: unknown) => sql<string | null>`max(${column})`;

/**
 * What every address did: transfers sent, transfers received (or paid), plain messages sent, and light client updates
 * posted, each with the newest time. Cached for ten seconds.
 */
export const loadAddressActivity = (): Promise<Map<string, AddressActivity>> =>
  cachedFor("address-activity", async () => {
    const [senders, recipients, senders2, posters] = await Promise.all([
      db.select({ address: transfers.sender, count: COUNT, last: SECONDS(transfers.sentTimestamp) }).from(transfers).where(isNotNull(transfers.sender)).groupBy(transfers.sender),
      db.select({ address: transfers.recipient, count: COUNT, last: SECONDS(transfers.sentTimestamp) }).from(transfers).where(isNotNull(transfers.recipient)).groupBy(transfers.recipient),
      db.select({ address: messages.sender, count: COUNT, last: SECONDS(messages.sentTimestamp) }).from(messages).where(and(isNotNull(messages.sender), eq(messages.kind, "message"))).groupBy(messages.sender),
      db.select({ address: headUpdates.poster, count: COUNT, last: SECONDS(headUpdates.timestamp) }).from(headUpdates).groupBy(headUpdates.poster),
    ]);
    const people = new Map<string, AddressActivity>();
    const add = (rows: readonly { address: string | null; count: number; last: string | null }[], field: "sent" | "received" | "posted") => {
      for (const row of rows) {
        if (row.address === null) continue;
        const person = people.get(row.address) ?? { address: row.address, sent: 0, received: 0, posted: 0, lastActive: null };
        person[field] += row.count;
        const last = row.last === null ? null : Number(row.last);
        if (last !== null && (person.lastActive === null || last > person.lastActive)) person.lastActive = last;
        people.set(row.address, person);
      }
    };
    add(senders, "sent");
    add(senders2, "sent");
    add(recipients, "received");
    add(posters, "posted");
    return people;
  });

const proofNumberOf = async (row: typeof headUpdates.$inferSelect): Promise<number> => {
  const [found] = await db
    .select({ count: COUNT })
    .from(headUpdates)
    .where(and(eq(headUpdates.chainId, row.chainId), or(lt(headUpdates.timestamp, row.timestamp), and(eq(headUpdates.timestamp, row.timestamp), lte(headUpdates.slot, row.slot)))));
  return found?.count ?? 0;
};

const tokenList = async (query: BrowseTokensQuery) => {
  const [rows, asSource, asDestination] = await Promise.all([
    db.select().from(tokens),
    db.select({ chainId: transfers.sourceChainId, token: transfers.sourceToken, count: COUNT }).from(transfers).where(isNotNull(transfers.sourceToken)).groupBy(transfers.sourceChainId, transfers.sourceToken),
    db.select({ chainId: transfers.destinationChainId, token: transfers.destinationToken, count: COUNT }).from(transfers).where(isNotNull(transfers.destinationToken)).groupBy(transfers.destinationChainId, transfers.destinationToken),
  ]);
  const used = new Map<string, number>();
  for (const row of [...asSource, ...asDestination]) {
    const key = `${row.chainId}:${row.token}`;
    used.set(key, (used.get(key) ?? 0) + row.count);
  }
  const index = indexTokens(rows);
  const matching = rows.filter((row) => (query.chainId === null || row.chainId === query.chainId) && (query.kind === null || row.isBridgedCopy === (query.kind === "copy")));
  const bySymbol = (a: (typeof rows)[number], b: (typeof rows)[number]) =>
    (a.symbol ?? "￿").localeCompare(b.symbol ?? "￿") || a.chainId - b.chainId || a.address.localeCompare(b.address);
  const usedBy = (row: (typeof rows)[number]) => used.get(`${row.chainId}:${row.address}`) ?? 0;
  const sorted = matching.sort(query.sort === "transfers" ? (a, b) => usedBy(b) - usedBy(a) || bySymbol(a, b) : bySymbol);
  return {
    items: sorted.slice(query.offset, query.offset + query.limit).map((row) => ({ ...tokenListItemView(row, index), transfers: usedBy(row) })),
    total: matching.length,
  };
};

const addressList = async (query: BrowseAddressesQuery) => {
  const people = [...(await loadAddressActivity()).values()];
  const field = { sender: "sent", recipient: "received", poster: "posted" } as const;
  const matching = people.filter(
    (person) => (query.role === null || person[field[query.role]] > 0) && (query.prefix === null || person.address.slice(2).startsWith(query.prefix)),
  );
  const activity = (person: AddressActivity) => person.sent + person.received + person.posted;
  const sorted = matching.sort(
    query.sort === "recent"
      ? (a, b) => (b.lastActive ?? -1) - (a.lastActive ?? -1) || a.address.localeCompare(b.address)
      : (a, b) => activity(b) - activity(a) || a.address.localeCompare(b.address),
  );
  return { items: sorted.slice(query.offset, query.offset + query.limit), total: matching.length };
};

/**
 * Registers the browse lists. Each answers `{ items, total, limit, offset, asOf }`: `total` counts every row that
 * matches the filters, not only the page. A request that names `asOf` sees only rows sent (or posted) at or before that
 * second, so rows that arrive while a reader pages do not move the pages; the answer repeats `asOf` (the clock when the
 * request named none). See `parseBrowse*Query` in `@zkb/data` for the parameters.
 *
 * - `GET /api/browse/messages`: messages and transfers; sort newest, oldest, amount-high, amount-low.
 * - `GET /api/browse/proofs`: light client updates, each with its `number` on its chain (from 1, oldest first).
 * - `GET /api/browse/tokens`: tokens, each with the transfers that name it.
 * - `GET /api/browse/addresses`: addresses with what they sent, received and posted.
 *
 * @param app The Hono application.
 */
export const registerBrowseRoutes = (app: Hono): void => {
  app.get("/api/browse/messages", async (c) => {
    const parsed = parseBrowseMessagesQuery(new URL(c.req.url).searchParams);
    if (!parsed.ok) return c.json({ error: parsed.problem }, 400);
    const { query } = parsed;
    const where = messageConditions(query);
    const [rows, [found], index] = await Promise.all([
      db.select().from(messages).leftJoin(transfers, eq(messages.messageId, transfers.messageId)).where(where).orderBy(...messageOrder(query.sort)).limit(query.limit).offset(query.offset),
      db.select({ count: COUNT }).from(messages).leftJoin(transfers, eq(messages.messageId, transfers.messageId)).where(where),
      db.select().from(tokens).then(indexTokens),
    ]);
    return c.json({
      items: rows.map((row) => feedItemView(row.messages, row.transfers, index)),
      total: found?.count ?? 0,
      limit: query.limit,
      offset: query.offset,
      asOf: query.asOf === null ? secondsNow() : Number(query.asOf),
    });
  });

  app.get("/api/browse/proofs", async (c) => {
    const parsed = parseBrowseProofsQuery(new URL(c.req.url).searchParams);
    if (!parsed.ok) return c.json({ error: parsed.problem }, 400);
    const { query } = parsed;
    const where = proofConditions(query);
    const [rows, [found]] = await Promise.all([
      db.select().from(headUpdates).where(where).orderBy(...proofOrder(query.sort)).limit(query.limit).offset(query.offset),
      db.select({ count: COUNT }).from(headUpdates).where(where),
    ]);
    const numbers = await Promise.all(rows.map(proofNumberOf));
    return c.json({
      items: rows.map((row, position) => ({ ...headUpdateView(row), number: numbers[position] })),
      total: found?.count ?? 0,
      limit: query.limit,
      offset: query.offset,
      asOf: query.asOf === null ? secondsNow() : Number(query.asOf),
    });
  });

  app.get("/api/browse/tokens", async (c) => {
    const parsed = parseBrowseTokensQuery(new URL(c.req.url).searchParams);
    if (!parsed.ok) return c.json({ error: parsed.problem }, 400);
    const { items, total } = await tokenList(parsed.query);
    return c.json({ items, total, limit: parsed.query.limit, offset: parsed.query.offset, asOf: secondsNow() });
  });

  app.get("/api/browse/addresses", async (c) => {
    const parsed = parseBrowseAddressesQuery(new URL(c.req.url).searchParams);
    if (!parsed.ok) return c.json({ error: parsed.problem }, 400);
    const { items, total } = await addressList(parsed.query);
    return c.json({ items, total, limit: parsed.query.limit, offset: parsed.query.offset, asOf: secondsNow() });
  });
};
