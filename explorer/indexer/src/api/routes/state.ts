import { db } from "ponder:api";
import {
  bridgedSupply,
  escrow,
  gateEvents,
  headUpdates,
  messages,
  registryObservations,
  releaseEvents,
  tokens,
  transfers,
} from "ponder:schema";
import { and, desc, eq, notInArray, sql, sum, lt } from "ponder";
import type { Hono } from "hono";
import {
  amountOf,
  auditItemView,
  auditToken,
  describePair,
  escrowView,
  headUpdateView,
  indexTokens,
  normalizeAddress,
  numberOf,
  supplyView,
  tokenListItemView,
} from "@zk-bridge/shared";
import { pair } from "../../lib/pair";
import { loadGates, loadHeads } from "../heads";

const PAID_STATUSES = ["delivered"];

const limitOf = (text: string | undefined, fallback: number): number => {
  const value = Number(text ?? fallback);
  return Number.isInteger(value) && value >= 1 && value <= 500 ? value : fallback;
};

/**
 * Registers the state routes: pair, heads, head updates, costs, gate, registry, tokens, audit, 
 *
 * @param app The Hono application.
 */
export const registerStateRoutes = (app: Hono): void => {
  app.get("/api/pair", (c) => c.json(describePair(pair)));

  app.get("/api/heads", async (c) => c.json({ heads: await loadHeads() }));

  app.get("/api/head-updates", async (c) => {
    const chainId = c.req.query("chainId");
    const before = c.req.query("before");
    const rows = await db
      .select()
      .from(headUpdates)
      .where(
        and(
          chainId === undefined ? undefined : eq(headUpdates.chainId, Number(chainId)),
          before === undefined ? undefined : lt(headUpdates.slot, BigInt(before)),
        ),
      )
      .orderBy(desc(headUpdates.timestamp), desc(headUpdates.slot))
      .limit(limitOf(c.req.query("limit"), 50));
    return c.json({
      items: rows.map(headUpdateView),
    });
  });

  app.get("/api/light-client-costs", async (c) => {
    const perChain = await db
      .select({
        chainId: headUpdates.chainId,
        updates: sql<number>`count(*)::int`,
        gasUsed: sum(headUpdates.gasUsed),
        costWei: sum(headUpdates.costWei),
      })
      .from(headUpdates)
      .groupBy(headUpdates.chainId);
    const perPoster = await db
      .select({
        chainId: headUpdates.chainId,
        poster: headUpdates.poster,
        updates: sql<number>`count(*)::int`,
        gasUsed: sum(headUpdates.gasUsed),
        costWei: sum(headUpdates.costWei),
      })
      .from(headUpdates)
      .groupBy(headUpdates.chainId, headUpdates.poster);
    return c.json({ perChain, perPoster });
  });

  app.get("/api/gate", async (c) => {
    const events = await db
      .select()
      .from(gateEvents)
      .orderBy(desc(gateEvents.timestamp))
      .limit(limitOf(c.req.query("limit"), 50));
    return c.json({
      sides: await loadGates(),
      events: events.map((row) => ({
        chainId: row.chainId,
        kind: row.kind,
        epoch: numberOf(row.epoch),
        version: row.version,
        slot: numberOf(row.slot),
        canary: row.canary,
        transactionHash: row.transactionHash,
        blockNumber: numberOf(row.blockNumber),
        timestamp: numberOf(row.timestamp),
      })),
    });
  });

  app.get("/api/registry", async (c) => {
    const rows = await db.select().from(registryObservations).orderBy(desc(registryObservations.timestamp));
    return c.json({
      observations: rows.map((row) => ({
        chainId: row.chainId,
        version: row.version,
        slot: numberOf(row.slot),
        transactionHash: row.transactionHash,
        blockNumber: numberOf(row.blockNumber),
        timestamp: numberOf(row.timestamp),
      })),
    });
  });

  app.get("/api/tokens", async (c) => {
    const rows = await db.select().from(tokens);
    const index = indexTokens(rows);
    return c.json({ tokens: rows.map((row) => tokenListItemView(row, index)) });
  });

  app.get("/api/audit", async (c) => {
    const index = indexTokens(await db.select().from(tokens));
    const escrows = await db.select().from(escrow);
    const supplies = await db.select().from(bridgedSupply);
    const results = [];
    for (const row of escrows) {
      const copy = supplies.find((supply) => supply.nativeToken === row.token && supply.homeChainId === row.chainId);
      const pendingForward = await pendingTotal({ nativeSide: true, chainId: row.chainId, token: row.token });
      const pendingBackward = await pendingTotal({ nativeSide: false, chainId: row.chainId, token: row.token });
      const audit = auditToken({
        homeChainId: row.chainId,
        token: row.token,
        escrow: row.balance,
        bridgedSupply: copy?.supply ?? 0n,
        pendingForward,
        pendingBackward,
      });
      results.push(auditItemView({ audit, homeChainId: row.chainId, copy: copy ?? null }, index));
    }
    return c.json({ generatedNote: "the escrow and the supply are read at different blocks; recheck a mismatch once", tokens: results });
  });

  app.get("/api/escrow", async (c) => {
    const index = indexTokens(await db.select().from(tokens));
    const [escrows, supplies] = await Promise.all([db.select().from(escrow), db.select().from(bridgedSupply)]);
    return c.json({ escrow: escrows.map((row) => escrowView(row, index)), bridgedSupply: supplies.map((row) => supplyView(row, index)) });
  });

  app.get("/api/release-events", async (c) => {
    const addressText = c.req.query("address");
    let account: string | null = null;
    try {
      account = addressText === undefined ? null : normalizeAddress(addressText);
    } catch {
      return c.json({ error: `invalid address: ${addressText}` }, 400);
    }
    const events = await db
      .select()
      .from(releaseEvents)
      .where(account === null ? undefined : eq(releaseEvents.account, account as `0x${string}`))
      .orderBy(desc(releaseEvents.timestamp))
      .limit(limitOf(c.req.query("limit"), 50));
    return c.json({
      events: events.map((row) => ({
        chainId: row.chainId,
        kind: row.kind,
        token: row.token,
        account: row.account,
        value: amountOf(row.value),
        messageId: row.messageId,
        transactionHash: row.transactionHash,
        timestamp: numberOf(row.timestamp),
      })),
    });
  });
};

/** The inputs of `pendingTotal`. */
type PendingInput = {
  /** True: transfers that start from a native token on `chainId`. False: transfers back to a native token on `chainId`. */
  readonly nativeSide: boolean;
  readonly chainId: number;
  readonly token: `0x${string}`;
};

/** Sums the values of transfers that a delivery has not paid yet. */
const pendingTotal = async (input: PendingInput): Promise<bigint> => {
  const where = input.nativeSide
    ? and(eq(transfers.sourceIsNative, true), eq(transfers.sourceChainId, input.chainId), eq(transfers.sourceToken, input.token))
    : and(eq(transfers.sourceIsNative, false), eq(transfers.destinationChainId, input.chainId), eq(transfers.destinationToken, input.token));
  const [row] = await db
    .select({ total: sum(transfers.value) })
    .from(transfers)
    .innerJoin(messages, eq(messages.messageId, transfers.messageId))
    .where(and(where, notInArray(messages.status, PAID_STATUSES)));
  return BigInt(row?.total ?? "0");
};
