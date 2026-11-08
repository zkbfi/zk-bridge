import { db } from "ponder:api";
import { messages, tokens, transfers } from "ponder:schema";
import { and, desc, eq, gte, isNotNull, lt, lte, or, sql, inArray } from "ponder";
import type { Hono } from "hono";
import type { Hex } from "viem";
import { encodeCursor, feedItemView, indexTokens, parseFeedQuery, type FeedFilters } from "@zk-bridge/shared";
import { messageCostsOf } from "./transactions";

/** The filters that pick messages and their transfers, shared by the feed and the history. */
type MessageFilters = Pick<FeedFilters, "direction" | "kind" | "statuses" | "token" | "address">;

/**
 * Builds the SQL conditions that pick messages by direction, kind, status, token and account. The query must join
 * `transfers` to `messages`.
 *
 * @param filters The parsed filters.
 */
export const messageConditionsOf = (filters: MessageFilters) => {
  const { direction, kind, statuses, token, address } = filters;
  return [
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
          eq(transfers.paidTo, address),
          eq(transfers.finalRecipient, address),
        ),
  ];
};

/** Builds the SQL conditions for the feed filters. */
const conditionsOf = (filters: FeedFilters) => {
  const { from, to, cursor } = filters;
  return [
    isNotNull(messages.sentTimestamp),
    ...messageConditionsOf(filters),
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
 * The cursor that follows a full page. A page is full only when the query found more rows than the limit, and the limit
 * is at least 1, so the page has a last row. The query keeps only sent messages, so that row has a send time.
 */
const cursorAfter = (page: readonly { readonly messages: { readonly sentTimestamp: bigint | null; readonly messageId: Hex } }[]): string => {
  const last = page[page.length - 1] as (typeof page)[number];
  return encodeCursor({ sentTimestamp: last.messages.sentTimestamp as bigint, messageId: last.messages.messageId });
};

/**
 * Registers `GET /api/feed` and `GET /api/messages/:messageId` (with the message's step `costs`).
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
    return c.json({
      items: page.map((row) => feedItemView(row.messages, row.transfers, index)),
      nextCursor: rows.length > filters.limit ? cursorAfter(page) : null,
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
    return c.json({ ...feedItemView(row.messages, row.transfers, index), data: row.messages.data, costs: await messageCostsOf(row.messages) });
  });
};
