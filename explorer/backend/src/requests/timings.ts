/**
 * The timings of each proof, kept in `job_timings`. Owner, 2026-11-01: "i look forward to seeing actual timing from
 * bridges and proofs being generated."
 *
 * Two writers fill one row per job: the request service when the prover returns (its `prove_timing` fields, see
 * docs/gpu-prover.md), and the webhook publisher when the board took the proof (when the webhook stored it, when it was
 * posted, and how long the proof of work took). Either may come first, so both write with an upsert.
 */
import type { ProofDirection } from "@zk-bridge/shared";
import type { ProveTiming } from "@zk-bridge/shared/prover";
import type { JobRecord } from "../billing-breakdown.ts";
import type { Storage } from "../storage.ts";

/** Rows older than this many milliseconds are deleted when a new one is written. */
export const TIMING_RETENTION_MILLISECONDS = 30 * 24 * 3_600_000;

/** The `_ms` and `_count` fields of `prove_timing` that the table keeps, by column. */
const NUMBER_COLUMNS = [
  "wait_worker_ms",
  "not_ready_count",
  "retry_count",
  "failover_count",
  "remote_ms",
  "prove_ms",
  "total_ms",
  "worker_queue_ms",
  "worker_prove_ms",
  "worker_total_ms",
  "remote_overhead_ms",
] as const;

/** The timings of one job. Times are milliseconds since 1970; durations are milliseconds. Null when not reported. */
export type JobTiming = {
  readonly jobId: string;
  readonly direction: ProofDirection;
  readonly startedAt: number | null;
  readonly provedAt: number | null;
  readonly waitWorkerMs: number | null;
  readonly notReadyCount: number | null;
  readonly retryCount: number | null;
  readonly failoverCount: number | null;
  readonly remoteMs: number | null;
  readonly proveMs: number | null;
  readonly totalMs: number | null;
  readonly workerQueueMs: number | null;
  readonly workerProveMs: number | null;
  readonly workerTotalMs: number | null;
  readonly remoteOverheadMs: number | null;
  /** The label of the endpoint that gave the proof (never its address). */
  readonly endpoint: string | null;
  readonly workerGpu: string | null;
  readonly webhookStoredAt: number | null;
  readonly boardPostedAt: number | null;
  readonly grindMs: number | null;
};

type TimingRow = {
  job_id: string;
  direction: ProofDirection;
  started_at: number | null;
  proved_at: number | null;
  wait_worker_ms: number | null;
  not_ready_count: number | null;
  retry_count: number | null;
  failover_count: number | null;
  remote_ms: number | null;
  prove_ms: number | null;
  total_ms: number | null;
  worker_queue_ms: number | null;
  worker_prove_ms: number | null;
  worker_total_ms: number | null;
  remote_overhead_ms: number | null;
  endpoint: string | null;
  worker_gpu: string | null;
  webhook_stored_at: number | null;
  board_posted_at: number | null;
  grind_ms: number | null;
};

function toTiming(row: TimingRow): JobTiming {
  return {
    jobId: row.job_id,
    direction: row.direction,
    startedAt: row.started_at,
    provedAt: row.proved_at,
    waitWorkerMs: row.wait_worker_ms,
    notReadyCount: row.not_ready_count,
    retryCount: row.retry_count,
    failoverCount: row.failover_count,
    remoteMs: row.remote_ms,
    proveMs: row.prove_ms,
    totalMs: row.total_ms,
    workerQueueMs: row.worker_queue_ms,
    workerProveMs: row.worker_prove_ms,
    workerTotalMs: row.worker_total_ms,
    remoteOverheadMs: row.remote_overhead_ms,
    endpoint: row.endpoint,
    workerGpu: row.worker_gpu,
    webhookStoredAt: row.webhook_stored_at,
    boardPostedAt: row.board_posted_at,
    grindMs: row.grind_ms,
  };
}

