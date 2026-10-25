import { db } from "ponder:api";
import { feeBalances, headUpdates, messages, tokens, transfers } from "ponder:schema";
import { and, desc, eq, gte, inArray, sql, sum } from "ponder";
import type { Hono } from "hono";
import { IN_FLIGHT_STATUSES } from "@zk-bridge/shared";
import { pair } from "../../lib/pair";
import { loadGates, loadHeads } from "../heads";
import { amountOf, indexTokens, tokenView } from "../views";

const SECONDS_PER_DAY = 86_400;

const secondsNow = (override: string | undefined): number => {
  const parsed = Number(override);
  return override !== undefined && Number.isInteger(parsed) && parsed > 0 ? parsed : Math.floor(Date.now() / 1000);
};

/**
 * Registers `GET /api/summary`: everything the top bar and the footer of the dashboard show.
 *
 * Query: `now` (Unix seconds) replaces the clock, for tests.
 *
 * @param app The Hono application.
 */
export const registerSummaryRoutes = (app: Hono): void => {
  app.get("/api/summary", async (c) => {
    const now = secondsNow(c.req.query("now"));
    const index = indexTokens(await db.select().from(tokens));
    const inFlightRows = await db
      .select({ direction: messages.direction, status: messages.status, count: sql<number>`count(*)::int` })
      .from(messages)
      .where(inArray(messages.status, [...IN_FLIGHT_STATUSES]))
      .groupBy(messages.direction, messages.status);
    const volumeRows = await db
      .select({
        chainId: transfers.sourceChainId,
        token: transfers.sourceToken,
        total: sum(transfers.value),
        count: sql<number>`count(*)::int`,
      })
      .from(transfers)
      .where(and(gte(transfers.sentTimestamp, BigInt(now - SECONDS_PER_DAY))))
      .groupBy(transfers.sourceChainId, transfers.sourceToken);
    const feeRows = await db.select().from(feeBalances);
    const inFlight = {
      total: inFlightRows.reduce((total, row) => total + row.count, 0),
      byStatus: Object.fromEntries(IN_FLIGHT_STATUSES.map((status) => [status, sumBy(inFlightRows, (row) => row.status === status, 0)])),
      byDirection: Object.fromEntries(
        [...new Set(inFlightRows.map((row) => row.direction))].map((direction) => [
          direction,
          sumBy(inFlightRows, (row) => row.direction === direction, 0),
        ]),
      ),
    };
    return c.json({
      pair: pair.name,
      now,
      heads: await loadHeads(),
      gates: await loadGates(),
      inFlight,
      volume24h: volumeRows.map((row) => ({
        chainId: row.chainId,
        token: row.token === null ? null : tokenView(row.chainId, row.token, index),
        volume: row.total ?? "0",
        transfers: row.count,
      })),
      feesAccrued: feeRows
        .filter((row) => row.accrued > 0n)
        .map((row) => ({ chainId: row.chainId, token: tokenView(row.chainId, row.token, index), accrued: amountOf(row.accrued) })),
      lastHeadUpdates: await lastHeadUpdates(),
    });
  });
};

/** Sums the counts of the rows that match. */
const sumBy = <row extends { count: number }>(rows: readonly row[], matches: (row: row) => boolean, start: number): number =>
  rows.filter(matches).reduce((total, row) => total + row.count, start);

/**
 * The newest head update of each side, from the chain events: when it landed, its gas, its cost and who posted it.
 * This is the only proof data the indexer holds. It never accepts proof records from outside.
 */
const lastHeadUpdates = async () =>
  Promise.all(
    pair.sides.map(async (side) => {
      const [row] = await db
        .select()
        .from(headUpdates)
        .where(eq(headUpdates.chainId, side.chainId))
        .orderBy(desc(headUpdates.timestamp), desc(headUpdates.slot))
        .limit(1);
      return row === undefined
        ? { chainId: side.chainId, update: null }
        : {
            chainId: side.chainId,
            update: {
              slot: Number(row.slot),
              executionBlockNumber: Number(row.executionBlockNumber),
              transactionHash: row.transactionHash,
              timestamp: Number(row.timestamp),
              gasUsed: row.gasUsed.toString(),
              costWei: row.costWei.toString(),
              poster: row.poster,
            },
          };
    }),
  );
