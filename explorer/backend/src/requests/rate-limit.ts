import type { Job } from "./jobs.ts";

/** The limits on the request service. Every number comes from the configuration file. */
export type RateLimits = {
  /** How many requests one caller may make in one minute. */
  readonly requestsPerCallerPerMinute: number;
  /** How many requests all callers without a known address share in one minute. */
  readonly requestsPerUnknownCallerPerMinute: number;
  /**
   * How many distinct callers may make requests in one minute. A caller counts once however many requests it makes, and
   * a caller already counted in the minute is held only by its own limit. The name is kept for existing configurations.
   */
  readonly globalRequestsPerMinute: number;
  /** The hours that a request row stays in the database. */
  readonly requestRetentionHours: number;
  /** The seconds between the start of two jobs for one direction. */
  readonly secondsBetweenJobsPerDirection: number;
  /** The seconds after a failed job before the next request may start a new job. */
  readonly secondsBeforeRetryAfterFailure: number;
  /**
   * How many jobs that may pay for a proof one direction may start in one day. A job starts only when the chain indexer
   * shows a need, so this is a backstop: it bounds what the remote prover costs even when the indexer reports wrong
   * facts. A job that found the chain up to date paid nothing and does not count.
   */
  readonly jobsPerDirectionPerDay: number;
  /**
   * The age of the destination head, in seconds, after which a direction needs a proof even when no message waits. A
   * light client that falls a whole sync committee period behind (about 27 hours on Ethereum, 23 on PulseChain) can
   * never move again, so keep it well below that.
   */
  readonly keepAliveSeconds: number;
  /**
   * How long a proof we already have (on the board, stored by the webhook, or made by a job) may wait to land before it
   * no longer holds back a new proof. Until then, no job starts from the head that proof starts at: the runner posts
   * it, and the next proof starts from the head it makes. Owner, 2026-11-01: "you should also have deduplication logic
   * in place so that you are never re-proving some proof you already have".
   */
  readonly pendingProofStaleSeconds: number;
};

/** The limits that the example configuration shows. */
export const DEFAULT_RATE_LIMITS: RateLimits = {
  requestsPerCallerPerMinute: 10,
  requestsPerUnknownCallerPerMinute: 2,
  globalRequestsPerMinute: 120,
  requestRetentionHours: 24,
  secondsBetweenJobsPerDirection: 120,
  secondsBeforeRetryAfterFailure: 60,
  jobsPerDirectionPerDay: 96,
  keepAliveSeconds: 43_200,
  pendingProofStaleSeconds: 600,
};

const MINUTE_MILLISECONDS = 60_000;

/** The width of the window in which one caller is counted. */
export const CALLER_WINDOW_MILLISECONDS = MINUTE_MILLISECONDS;

/** The width of the window in which the jobs of a direction count toward the daily budget. */
export const JOB_BUDGET_WINDOW_MILLISECONDS = 24 * 60 * MINUTE_MILLISECONDS;

/**
 * How long a direction must wait before its daily job budget has room again.
 *
 * @param recent The jobs of the direction that count, inside the day, and the time of the oldest one.
 * @returns Seconds to wait, or 0 when a new job may start.
 */
export function jobBudgetWaitSeconds(input: { recent: { count: number; oldest: number | null }; now: number; limit: number }): number {
  const { recent, now, limit } = input;
  if (recent.count < limit || recent.oldest === null) return 0;
  return secondsUntil(recent.oldest + JOB_BUDGET_WINDOW_MILLISECONDS, now);
}

/** Whole seconds until `readyAt`, never less than one. */
function secondsUntil(readyAt: number, now: number): number {
  return Math.max(1, Math.ceil((readyAt - now) / 1000));
}

/**
 * How long a group of requests must wait. It serves the single caller, the shared unknown caller and all callers.
 *
 * @param recent The requests of the group inside the window, and the time of the oldest one.
 * @param limit The most requests the group may make in the window.
 * @returns Seconds to wait, or 0 when the group may go on.
 */
export function windowWaitSeconds(input: { recent: { count: number; oldest: number | null }; now: number; limit: number }): number {
  const { recent, now, limit } = input;
  if (recent.count < limit || recent.oldest === null) return 0;
  return secondsUntil(recent.oldest + CALLER_WINDOW_MILLISECONDS, now);
}

/**
 * How long a direction must wait before it may start a new job. A request that joins an active job never asks.
 *
 * @param latest The newest job of the direction, or null.
 * @returns Seconds to wait, or 0 when a new job may start.
 */
export function directionWaitSeconds(input: { latest: Job | null; now: number; limits: RateLimits }): number {
  const { latest, now, limits } = input;
  if (latest === null) return 0;
  // A failed job asks for the shorter retry wait; every other job asks for the spacing between jobs.
  const readyAt =
    latest.status === "failed"
      ? latest.updatedAt + limits.secondsBeforeRetryAfterFailure * 1000
      : latest.createdAt + limits.secondsBetweenJobsPerDirection * 1000;
  return readyAt <= now ? 0 : secondsUntil(readyAt, now);
}
