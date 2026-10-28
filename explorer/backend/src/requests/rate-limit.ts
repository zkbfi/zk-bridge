import type { Job } from "./jobs.ts";

/** The limits on the request service. Every number comes from the configuration file. */
export type RateLimits = {
  /** How many requests one caller may make in one minute. */
  readonly requestsPerCallerPerMinute: number;
  /** The seconds between the start of two jobs for one direction. */
  readonly secondsBetweenJobsPerDirection: number;
  /** The seconds after a failed job before the next request may start a new job. */
  readonly secondsBeforeRetryAfterFailure: number;
};

/** The limits that the example configuration shows. */
export const DEFAULT_RATE_LIMITS: RateLimits = {
  requestsPerCallerPerMinute: 10,
  secondsBetweenJobsPerDirection: 120,
  secondsBeforeRetryAfterFailure: 60,
};

const MINUTE_MILLISECONDS = 60_000;

/** The width of the window in which one caller is counted. */
export const CALLER_WINDOW_MILLISECONDS = MINUTE_MILLISECONDS;

/** Whole seconds until `readyAt`, never less than one. */
function secondsUntil(readyAt: number, now: number): number {
  return Math.max(1, Math.ceil((readyAt - now) / 1000));
}

/**
 * How long one caller must wait.
 *
 * @param recent The requests of the caller inside the window, and the time of the oldest one.
 * @returns Seconds to wait, or 0 when the caller may go on.
 */
export function callerWaitSeconds(input: { recent: { count: number; oldest: number | null }; now: number; limits: RateLimits }): number {
  const { recent, now, limits } = input;
  if (recent.count < limits.requestsPerCallerPerMinute || recent.oldest === null) return 0;
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
