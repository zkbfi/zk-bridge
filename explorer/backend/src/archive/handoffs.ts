/**
 * The handoff archive of this backend: the complete committee handoff update of every sync-committee period of each
 * source chain, kept for good.
 *
 * Owner, 2026-11-07: "so you are saying that if 30h pass and a period is passed without any updates to the other side,
 * then any bridges within that period are lost forever" ... "ok, but stranded would require none of the rpcs to have
 * the data, is that right?". A light client that missed a period border moves again only with the handoff update of
 * each period it missed. PulseChain beacon nodes serve no light-client routes and prune the states the prover builds
 * those updates from, so the backend asks the prover for each period's update as soon as the period ends
 * (`zk-bridge-prover handoff-update`) and keeps the record here. The prover reads it back at
 * `GET /archive/handoffs/<chainId>/<period>.json`, the chain indexer copies it into the proof archive
 * (`GET /archive/proofs`), and the proof archive exports and publishes it (docs/proof-archive.md).
 *
 * A record is public chain data and is not trusted by anyone who reads it: the proof checks the committee signature.
 */
import { createHash } from "node:crypto";
import type { PairSide } from "@zk-bridge/shared";
import type { HandoffProver, HandoffRecord } from "@zk-bridge/shared/prover";
import { handoffArchiveBases } from "../config.ts";
import type { LightClientFacts } from "../keepalive/plan.ts";
import type { HandoffEndpoints } from "../keepalive/sources.ts";
import type { Logger } from "../logger.ts";
import type { BackendModuleContext } from "../module.ts";
import type { Storage } from "../storage.ts";

/** How long the live route `GET /archive/proofs` lists a record; older ones reach the indexer through the nightly snapshot. */
export const LIVE_HANDOFF_MILLISECONDS = 7 * 86_400_000;

/** The longest wait before a failed period is tried again. */
export const MAX_RETRY_MILLISECONDS = 6 * 3_600_000;

/** What storing a record came to: new, the same record again, or another record for a period that has one (kept). */
export type StoreOutcome = "stored" | "known" | "conflict";

