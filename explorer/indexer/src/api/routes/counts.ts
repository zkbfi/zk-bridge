import { db } from "ponder:api";
import { bridgeStates, escrow, headUpdates, messages, tokens } from "ponder:schema";
import { eq, isNotNull, sql } from "ponder";
import type { Hono } from "hono";
import { IN_FLIGHT_STATUSES, MESSAGE_STATUSES } from "@zk-bridge/shared";
import { pair } from "../../lib/pair";
import { cachedFor } from "../browse-cache";
import { loadAddressActivity } from "./browse";

const COUNT = sql<number>`count(*)::int`;
const inFlight = (status: string): boolean => (IN_FLIGHT_STATUSES as readonly string[]).includes(status);

const messageCounts = async () => {
  const groups = await db
    .select({ sourceChainId: messages.sourceChainId, destinationChainId: messages.destinationChainId, kind: messages.kind, status: messages.status, count: COUNT })
    .from(messages)
    .where(isNotNull(messages.sentTimestamp))
    .groupBy(messages.sourceChainId, messages.destinationChainId, messages.kind, messages.status);
  const byStatus: Record<string, number> = Object.fromEntries(MESSAGE_STATUSES.map((status) => [status, 0]));
  const directions = new Map<string, { sourceChainId: number; destinationChainId: number; total: number; inFlight: number }>();
  let transfers = 0;
  let plain = 0;
  let flying = 0;
  for (const group of groups) {
    byStatus[group.status] = (byStatus[group.status] ?? 0) + group.count;
    if (group.kind === "token") transfers += group.count;
    else plain += group.count;
    if (inFlight(group.status)) flying += group.count;
    const key = `${group.sourceChainId}>${group.destinationChainId}`;
    const direction = directions.get(key) ?? { sourceChainId: group.sourceChainId, destinationChainId: group.destinationChainId, total: 0, inFlight: 0 };
    direction.total += group.count;
    if (inFlight(group.status)) direction.inFlight += group.count;
    directions.set(key, direction);
  }
  return { total: transfers + plain, inFlight: flying, transfers, plain, byStatus, directions: [...directions.values()] };
};

const updateCounts = async () => {
  const rows = await db.select({ chainId: headUpdates.chainId, count: COUNT }).from(headUpdates).groupBy(headUpdates.chainId);
  return { total: rows.reduce((sum, row) => sum + row.count, 0), chains: rows.map((row) => ({ chainId: row.chainId, count: row.count })) };
};

const tokenCounts = async () => {
  const rows = await db.select({ chainId: tokens.chainId, isBridgedCopy: tokens.isBridgedCopy, count: COUNT }).from(tokens).groupBy(tokens.chainId, tokens.isBridgedCopy);
  const chains = new Map<number, { chainId: number; total: number; native: number; copies: number }>();
  for (const row of rows) {
    const chain = chains.get(row.chainId) ?? { chainId: row.chainId, total: 0, native: 0, copies: 0 };
    chain.total += row.count;
    if (row.isBridgedCopy) chain.copies += row.count;
    else chain.native += row.count;
    chains.set(row.chainId, chain);
  }
  return { total: rows.reduce((sum, row) => sum + row.count, 0), chains: [...chains.values()] };
};

const gateCounts = async () => {
  const [open] = await db.select({ count: COUNT }).from(bridgeStates).where(eq(bridgeStates.depositsOpen, true));
  return { total: pair.sides.length, open: open?.count ?? 0 };
};

const escrowCount = async () => {
  const [entries] = await db.select({ count: COUNT }).from(escrow);
  return { entries: entries?.count ?? 0 };
};

const loadCounts = async () => {
  const [messageTotals, lightClientUpdates, tokenTotals, activity, gates, escrowTotals] = await Promise.all([
    messageCounts(),
    updateCounts(),
    tokenCounts(),
    loadAddressActivity(),
    gateCounts(),
    escrowCount(),
  ]);
  const people = [...activity.values()];
  return {
    pair: pair.name,
    asOf: Math.floor(Date.now() / 1000),
    messages: messageTotals,
    lightClientUpdates,
    addresses: {
      total: people.length,
      senders: people.filter((person) => person.sent > 0).length,
      recipients: people.filter((person) => person.received > 0).length,
      posters: people.filter((person) => person.posted > 0).length,
    },
    tokens: tokenTotals,
    contracts: pair.sides.flatMap((side) => Object.values(side.contracts)).filter((address) => address !== null).length,
    gates,
    escrow: escrowTotals,
  };
};

/**
 * Registers `GET /api/counts`: the all-time totals that the Explore browse tiles show. Messages per status, per direction
 * and per kind (transfers or plain messages), how many are in flight, light client updates per chain, tokens per chain
 * (native or bridged copy), unique addresses (senders, recipients, posters), contracts, gates and escrow entries.
 *
 * Every figure is a SQL aggregate over the whole table. The answer is cached for ten seconds, so a poll of 15 to 30
 * seconds costs one scan per ten seconds however many readers ask. Messages count from their send: a message the
 * indexer has seen only on the destination chain is not counted until its send is indexed, as in the lists.
 *
 * @param app The Hono application.
 */
export const registerCountsRoute = (app: Hono): void => {
  app.get("/api/counts", async (c) => c.json(await cachedFor("counts", loadCounts)));
};
