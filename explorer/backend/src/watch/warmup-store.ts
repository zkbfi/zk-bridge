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

/** The warm-up record. Times in milliseconds since 1970. */
export interface WarmupStore {
  /** The lead time from the newest observations of every direction (one endpoint serves both). */
  lead(config: WarmupConfig): Lead;
  recordObservation(input: { direction: ProofDirection; source: ObservationSource; seconds: number; at: number }): void;
  /** Opens a session and answers its identifier. */
  openSession(input: { direction: ProofDirection; why: string; dueAt: number; leadSeconds: number; at: number }): string;
  markReady(id: string, at: number): void;
  endSession(id: string, outcome: SessionOutcome, at: number): void;
  /** Ends every open session as `restart`, at `at`. A running backend has none open from before its start. */
  closeOpenSessions(at: number): number;
  /** The seconds that the sessions of every direction ran in the 24 hours before `at`, open ones up to `at`. */
  warmSecondsInWindow(at: number): number;
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
        .prepare("INSERT INTO warmup_sessions (id, direction, why, due_at, lead_seconds, started_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, input.direction, input.why, input.dueAt, input.leadSeconds, input.at);
      database.prepare("DELETE FROM warmup_sessions WHERE ended_at IS NOT NULL AND ended_at < ?").run(input.at - SESSION_RETENTION_MILLISECONDS);
      return id;
    },
    markReady(id, at) {
      database.prepare("UPDATE warmup_sessions SET ready_at = ? WHERE id = ? AND ready_at IS NULL").run(at, id);
    },
    endSession(id, outcome, at) {
      database.prepare("UPDATE warmup_sessions SET ended_at = ?, outcome = ? WHERE id = ? AND ended_at IS NULL").run(at, outcome, id);
    },
    closeOpenSessions(at) {
      return Number(database.prepare("UPDATE warmup_sessions SET ended_at = ?, outcome = 'restart' WHERE ended_at IS NULL").run(at).changes);
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
