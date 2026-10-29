import type { Job } from "./jobs.ts";

/** The limits on the request service. Every number comes from the configuration file. */
export type RateLimits = {
  /** How many requests one caller may make in one minute. */
  readonly requestsPerCallerPerMinute: number;
  /** How many requests all callers without a known address share in one minute. */
  readonly requestsPerUnknownCallerPerMinute: number;
  /** How many requests all callers together may make in one minute. */
  readonly globalRequestsPerMinute: number;
  /** The hours that a request row stays in the database. */
  readonly requestRetentionHours: number;
  /** The seconds between the start of two jobs for one direction. */
  readonly secondsBetweenJobsPerDirection: number;
  /** The seconds after a failed job before the next request may start a new job. */
  readonly secondsBeforeRetryAfterFailure: number;
  /**
   * How many jobs that may pay for a proof one direction may start in one day. Any caller can ask for a job, so this
   * bounds what the remote prover costs. A job that found the chain up to date paid nothing and does not count.
   */
  readonly jobsPerDirectionPerDay: number;
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
