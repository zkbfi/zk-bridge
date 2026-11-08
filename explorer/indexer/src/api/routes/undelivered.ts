import { db } from "ponder:api";
import { messages } from "ponder:schema";
import { and, asc, eq, gt, or } from "ponder";
import type { Hono } from "hono";
import type { Hex } from "viem";
import { encodeCursor, parseCursor, parseDirection } from "@zk-bridge/shared";

/** The largest page of the work list. */
export const MAX_UNDELIVERED_LIMIT = 500;
/** The page size when the request names none. */
export const DEFAULT_UNDELIVERED_LIMIT = 100;

/** One message that a stored head covers and that nobody has delivered. */
export type UndeliveredItem = {
  readonly messageId: Hex;
  readonly sourceChainId: number;
  readonly destinationChainId: number;
  readonly sentTransactionHash: Hex;
  readonly sentLogIndex: number;
  readonly coveredByHeadSlot: string;
};

type UndeliveredRow = typeof messages.$inferSelect;

/**
 * Shapes a stored message as an item of the work list. A covered message always has its send facts; a row that lacks
 * one is a gap in the index, and the list leaves it out instead of handing the archive a half-empty item.
 *
 * @param row The stored message.
 * @returns The item, or null when a send fact is missing.
 */
const undeliveredItemOf = (row: UndeliveredRow): UndeliveredItem | null => {
  const { sentTransactionHash, sentLogIndex, coveredByHeadSlot } = row;
  if (sentTransactionHash === null || sentLogIndex === null || coveredByHeadSlot === null) return null;
  return {
    messageId: row.messageId,
    sourceChainId: row.sourceChainId,
    destinationChainId: row.destinationChainId,
    sentTransactionHash,
    sentLogIndex,
    coveredByHeadSlot: coveredByHeadSlot.toString(),
  };
};

const parseLimit = (text: string | null): number | null => {
  if (text === null) return DEFAULT_UNDELIVERED_LIMIT;
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return value >= 1 && value <= MAX_UNDELIVERED_LIMIT ? value : null;
};

/**
 * Registers `GET /api/undelivered`: the messages that a stored head covers and that nobody has delivered, oldest
 * first. This is the work list of the evidence archive.
 *
 * Query, all optional: `direction` (`1>369`), `after` (the `nextCursor` of the previous page) and `limit` (1 to 500,
 * default 100). The answer is `{ items, nextCursor }`. `nextCursor` is null on the last page.
 *
 * @param app The Hono application.
 */
export const registerUndeliveredRoute = (app: Hono): void => {
  app.get("/api/undelivered", async (c) => {
    const params = new URL(c.req.url).searchParams;
    const directionText = params.get("direction");
    const direction = directionText === null ? null : parseDirection(directionText);
    if (direction === undefined) return c.json({ error: `invalid direction: ${directionText}` }, 400);
    const afterText = params.get("after");
    const after = afterText === null ? null : parseCursor(afterText);
    if (after === null && afterText !== null) return c.json({ error: `invalid after: ${afterText}` }, 400);
    const limit = parseLimit(params.get("limit"));
    if (limit === null) return c.json({ error: `invalid limit: ${params.get("limit")}` }, 400);

    const rows = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.status, "covered"),
          direction === null
            ? undefined
            : and(eq(messages.sourceChainId, direction.sourceChainId), eq(messages.destinationChainId, direction.destinationChainId)),
          after === null
            ? undefined
            : or(
                gt(messages.sentTimestamp, after.sentTimestamp),
                and(eq(messages.sentTimestamp, after.sentTimestamp), gt(messages.messageId, after.messageId)),
              ),
        ),
      )
      .orderBy(asc(messages.sentTimestamp), asc(messages.messageId))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    // A page is full only when the query found more rows than the limit, so the page has a last row. A covered
    // message was sent, so that row has a send time.
    const last = page[page.length - 1] as UndeliveredRow;
    const nextCursor =
      rows.length > limit ? encodeCursor({ sentTimestamp: last.sentTimestamp as bigint, messageId: last.messageId }) : null;
    return c.json({ items: page.flatMap((row) => undeliveredItemOf(row) ?? []), nextCursor });
  });
};
