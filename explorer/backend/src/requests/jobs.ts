import type { ProofDirection } from "@zk-bridge/shared";
import type { Storage } from "../storage.ts";

/** The life of a job. `queued` and `proving` are the active states: at most one job per direction is active. */
export type JobStatus = "queued" | "proving" | "published" | "on-chain" | "failed";

/** The states in which a job still works. */
export const ACTIVE_STATUSES = ["queued", "proving"] as const satisfies readonly JobStatus[];

/** One proving job. Times are milliseconds since 1970. Slots are decimal text, because a slot is a 64 bit number. */
export type Job = {
  readonly id: string;
  readonly direction: ProofDirection;
  readonly status: JobStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startSlot: string | null;
  readonly newSlot: string | null;
  readonly error: string | null;
};

/** Why a request was made. `finality` is the backend's own: the watcher saw the finality that makes a proof due. */
export type RequestReason = "message" | "keep-alive" | "user" | "finality";

/** One stored request. */
export type StoredRequest = {
  readonly id: string;
  readonly jobId: string;
  readonly pair: string;
  readonly direction: ProofDirection;
  readonly reason: RequestReason;
  readonly messageId: string | null;
  readonly createdAt: number;
};

type JobRow = {
  id: string;
  direction: ProofDirection;
  status: JobStatus;
  created_at: number;
  updated_at: number;
  start_slot: string | null;
  new_slot: string | null;
  error: string | null;
};

type RequestRow = {
  id: string;
  job_id: string;
  pair: string;
  direction: ProofDirection;
  reason: RequestReason;
  message_id: string | null;
  created_at: number;
};

const ACTIVE_LIST = ACTIVE_STATUSES.map((status) => `'${status}'`).join(", ");

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    direction: row.direction,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startSlot: row.start_slot,
    newSlot: row.new_slot,
    error: row.error,
  };
}

/** The job with this identifier, or null. */
export function getJob(storage: Storage, id: string): Job | null {
  const row = storage.database.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
  return row === undefined ? null : toJob(row);
}

/** The queued or proving job of a direction, or null. */
export function findActiveJob(storage: Storage, direction: ProofDirection): Job | null {
  const row = storage.database.prepare(`SELECT * FROM jobs WHERE direction = ? AND status IN (${ACTIVE_LIST})`).get(direction) as JobRow | undefined;
  return row === undefined ? null : toJob(row);
}

