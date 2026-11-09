import { SLOTS_PER_EPOCH } from "@zk-bridge/shared";
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
  /**
   * Deprecated and ignored since 2026-11-07: one job per new finality and direction replaced the spacing between jobs
   * (owner: "yes to the job limit changes"). A file that still sets it loads, and the backend logs `config_deprecated`.
   */
  readonly secondsBetweenJobsPerDirection?: number;
  /** The seconds after a failed job before the next request may start a new job. */
  readonly secondsBeforeRetryAfterFailure: number;
  /**
   * How many jobs that may pay for a proof one direction may start in one day. The main rule is one job per new finality
   * of the source chain, so this is a backstop: it bounds what the remote prover costs even when a rule reports wrong
   * facts. A job that found the chain up to date paid nothing and does not count. Absent: the epochs per day of the
   * source chain ({@link epochsPerDay}: 225 on Ethereum and Sepolia, 270 on PulseChain), one job per finality.
   */
  readonly jobsPerDirectionPerDay?: number;
  /**
   * The GPU spend one direction may reach in 24 hours, in USD. Before a job starts, the spend of the direction's jobs in
   * the last 24 hours ({@link gpuSpendUsd}: their worker seconds at the measured rate) must be under it. A handoff or a
   * keep-alive of the age rule keeps the light client alive and goes past it, logged.
   */
  readonly gpuBudgetUsdPerDirectionPerDay: number;
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
  secondsBeforeRetryAfterFailure: 60,
  gpuBudgetUsdPerDirectionPerDay: 5,
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
 * How long a direction must wait after a failed job before it may start a new one. Any other job asks for no wait: the
 * next job waits for a new finality instead (`lastJobTargetSlot`). A request that joins an active job never asks.
 *
 * @param latest The newest job of the direction, or null.
 * @returns Seconds to wait, or 0 when a new job may start.
 */
export function directionWaitSeconds(input: { latest: Job | null; now: number; limits: RateLimits }): number {
  const { latest, now, limits } = input;
  if (latest === null || latest.status !== "failed") return 0;
  const readyAt = latest.updatedAt + limits.secondsBeforeRetryAfterFailure * 1000;
  return readyAt <= now ? 0 : secondsUntil(readyAt, now);
}

/** The finalities a chain makes in a day: one per epoch (225 with 12 s slots, 270 with 10 s slots). */
export function epochsPerDay(secondsPerSlot: number): number {
  return Math.floor(86_400 / (SLOTS_PER_EPOCH * secondsPerSlot));
}

/** One job that ran on the GPU: when its proof came back (ms since 1970) and the worker seconds it paid for. */
export type SpentJob = { readonly provedAt: number; readonly seconds: number };

/** What jobs cost at a rate, in USD. */
export function gpuSpendUsd(jobs: readonly SpentJob[], usdPerHour: number): number {
  return (jobs.reduce((sum, job) => sum + job.seconds, 0) / 3600) * usdPerHour;
}

/**
 * Whether the GPU budget of a direction is spent, and until when.
 *
 * @param input.jobs The direction's jobs proved in the last 24 hours.
 * @returns null while the spend is under the budget; else the spend and the seconds until enough of it leaves the window.
 */
export function gpuBudgetWait(input: { jobs: readonly SpentJob[]; usdPerHour: number; budgetUsd: number; now: number }): { readonly spentUsd: number; readonly retryAfterSeconds: number } | null {
  const spentUsd = gpuSpendUsd(input.jobs, input.usdPerHour);
  if (spentUsd < input.budgetUsd) return null;
  // The oldest jobs leave the window first: the wait ends when the spend left in it is under the budget.
  const oldestFirst = [...input.jobs].sort((left, right) => left.provedAt - right.provedAt);
  let left = spentUsd;
  let readyAt = input.now;
  for (const job of oldestFirst) {
    left -= gpuSpendUsd([job], input.usdPerHour);
    readyAt = job.provedAt + JOB_BUDGET_WINDOW_MILLISECONDS;
    if (left < input.budgetUsd) break;
  }
  return { spentUsd, retryAfterSeconds: secondsUntil(readyAt, input.now) };
}
