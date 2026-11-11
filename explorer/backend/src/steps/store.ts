/**
 * The step jobs that no other table holds: the proof of the fork registry's own light client (GPU), the opening proof of a
 * bridge and the evidence build of a delivery (no GPU). One row per job in `step_jobs`; `step_requests` counts the
 * callers of `POST /steps/requests` toward the same per-caller limits as `POST /requests`. The tables are in
 * `storage.ts`. A light client update is a job
 * of `jobs`, and a fork observation a row of `fork_observations`: those tables keep them.
 */
import type { Storage } from "../storage.ts";

/** The kinds a step job row holds. */
export type StepJobKind = "registry-light-client-update" | "open-deposits" | "layout-rows" | "deliver";

/** The statuses of a row. */
export type StepRowStatus = "running" | "done" | "failed";

/** One row. `result` is the finished proof as JSON; `startSlot` the head it proves from (registry), when known. */
export type StepRow = {
  readonly id: string;
  readonly kind: StepJobKind;
  readonly subject: string;
  readonly status: StepRowStatus;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly startSlot: number | null;
  readonly result: string | null;
  readonly error: string | null;
};

type Row = { id: string; kind: StepJobKind; subject: string; status: StepRowStatus; started_at: number; updated_at: number; start_slot: number | null; result: string | null; error: string | null };

const toRow = (row: Row): StepRow => ({
  id: row.id,
  kind: row.kind,
  subject: row.subject,
  status: row.status,
  startedAt: row.started_at,
  updatedAt: row.updated_at,
  startSlot: row.start_slot,
  result: row.result,
  error: row.error,
});

/** Starts a job. Throws when a job of the same kind and subject runs (the unique index). */
export function insertStepJob(storage: Storage, input: { id: string; kind: StepJobKind; subject: string; at: number; startSlot: number | null }): void {
  storage.database.prepare("INSERT INTO step_jobs (id, kind, subject, status, started_at, updated_at, start_slot) VALUES (?, ?, ?, 'running', ?, ?, ?)")
    .run(input.id, input.kind, input.subject, input.at, input.at, input.startSlot);
}

/** Ends a job with its proof, or with a reason that is safe to show. */
export function finishStepJob(storage: Storage, input: { id: string; at: number } & ({ result: string } | { error: string })): void {
  const statement = storage.database.prepare("UPDATE step_jobs SET status = ?, updated_at = ?, result = ?, error = ? WHERE id = ?");
  if ("result" in input) statement.run("done", input.at, input.result, null, input.id);
  else statement.run("failed", input.at, null, input.error, input.id);
}

/** One job by id, or null. */
export function getStepJob(storage: Storage, id: string): StepRow | null {
  const row = storage.database.prepare("SELECT * FROM step_jobs WHERE id = ?").get(id) as Row | undefined;
  return row === undefined ? null : toRow(row);
}

/** The newest job of a kind and subject, whatever its status, or null. */
export function latestStepJob(storage: Storage, kind: StepJobKind, subject: string): StepRow | null {
  const row = storage.database.prepare("SELECT * FROM step_jobs WHERE kind = ? AND subject = ? ORDER BY started_at DESC, rowid DESC LIMIT 1").get(kind, subject) as Row | undefined;
  return row === undefined ? null : toRow(row);
}

/** The newest finished job of a kind and subject, or null. */
export function latestDoneStepJob(storage: Storage, kind: StepJobKind, subject: string): StepRow | null {
  const row = storage.database.prepare("SELECT * FROM step_jobs WHERE kind = ? AND subject = ? AND status = 'done' ORDER BY updated_at DESC, rowid DESC LIMIT 1")
    .get(kind, subject) as Row | undefined;
  return row === undefined ? null : toRow(row);
}

/**
 * Fails the jobs that ran longer than `timeoutMilliseconds` (a restart left them, or the prover hung): a running row
 * that nobody finishes would hold its subject for good.
 */
export function failLostStepJobs(storage: Storage, now: number, timeoutMilliseconds: number): void {
  storage.database.prepare("UPDATE step_jobs SET status = 'failed', updated_at = ?, error = 'the job ran longer than its limit' WHERE status = 'running' AND started_at < ?")
    .run(now, now - timeoutMilliseconds);
}

/** Notes a request of a caller that started or joined a job. */
export function insertStepRequest(storage: Storage, input: { id: string; jobId: string; caller: string; at: number }): void {
  storage.database.prepare("INSERT INTO step_requests (id, job_id, caller, created_at) VALUES (?, ?, ?, ?)").run(input.id, input.jobId, input.caller, input.at);
}

/** How many step requests the caller made since `since`, and the time of the oldest one. */
export function recentStepRequestsOfCaller(storage: Storage, caller: string, since: number): { count: number; oldest: number | null } {
  const row = storage.database.prepare("SELECT count(*) AS total, min(created_at) AS oldest FROM step_requests WHERE caller = ? AND created_at > ?").get(caller, since) as {
    total: number;
    oldest: number | null;
  };
  return { count: row.total, oldest: row.oldest };
}

/** Deletes the request rows made before `before`. Returns how many went. */
export function pruneStepRequests(storage: Storage, before: number): number {
  return Number(storage.database.prepare("DELETE FROM step_requests WHERE created_at < ?").run(before).changes);
}
