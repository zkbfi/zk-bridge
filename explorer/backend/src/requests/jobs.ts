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

/** Why a request was made. */
export type RequestReason = "message" | "keep-alive" | "user";

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

/** Moves a job to a new status. A field left out keeps its value. */
export function updateJob(storage: Storage, id: string, change: JobChange, now: number): void {
  storage.database
    .prepare(
      `UPDATE jobs SET status = ?, updated_at = ?,
         start_slot = CASE WHEN ? THEN ? ELSE start_slot END,
         new_slot = CASE WHEN ? THEN ? ELSE new_slot END,
         error = CASE WHEN ? THEN ? ELSE error END
       WHERE id = ?`,
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

/** The time of the oldest request that the caller made since `since`, or null when it made none. */
export function oldestRequestSince(storage: Storage, caller: string, since: number): { count: number; oldest: number | null } {
  const row = storage.database
    .prepare("SELECT count(*) AS total, min(created_at) AS oldest FROM requests WHERE caller = ? AND created_at > ?")
    .get(caller, since) as { total: number; oldest: number | null };
  return { count: row.total, oldest: row.oldest };
}
