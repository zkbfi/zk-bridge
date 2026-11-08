/**
 * The warm-up record in the backend database: the observed times to a ready worker (the lead time is learned from
 * them) and the warm-up sessions (the daily cap counts them, and they let the cost be audited).
 */
import { randomUUID } from "node:crypto";
import type { ProofDirection } from "@zk-bridge/shared";
import type { ProveTiming } from "@zk-bridge/shared/prover";
import type { Storage } from "../storage.ts";
import { leadFrom, type Lead, type WarmupConfig, type WarmupEnd } from "./warmup.ts";

/** How many observations the table keeps. More than any lead time reads. */
export const OBSERVATIONS_KEPT = 200;

/** Sessions older than this many milliseconds are deleted. */
export const SESSION_RETENTION_MILLISECONDS = 7 * 24 * 3_600_000;

/** The window of the daily cap, in milliseconds. */
export const CAP_WINDOW_MILLISECONDS = 24 * 3_600_000;

/** Where an observation comes from: a warm-up ping answered ready, one that timed out, or a job that met a cold worker. */
export type ObservationSource = "ping" | "ping-timeout" | "job";

/** How a session ended. `restart`: the backend stopped while it ran. `timeout`: its ping timed out. */
export type SessionOutcome = WarmupEnd | "timeout" | "restart";

/** One UTC day of warm-up sessions (by the day they started). `used`: a job started on the warm worker. */
export type WarmupDay = {
  readonly day: string;
  readonly sessions: number;
  readonly used: number;
  readonly wasted: number;
  /** Billed seconds estimated for all sessions, and for the wasted ones. */
  readonly billedSeconds: number;
  readonly wastedSeconds: number;
  /** Seconds the worker sat ready before the due time in used sessions: the lead that was longer than needed. */
  readonly idleBeforeDueSeconds: number;
  readonly estimatedCostUsd: number;
  readonly wastedCostUsd: number;
};

/** The warm-up record. Times in milliseconds since 1970. */
export interface WarmupStore {
  /** The lead time from the newest observations of every direction (one endpoint serves both). */
  lead(config: WarmupConfig): Lead;
  recordObservation(input: { direction: ProofDirection; source: ObservationSource; seconds: number; at: number }): void;
  /** Opens a session and answers its identifier. */
  openSession(input: { direction: ProofDirection; why: string; dueAt: number; leadSeconds: number; at: number; prediction?: string }): string;
  /**
   * Whether a session of the direction was opened for the prediction ({@link predictionOf}) and spent its start: one
   * that is open or ended in any way but `unusable` (the plan moved far off, so the prediction changed) or `restart`
   * (the backend stopped it). Read from the database, so it survives a restart of the backend.
   */
  predictionStarted(direction: ProofDirection, prediction: string): boolean;
  markReady(id: string, at: number): void;
  /**
   * Ends a session. Its billed time is the estimate from the start to `at`, plus the endpoint's idle timeout (a worker
   * is billed until the timeout after its last request); `idleTimeoutSeconds` is added.
   */
  endSession(id: string, outcome: SessionOutcome, at: number, idleTimeoutSeconds: number): void;
  /** Ends every open session as `restart`, at `at`. A running backend has none open from before its start. */
  closeOpenSessions(at: number): number;
  /** The seconds that the sessions of every direction ran in the 24 hours before `at`, open ones up to `at`. */
  warmSecondsInWindow(at: number): number;
  /** The sessions that ended from `from` (milliseconds) on, summed per UTC day, newest day first. */
  summary(from: number, config: Pick<WarmupConfig, "gpuUsdPerHour" | "idleTimeoutSeconds">): WarmupDay[];
  /** Whether a session of the direction ran at `at`: then a job's wait for a worker is the warm-up's, not a cold start. */
  sessionAt(direction: ProofDirection, at: number): boolean;
}

