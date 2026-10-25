import { db } from "ponder:api";
import { messages, tokens, transfers } from "ponder:schema";
import { and, desc, eq, gte, isNotNull, lt, lte, or, sql, inArray } from "ponder";
import type { Hono } from "hono";
import { encodeCursor, parseFeedQuery, type FeedFilters } from "../../lib/feed-query";
import { feedItemView, indexTokens } from "../views";

/** Builds the SQL conditions for the feed filters. */
const conditionsOf = (filters: FeedFilters) => {
  const { direction, kind, statuses, token, address, from, to, cursor } = filters;
  return [
    isNotNull(messages.sentTimestamp),
    direction === null
      ? undefined
      : and(eq(messages.sourceChainId, direction.sourceChainId), eq(messages.destinationChainId, direction.destinationChainId)),
    kind === null ? undefined : eq(messages.kind, kind),
    statuses.length === 0 ? undefined : inArray(messages.status, [...statuses]),
    token === null ? undefined : or(eq(transfers.sourceToken, token), eq(transfers.destinationToken, token)),
    address === null
      ? undefined
      : or(
          eq(messages.sender, address),
          eq(messages.executor, address),
          eq(transfers.sender, address),
          eq(transfers.recipient, address),
          eq(transfers.fallbackRecipient, address),
          eq(transfers.paidTo, address),
        ),
    from === null ? undefined : gte(messages.sentTimestamp, from),
    to === null ? undefined : lte(messages.sentTimestamp, to),
    cursor === null
      ? undefined
      : or(
          lt(messages.sentTimestamp, cursor.sentTimestamp),
          and(eq(messages.sentTimestamp, cursor.sentTimestamp), lt(messages.messageId, cursor.messageId)),
        ),
  ];
};

/**
 * Registers `GET /api/feed` and `GET /api/messages/:messageId`.
 *
 * @param app The Hono application.
 */
export const registerFeedRoutes = (app: Hono): void => {
  app.get("/api/feed", async (c) => {
    const parsed = parseFeedQuery(new URL(c.req.url).searchParams);
    if (!parsed.ok) return c.json({ error: parsed.problem }, 400);
    const { filters } = parsed;
    const rows = await db
      .select()
      .from(messages)
      .leftJoin(transfers, eq(messages.messageId, transfers.messageId))
      .where(and(...conditionsOf(filters)))
      .orderBy(desc(messages.sentTimestamp), desc(messages.messageId))
      .limit(filters.limit + 1);
    const page = rows.slice(0, filters.limit);
    const index = indexTokens(await db.select().from(tokens));
    const last = page[page.length - 1];
    const hasMore = rows.length > filters.limit && last !== undefined && last.messages.sentTimestamp !== null;
    return c.json({
      items: page.map((row) => feedItemView(row.messages, row.transfers, index)),
      nextCursor:
        hasMore && last !== undefined && last.messages.sentTimestamp !== null
          ? encodeCursor({ sentTimestamp: last.messages.sentTimestamp, messageId: last.messages.messageId })
          : null,
    });
  });

  app.get("/api/messages/:messageId", async (c) => {
    const messageId = c.req.param("messageId").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(messageId)) return c.json({ error: "invalid message identifier" }, 400);
    const [row] = await db
      .select()
      .from(messages)
      .leftJoin(transfers, eq(messages.messageId, transfers.messageId))
      .where(sql`${messages.messageId} = ${messageId}`)
      .limit(1);
    if (row === undefined) return c.json({ error: "unknown message" }, 404);
    const index = indexTokens(await db.select().from(tokens));
    return c.json({ ...feedItemView(row.messages, row.transfers, index), data: row.messages.data });
  });
};