/** The newest job of a direction, or null. */
export function findLatestJob(storage: Storage, direction: ProofDirection): Job | null {
  const row = storage.database.prepare("SELECT * FROM jobs WHERE direction = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(direction) as JobRow | undefined;
  return row === undefined ? null : toJob(row);
}

/**
 * The jobs of a direction made after `since` that may have paid for a proof, and the time of the oldest. A job that
 * found the chain up to date ended on chain without a proof and is left out.
 */
export function recentCostlyJobs(storage: Storage, direction: ProofDirection, since: number): { count: number; oldest: number | null } {
  const row = storage.database
    .prepare("SELECT count(*) AS total, min(created_at) AS oldest FROM jobs WHERE direction = ? AND created_at > ? AND NOT (status = 'on-chain' AND new_slot IS NULL)")
    .get(direction, since) as { total: number; oldest: number | null };
  return { count: row.total, oldest: row.oldest };
}

/** All active jobs, oldest first. */
export function listActiveJobs(storage: Storage): readonly Job[] {
  const rows = storage.database.prepare(`SELECT * FROM jobs WHERE status IN (${ACTIVE_LIST}) ORDER BY created_at, rowid`).all() as JobRow[];
  return rows.map(toJob);
}

/** The number of jobs that wait for the prover. */
export function countQueuedJobs(storage: Storage): number {
  const row = storage.database.prepare("SELECT count(*) AS total FROM jobs WHERE status = 'queued'").get() as { total: number };
  return row.total;
}

/** Stores a new queued job. */
export function insertJob(storage: Storage, input: { id: string; direction: ProofDirection; now: number }): Job {
  storage.database
    .prepare("INSERT INTO jobs (id, direction, status, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?)")
    .run(input.id, input.direction, input.now, input.now);
  return { id: input.id, direction: input.direction, status: "queued", createdAt: input.now, updatedAt: input.now, startSlot: null, newSlot: null, error: null };
}

/** The fields that a status change can set. */
export type JobChange = {
  readonly status: JobStatus;
  readonly startSlot?: string | null;
  readonly newSlot?: string | null;
  readonly error?: string | null;
};

/**
 * Moves a job to a new status, but only while it still has one of the `expected` statuses. A late writer, such as a
 * prover that ends after its job timed out, therefore cannot bring a finished job back. A field left out keeps its value.
 *
 * @returns True when the job changed.
 */
export function updateJob(storage: Storage, id: string, change: JobChange, now: number, expected: readonly JobStatus[]): boolean {
  const result = storage.database
    .prepare(
      `UPDATE jobs SET status = ?, updated_at = ?,
         start_slot = CASE WHEN ? THEN ? ELSE start_slot END,
         new_slot = CASE WHEN ? THEN ? ELSE new_slot END,
         error = CASE WHEN ? THEN ? ELSE error END
       WHERE id = ? AND status IN (${expected.map((status) => `'${status}'`).join(", ")})`,
    )
    .run(
      change.status,
      now,
      Number(change.startSlot !== undefined),
      change.startSlot ?? null,
      Number(change.newSlot !== undefined),
      change.newSlot ?? null,
      Number(change.error !== undefined),
      change.error ?? null,
      id,
    );
  return Number(result.changes) > 0;
}

/**
 * Marks a proving job as still alive without changing anything else. The publisher calls it on each attempt to post the
 * proof of the job, so the check for lost jobs (`prover.timeoutSeconds` after the last change) does not fail a job whose
 * paid proof only waits for a slow board. A job in any other status stays as it is.
 */
export function touchProvingJob(storage: Storage, id: string, now: number): void {
  storage.database.prepare("UPDATE jobs SET updated_at = ? WHERE id = ? AND status = 'proving'").run(now, id);
}

/** Stores one request. */
export function insertRequest(
  storage: Storage,
  input: { id: string; jobId: string; pair: string; direction: ProofDirection; reason: RequestReason; messageId: string | null; caller: string; now: number },
): void {
  storage.database
    .prepare("INSERT INTO requests (id, job_id, pair, direction, reason, message_id, caller, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(input.id, input.jobId, input.pair, input.direction, input.reason, input.messageId, input.caller, input.now);
}

/** The request with this identifier, or null. */
export function getRequest(storage: Storage, id: string): StoredRequest | null {
  const row = storage.database.prepare("SELECT * FROM requests WHERE id = ?").get(id) as RequestRow | undefined;
  if (row === undefined) return null;
  return { id: row.id, jobId: row.job_id, pair: row.pair, direction: row.direction, reason: row.reason, messageId: row.message_id, createdAt: row.created_at };
}

/** How many requests the caller made since `since`, and the time of the oldest one. */
export function recentRequestsOfCaller(storage: Storage, caller: string, since: number): { count: number; oldest: number | null } {
  const row = storage.database
    .prepare("SELECT count(*) AS total, min(created_at) AS oldest FROM requests WHERE caller = ? AND created_at > ?")
    .get(caller, since) as { total: number; oldest: number | null };
  return { count: row.total, oldest: row.oldest };
}

/**
 * How many distinct callers made a request since `since`, and the earliest time at which one of them leaves the window:
 * the oldest of their newest requests. A caller counts once, however many requests it made, so a few busy callers
 * cannot fill a limit that all callers share.
 */
export function recentCallersOfAll(storage: Storage, since: number): { count: number; oldest: number | null } {
  const row = storage.database
    .prepare("SELECT count(*) AS total, min(newest) AS oldest FROM (SELECT max(created_at) AS newest FROM requests WHERE created_at > ? GROUP BY caller)")
    .get(since) as { total: number; oldest: number | null };
  return { count: row.total, oldest: row.oldest };
}

/**
 * Deletes the request rows made before `before`, except the rows of a job that is still queued or proving: a caller
 * still waits on those. Jobs stay. Returns how many rows went.
 */
export function pruneRequests(storage: Storage, before: number): number {
  const result = storage.database
    .prepare(`DELETE FROM requests WHERE created_at < ? AND job_id NOT IN (SELECT id FROM jobs WHERE status IN (${ACTIVE_LIST}))`)
    .run(before);
  return Number(result.changes);
}