/** The record over the backend database. */
export function createWarmupStore(storage: Storage): WarmupStore {
  const { database } = storage;
  return {
    lead(config) {
      const rows = database.prepare("SELECT seconds FROM warmup_observations ORDER BY id DESC LIMIT ?").all(config.leadObservations) as Array<{ seconds: number }>;
      return leadFrom(
        rows.map((row) => row.seconds),
        config,
      );
    },
    recordObservation(input) {
      database
        .prepare("INSERT INTO warmup_observations (direction, source, seconds, observed_at) VALUES (?, ?, ?, ?)")
        .run(input.direction, input.source, input.seconds, input.at);
      database.prepare("DELETE FROM warmup_observations WHERE id <= (SELECT MAX(id) FROM warmup_observations) - ?").run(OBSERVATIONS_KEPT);
    },
    openSession(input) {
      const id = randomUUID();
      database
        .prepare("INSERT INTO warmup_sessions (id, direction, why, due_at, lead_seconds, started_at, prediction) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, input.direction, input.why, input.dueAt, input.leadSeconds, input.at, input.prediction ?? null);
      database.prepare("DELETE FROM warmup_sessions WHERE ended_at IS NOT NULL AND ended_at < ?").run(input.at - SESSION_RETENTION_MILLISECONDS);
      return id;
    },
    predictionStarted(direction, prediction) {
      return (
        database
          .prepare("SELECT 1 FROM warmup_sessions WHERE direction = ? AND prediction = ? AND COALESCE(outcome, '') NOT IN ('unusable', 'restart') LIMIT 1")
          .get(direction, prediction) !== undefined
      );
    },
    markReady(id, at) {
      database.prepare("UPDATE warmup_sessions SET ready_at = ? WHERE id = ? AND ready_at IS NULL").run(at, id);
    },
    endSession(id, outcome, at, idleTimeoutSeconds) {
      database
        .prepare("UPDATE warmup_sessions SET ended_at = ?, outcome = ?, billed_seconds = (? - started_at) / 1000.0 + ? WHERE id = ? AND ended_at IS NULL")
        .run(at, outcome, at, idleTimeoutSeconds, id);
    },
    closeOpenSessions(at) {
      return Number(database.prepare("UPDATE warmup_sessions SET ended_at = ?, outcome = 'restart', billed_seconds = (? - started_at) / 1000.0 WHERE ended_at IS NULL").run(at, at).changes);
    },
    summary(from, config) {
      // A session from before the billed time was recorded is estimated the same way from its own times.
      const rows = database
        .prepare(
          `SELECT strftime('%Y-%m-%d', started_at / 1000, 'unixepoch') AS day,
                  COUNT(*) AS sessions,
                  SUM(outcome = 'used') AS used,
                  SUM(outcome <> 'used') AS wasted,
                  SUM(COALESCE(billed_seconds, (ended_at - started_at) / 1000.0 + ?)) AS billed,
                  SUM(CASE WHEN outcome <> 'used' THEN COALESCE(billed_seconds, (ended_at - started_at) / 1000.0 + ?) ELSE 0 END) AS wastedBilled,
                  SUM(CASE WHEN outcome = 'used' AND ready_at IS NOT NULL THEN MAX(0, due_at - ready_at) / 1000.0 ELSE 0 END) AS idle
             FROM warmup_sessions WHERE ended_at IS NOT NULL AND started_at >= ? GROUP BY day ORDER BY day DESC`,
        )
        .all(config.idleTimeoutSeconds, config.idleTimeoutSeconds, from) as Array<{ day: string; sessions: number; used: number; wasted: number; billed: number; wastedBilled: number; idle: number }>;
      const round = (value: number) => Math.round(value * 100) / 100;
      return rows.map((row) => ({
        day: row.day,
        sessions: row.sessions,
        used: row.used,
        wasted: row.wasted,
        billedSeconds: round(row.billed),
        wastedSeconds: round(row.wastedBilled),
        idleBeforeDueSeconds: round(row.idle),
        estimatedCostUsd: Math.round((row.billed / 3600) * config.gpuUsdPerHour * 10_000) / 10_000,
        wastedCostUsd: Math.round((row.wastedBilled / 3600) * config.gpuUsdPerHour * 10_000) / 10_000,
      }));
    },
    warmSecondsInWindow(at) {
      const from = at - CAP_WINDOW_MILLISECONDS;
      const row = database
        .prepare(
          `SELECT COALESCE(SUM(MAX(0, MIN(COALESCE(ended_at, ?), ?) - MAX(started_at, ?))), 0) AS total
             FROM warmup_sessions WHERE COALESCE(ended_at, ?) > ?`,
        )
        .get(at, at, from, at, from) as { total: number };
      return row.total / 1000;
    },
    sessionAt(direction, at) {
      return database.prepare("SELECT 1 FROM warmup_sessions WHERE direction = ? AND started_at <= ? AND (ended_at IS NULL OR ended_at >= ?) LIMIT 1").get(direction, at, at) !== undefined;
    },
  };
}

/** What a finished proof said about the worker it met. */
export type JobWorkerWait =
  | { readonly kind: "unknown" }
  | { readonly kind: "warm" }
  /** The job met a cold worker while no warm-up ran: a cold start, kept as an observation. */
  | { readonly kind: "cold"; readonly seconds: number }
  /** The job met a cold worker although a warm-up ran: the warm-up was late or the worker left; not an observation. */
  | { readonly kind: "missed"; readonly seconds: number };

/**
 * Reads the prover's `prove_timing` of a finished job: a job that was answered "not ready" at least once (`not_ready_count`)
 * waited `wait_worker_ms` for a worker. Kept as an observation only when no warm-up session of the direction ran when
 * the job started: a running session measures the cold start with its own ping.
 */
export function noteJobWorkerWait(store: WarmupStore, input: { direction: ProofDirection; startedAt: number; timing: ProveTiming | null | undefined; at: number }): JobWorkerWait {
  const notReady = input.timing?.not_ready_count;
  const wait = input.timing?.wait_worker_ms;
  if (typeof notReady !== "number" || typeof wait !== "number") return { kind: "unknown" };
  if (notReady === 0) return { kind: "warm" };
  const seconds = wait / 1000;
  if (store.sessionAt(input.direction, input.startedAt)) return { kind: "missed", seconds };
  store.recordObservation({ direction: input.direction, source: "job", seconds, at: input.at });
  return { kind: "cold", seconds };
}
