import { db } from "ponder:api";
import { messages, tokens, transfers } from "ponder:schema";
import { and, eq, gte, sql, sum } from "ponder";
import type { Hono } from "hono";
import { indexTokens, sideOf, tokenView } from "@zk-bridge/shared";
import { pair } from "../../lib/pair";

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

/** Average, median and 90th percentile seconds (null with no deliveries). */
type Stats = { readonly avg: number | null; readonly median: number | null; readonly p90: number | null };

/** One window's timing row, as the SQL returns it. */
export type TimingRow = {
  readonly count: number;
  readonly totalAvg: number | null;
  readonly totalMedian: number | null;
  readonly totalP90: number | null;
  readonly sentMedian: number | null;
  readonly sentP90: number | null;
  readonly finalMedian: number | null;
  readonly finalP90: number | null;
  readonly readyMedian: number | null;
  readonly readyP90: number | null;
};

const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

/**
 * A window's timing as the API shows it: sent → delivered (avg, median, p90) and each step's median and p90.
 *
 * @param row The SQL row, or undefined when the window held no delivery.
 */
export const timingView = (row: TimingRow | undefined) => {
  const stats = (avg: unknown, median: unknown, p90: unknown): Stats => ({ avg: num(avg), median: num(median), p90: num(p90) });
  return {
    count: row?.count ?? 0,
    sentToDelivered: stats(row?.totalAvg, row?.totalMedian, row?.totalP90),
    steps: {
      sent: { median: num(row?.sentMedian), p90: num(row?.sentP90) },
      final: { median: num(row?.finalMedian), p90: num(row?.finalP90) },
      ready: { median: num(row?.readyMedian), p90: num(row?.readyP90) },
    },
  };
};

/**
 * One direction's timing over the messages delivered since `since`, in SQL, by the definitions of
 * `@zk-bridge/shared` transfer-timing: final = sent + the source's finality window; ready = the covering head's time,
 * or the delivery when none covered it first; Sent = min(final, ready) − sent; Final = max(0, ready − final);
 * Proof ready = delivered − ready.
 */
const timingOf = async (sourceChainId: number, since: bigint): Promise<TimingRow | undefined> => {
  const finality = BigInt(sideOf(pair, sourceChainId).finalitySeconds);
  const sent = messages.sentTimestamp;
  const delivered = messages.deliveredTimestamp;
  const final = sql`(${sent} + ${finality})`;
  const ready = sql`least(coalesce(${messages.coveredAtTimestamp}, ${delivered}), ${delivered})`;
  const total = sql`(${delivered} - ${sent})`;
  const sentStep = sql`greatest(0, least(${final}, ${ready}) - ${sent})`;
  const finalStep = sql`greatest(0, ${ready} - ${final})`;
  const readyStep = sql`greatest(0, ${delivered} - ${ready})`;
  const pct = (q: number, expr: ReturnType<typeof sql>) => sql<number | null>`percentile_cont(${q}) within group (order by ${expr})::float8`;
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      totalAvg: sql<number | null>`avg(${total})::float8`,
      totalMedian: pct(0.5, total),
      totalP90: pct(0.9, total),
      sentMedian: pct(0.5, sentStep),
      sentP90: pct(0.9, sentStep),
      finalMedian: pct(0.5, finalStep),
      finalP90: pct(0.9, finalStep),
      readyMedian: pct(0.5, readyStep),
      readyP90: pct(0.9, readyStep),
    })
    .from(messages)
    .where(and(eq(messages.status, "delivered"), eq(messages.sourceChainId, sourceChainId), gte(delivered, since)));
  return row as TimingRow | undefined;
};

/**
 * Registers `GET /api/delivered`: per direction, how many messages were delivered in the last 24 hours and the last
 * 7 days, with the value per source token, and how long they took (sent → delivered, and each in-flight step), for
 * each window. Grouped queries over the stored messages; no new indexing.
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
    const directions = deliveredView(rows, index);
    const timing = await Promise.all(
      pair.sides.map(async (side) => ({
        sourceChainId: side.chainId,
        last24h: timingView(await timingOf(side.chainId, dayStart)),
        last7d: timingView(await timingOf(side.chainId, weekStart)),
      })),
    );
    return c.json({ now, directions, timing });
  });
};