/** A whole, non-negative number of the timing, or null. */
function wholeNumber(timing: ProveTiming | null, key: string): number | null {
  const value = timing?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** The endpoint label, only in the form the configuration allows (`remote.endpoints[].label`), so no address slips out. */
function labelOf(timing: ProveTiming | null): string | null {
  const value = timing?.endpoint;
  return typeof value === "string" && /^[a-z0-9_-]{1,32}$/.test(value) ? value : null;
}

/** The GPU name, printable and at most 80 characters; a value that looks like an address is dropped. */
function gpuOf(timing: ProveTiming | null): string | null {
  const value = timing?.worker_gpu;
  if (typeof value !== "string") return null;
  const clean = value.replace(/[^\x20-\x7e]/g, "").trim().slice(0, 80);
  return clean === "" || /:\/\/|@/.test(clean) ? null : clean;
}

/** Ensures the row of a job and deletes the rows past the retention. */
function ensureRow(storage: Storage, jobId: string, direction: ProofDirection, at: number): void {
  storage.database.prepare("INSERT OR IGNORE INTO job_timings (job_id, direction) VALUES (?, ?)").run(jobId, direction);
  storage.database.prepare("DELETE FROM job_timings WHERE COALESCE(proved_at, board_posted_at) < ?").run(at - TIMING_RETENTION_MILLISECONDS);
}

/**
 * Keeps what the prover reported for a job that made a proof. `timing` is null from an older prover; the row then holds
 * the start and the end alone.
 */
export function recordProveTiming(storage: Storage, input: { jobId: string; direction: ProofDirection; startedAt: number; provedAt: number; timing: ProveTiming | null }): void {
  ensureRow(storage, input.jobId, input.direction, input.provedAt);
  const values = NUMBER_COLUMNS.map((column) => wholeNumber(input.timing, column));
  storage.database
    .prepare(`UPDATE job_timings SET started_at = ?, proved_at = ?, ${NUMBER_COLUMNS.map((column) => `${column} = ?`).join(", ")}, endpoint = ?, worker_gpu = ? WHERE job_id = ?`)
    .run(input.startedAt, input.provedAt, ...values, labelOf(input.timing), gpuOf(input.timing), input.jobId);
}

/** Keeps when the webhook stored the proof of a job, when the board took it, and how long the proof of work took. */
export function recordBoardPost(storage: Storage, input: { jobId: string; direction: ProofDirection; storedAt: number; postedAt: number; grindMs: number | null }): void {
  ensureRow(storage, input.jobId, input.direction, input.postedAt);
  const grind = input.grindMs !== null && Number.isFinite(input.grindMs) && input.grindMs >= 0 ? Math.round(input.grindMs) : null;
  storage.database.prepare("UPDATE job_timings SET webhook_stored_at = ?, board_posted_at = ?, grind_ms = ? WHERE job_id = ?").run(input.storedAt, input.postedAt, grind, input.jobId);
}

/** The timings of one job, or null. */
export function getTiming(storage: Storage, jobId: string): JobTiming | null {
  const row = storage.database.prepare("SELECT * FROM job_timings WHERE job_id = ?").get(jobId) as TimingRow | undefined;
  return row === undefined ? null : toTiming(row);
}

/** The timings of the jobs proved or posted at or after `since`, newest first. */
export function listTimings(storage: Storage, since: number): JobTiming[] {
  const rows = storage.database
    .prepare("SELECT * FROM job_timings WHERE COALESCE(proved_at, board_posted_at) >= ? ORDER BY COALESCE(proved_at, board_posted_at) DESC, rowid DESC")
    .all(since) as TimingRow[];
  return rows.map(toTiming);
}

/** The newest `limit` timings, newest first, whatever their age: the estimates of a running job read them. */
export function recentTimings(storage: Storage, limit: number): JobTiming[] {
  const rows = storage.database.prepare("SELECT * FROM job_timings ORDER BY COALESCE(proved_at, board_posted_at) DESC, rowid DESC LIMIT ?").all(limit) as TimingRow[];
  return rows.map(toTiming);
}

/** The median, the 90th percentile and the count of some durations, in milliseconds. Null quantiles when empty. */
export type Stat = { readonly count: number; readonly medianMs: number | null; readonly p90Ms: number | null };

/** The nearest-rank quantile `p` (0 to 1) of sorted values. */
function quantile(sorted: readonly number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] as number;
}

/** The stat of the values that are numbers; nulls are left out. */
export function statOf(values: ReadonlyArray<number | null>): Stat {
  const sorted = values.filter((value): value is number => value !== null).sort((left, right) => left - right);
  if (sorted.length === 0) return { count: 0, medianMs: null, p90Ms: null };
  return { count: sorted.length, medianMs: Math.round(quantile(sorted, 0.5)), p90Ms: Math.round(quantile(sorted, 0.9)) };
}

/** The jobs proved from `from` (milliseconds) on, oldest first, with the fields that the billing breakdown reads. */
export function provedJobsSince(storage: Storage, from: number): JobRecord[] {
  const rows = storage.database
    .prepare("SELECT started_at, proved_at, wait_worker_ms, not_ready_count, remote_ms, worker_total_ms FROM job_timings WHERE proved_at IS NOT NULL AND proved_at >= ? ORDER BY proved_at")
    .all(from) as Array<{ started_at: number | null; proved_at: number; wait_worker_ms: number | null; not_ready_count: number | null; remote_ms: number | null; worker_total_ms: number | null }>;
  return rows.map((row) => ({ startedAt: row.started_at, provedAt: row.proved_at, waitWorkerMs: row.wait_worker_ms, notReadyCount: row.not_ready_count, remoteMs: row.remote_ms, workerTotalMs: row.worker_total_ms }));
}