/** Keeps a record. The first record of a period stays; a different one is refused as a conflict. */
export function storeHandoff(storage: Storage, record: HandoffRecord, now: number): StoreOutcome {
  const sha256 = createHash("sha256").update(record.text).digest("hex");
  const existing = storage.database.prepare("SELECT sha256 FROM handoff_updates WHERE chain_id = ? AND period = ?").get(record.chainId, record.period) as { sha256: string } | undefined;
  if (existing !== undefined) return existing.sha256 === sha256 ? "known" : "conflict";
  storage.database
    .prepare("INSERT INTO handoff_updates (chain_id, period, record, sha256, attested_slot, finalized_slot, stored_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(record.chainId, record.period, record.text, sha256, record.attestedSlot, record.finalizedSlot, now);
  return "stored";
}

/** Whether a record of the period is kept. */
export function hasHandoff(storage: Storage, chainId: number, period: number): boolean {
  return storage.database.prepare("SELECT 1 AS found FROM handoff_updates WHERE chain_id = ? AND period = ?").get(chainId, period) !== undefined;
}

/** The record text of a period, or null. */
export function readHandoff(storage: Storage, chainId: number, period: number): string | null {
  const row = storage.database.prepare("SELECT record FROM handoff_updates WHERE chain_id = ? AND period = ?").get(chainId, period) as { record: string } | undefined;
  return row?.record ?? null;
}

/** The periods kept for a chain, ascending. */
export function handoffPeriods(storage: Storage, chainId: number): number[] {
  return (storage.database.prepare("SELECT period FROM handoff_updates WHERE chain_id = ? ORDER BY period").all(chainId) as Array<{ period: number }>).map((row) => row.period);
}

/** The records stored at or after `since` (milliseconds), for the indexer's live poll. */
export function recentHandoffs(storage: Storage, since: number): Array<{ chainId: number; period: number; record: string; storedAt: number }> {
  type Row = { chain_id: number; period: number; record: string; stored_at: number };
  return (storage.database.prepare("SELECT chain_id, period, record, stored_at FROM handoff_updates WHERE stored_at >= ? ORDER BY chain_id, period").all(since) as Row[]).map((row) => ({
    chainId: row.chain_id,
    period: row.period,
    record: row.record,
    storedAt: row.stored_at,
  }));
}

/**
 * Where a handoff update of a source chain can come from, for the keep-alive planner (`keepalive/sources.ts`): the
 * side's beacon node, state URLs and handoff URLs, this backend's own table (read directly), then the chain indexer's
 * archive and `handoffArchiveUrls`.
 */
export function handoffEndpointsOf(context: Pick<BackendModuleContext, "config" | "storage">, source: PairSide): HandoffEndpoints {
  return {
    chainId: source.chainId,
    beaconUrl: source.beaconUrl as string,
    stateUrls: source.stateUrls ?? [],
    handoffUrls: source.handoffUrls ?? [],
    // The first base is this backend's own route: read the table instead.
    archiveUrls: handoffArchiveBases(context.config).slice(1),
    local: (period) => hasHandoff(context.storage, source.chainId, period),
  };
}

/** One source chain the capture follows: the direction whose route has it as source, and its clock. */
export type CaptureTarget = {
  readonly direction: "first-to-second" | "second-to-first";
  readonly chainId: number;
  /** The facts of the light client that follows this chain (its clock: genesis, slot length, period length). */
  readonly readFacts: () => Promise<LightClientFacts>;
};

/** The capture of handoff updates. */
export interface HandoffCapture {
  /** Tries every ended period of the backfill window that has no record and is due for a try. */
  runOnce(): Promise<void>;
  /** Resolves when no pass runs. */
  settled(): Promise<void>;
  /** Counts for `GET /health`. */
  status(): { readonly kept: number; readonly failing: number };
}

/**
 * Builds the capture. Each pass asks the prover, one period at a time, for the ended periods of the last
 * `backfillPeriods` that have no record. A failed period waits before its next try: the pass interval, doubled with each
 * failure, at most six hours.
 */
export function createHandoffCapture(input: {
  readonly storage: Storage;
  readonly prover: HandoffProver;
  readonly targets: readonly CaptureTarget[];
  readonly backfillPeriods: number;
  readonly intervalMilliseconds: number;
  readonly logger: Logger;
  /** Milliseconds since 1970. */
  readonly now: () => number;
}): HandoffCapture {
  const { storage, logger, now } = input;
  const failures = new Map<string, { count: number; nextAt: number }>();
  let running: Promise<void> | null = null;

  async function capture(target: CaptureTarget, period: number): Promise<void> {
    const key = `${target.chainId}:${period}`;
    const failure = failures.get(key);
    if (failure !== undefined && now() < failure.nextAt) return;
    try {
      const record = await input.prover.handoffUpdate({ direction: target.direction, period });
      if (record.chainId !== target.chainId || record.period !== period) throw new Error(`the prover gave the record of chain ${record.chainId}, period ${record.period}`);
      const outcome = storeHandoff(storage, record, now());
      failures.delete(key);
      if (outcome === "conflict") logger.warn("handoff_capture_conflict", { chainId: target.chainId, period });
      else logger.info("handoff_captured", { chainId: target.chainId, period, attestedSlot: record.attestedSlot, finalizedSlot: record.finalizedSlot, bytes: record.text.length });
    } catch (error) {
      const count = (failure?.count ?? 0) + 1;
      const wait = Math.min(MAX_RETRY_MILLISECONDS, input.intervalMilliseconds * 2 ** (count - 1));
      failures.set(key, { count, nextAt: now() + wait });
      logger.warn("handoff_capture_failed", { chainId: target.chainId, period, attempts: count, retryInSeconds: Math.round(wait / 1000), error });
    }
  }

  async function pass(): Promise<void> {
    for (const target of input.targets) {
      let facts: LightClientFacts;
      try {
        facts = await target.readFacts();
      } catch (error) {
        logger.warn("handoff_capture_read_failed", { chainId: target.chainId, error });
        continue;
      }
      const slot = Math.floor((now() / 1000 - facts.genesisTime) / facts.secondsPerSlot);
      const current = Math.floor(slot / facts.slotsPerPeriod);
      for (let period = Math.max(0, current - input.backfillPeriods); period < current; period += 1) {
        if (!hasHandoff(storage, target.chainId, period)) await capture(target, period);
      }
    }
  }

  return {
    async runOnce() {
      if (running !== null) return running;
      running = pass().finally(() => {
        running = null;
      });
      return running;
    },
    async settled() {
      await running;
    },
    status() {
      const kept = (storage.database.prepare("SELECT COUNT(*) AS count FROM handoff_updates").get() as { count: number }).count;
      return { kept, failing: failures.size };
    },
  };
}
