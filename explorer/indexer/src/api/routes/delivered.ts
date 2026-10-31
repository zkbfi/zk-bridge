import { db } from "ponder:api";
import { messages, tokens, transfers } from "ponder:schema";
import { and, eq, gte, sql, sum } from "ponder";
import type { Hono } from "hono";
import { indexTokens, tokenView } from "@zk-bridge/shared";

const SECONDS_PER_DAY = 86_400;

const secondsNow = (override: string | undefined): number => {
  const parsed = Number(override);
  return override !== undefined && Number.isInteger(parsed) && parsed > 0 ? parsed : Math.floor(Date.now() / 1000);
};

/** One grouped row: a direction and a source token, with its deliveries of the last day and of the last week. */
export type DeliveredRow = {
  readonly sourceChainId: number;
  readonly destinationChainId: number;
  readonly token: string | null;
  readonly day: number;
  readonly week: number;
  readonly dayValue: string | null;
  readonly weekValue: string | null;
};

/**
 * The answer's directions from the grouped rows: per direction, the count delivered in the last 24 hours and 7 days,
 * and per source token the value delivered in each (decimal strings in base units; the page prices them).
 *
 * @param rows The rows, one per direction and token.
 * @param index The token rows, for the token objects.
 */
export const deliveredView = (rows: readonly DeliveredRow[], index: ReturnType<typeof indexTokens>) => {
  const directions = new Map<string, { sourceChainId: number; destinationChainId: number; last24h: number; last7d: number; byToken: unknown[] }>();
  for (const row of rows) {
    const key = `${row.sourceChainId}>${row.destinationChainId}`;
    const entry = directions.get(key) ?? { sourceChainId: row.sourceChainId, destinationChainId: row.destinationChainId, last24h: 0, last7d: 0, byToken: [] };
    entry.last24h += Number(row.day);
    entry.last7d += Number(row.week);
    if (row.token !== null) entry.byToken.push({ token: tokenView(row.sourceChainId, row.token, index), value24h: row.dayValue ?? "0", value7d: row.weekValue ?? "0" });
    directions.set(key, entry);
  }
  return [...directions.values()];
};

/**
 * Registers `GET /api/delivered`: per direction, how many messages were delivered in the last 24 hours and the last
 * 7 days, with the value per source token. One grouped query over the stored messages; no new indexing.
 *
 * Query: `now` (Unix seconds) replaces the clock, for tests.
 *
 * @param app The Hono application.
 */
export const registerDeliveredRoute = (app: Hono): void => {
  app.get("/api/delivered", async (c) => {
    const now = secondsNow(c.req.query("now"));
    const dayStart = BigInt(now - SECONDS_PER_DAY);
    const weekStart = BigInt(now - 7 * SECONDS_PER_DAY);
    const index = indexTokens(await db.select().from(tokens));
    const rows = (await db
      .select({
        sourceChainId: messages.sourceChainId,
        destinationChainId: messages.destinationChainId,
        token: transfers.sourceToken,
        day: sql<number>`sum(case when ${messages.deliveredTimestamp} >= ${dayStart} then 1 else 0 end)::int`,
        week: sql<number>`count(*)::int`,
        dayValue: sql<string | null>`sum(case when ${messages.deliveredTimestamp} >= ${dayStart} then ${transfers.value} else 0 end)::text`,
        weekValue: sql<string | null>`${sum(transfers.value)}::text`,
      })
      .from(messages)
      .leftJoin(transfers, eq(messages.messageId, transfers.messageId))
      .where(and(eq(messages.status, "delivered"), gte(messages.deliveredTimestamp, weekStart)))
      .groupBy(messages.sourceChainId, messages.destinationChainId, transfers.sourceToken)) as DeliveredRow[];
    return c.json({ now, directions: deliveredView(rows, index) });
  });
};
