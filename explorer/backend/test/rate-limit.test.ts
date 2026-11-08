import { describe, expect, it } from "vitest";
import type { Job } from "../src/requests/jobs.ts";
import { DEFAULT_RATE_LIMITS, directionWaitSeconds, epochsPerDay, gpuBudgetWait, gpuSpendUsd, windowWaitSeconds } from "../src/requests/rate-limit.ts";

const job = (overrides: Partial<Job>): Job => ({
  id: "j",
  direction: "first-to-second",
  status: "on-chain",
  createdAt: 0,
  updatedAt: 0,
  startSlot: null,
  newSlot: null,
  error: null,
  ...overrides,
});

describe("rate limit arithmetic", () => {
  it("uses 10 requests a minute, 60 seconds after a failure, a $5 GPU budget per direction and day by default, and a 12 hour keep-alive", () => {
    // No spacing between jobs and no fixed daily count: one job per new finality, and the epochs of a day as the backstop.
    expect(DEFAULT_RATE_LIMITS).toEqual({ requestsPerCallerPerMinute: 10, requestsPerUnknownCallerPerMinute: 2, globalRequestsPerMinute: 120, requestRetentionHours: 24, secondsBeforeRetryAfterFailure: 60, gpuBudgetUsdPerDirectionPerDay: 5, keepAliveSeconds: 43_200, pendingProofStaleSeconds: 600 });
  });

  it("counts the finalities of a day: one per epoch", () => {
    expect(epochsPerDay(12)).toBe(225);
    expect(epochsPerDay(10)).toBe(270);
  });

  it("prices jobs at the rate, and waits until enough of the spend leaves the 24 h window", () => {
    const hour = 3_600_000;
    // Two hours of worker time at $2.25 an hour: $4.50, under a $5 budget.
    expect(gpuSpendUsd([{ provedAt: 0, seconds: 3600 }, { provedAt: hour, seconds: 3600 }], 2.25)).toBe(4.5);
    expect(gpuBudgetWait({ jobs: [{ provedAt: 0, seconds: 7200 }], usdPerHour: 2.25, budgetUsd: 5, now: hour })).toBeNull();
    // $6.75 spent in three jobs: the oldest leaving at 24 h brings it to $4.50, under the budget.
    const jobs = [{ provedAt: 2 * hour, seconds: 3600 }, { provedAt: 0, seconds: 3600 }, { provedAt: hour, seconds: 3600 }];
    expect(gpuBudgetWait({ jobs, usdPerHour: 2.25, budgetUsd: 5, now: 3 * hour })).toEqual({ spentUsd: 6.75, retryAfterSeconds: 21 * 3600 });
    // A budget of 0 is spent with no job: the wait is the minimum of one second.
    expect(gpuBudgetWait({ jobs: [], usdPerHour: 2.25, budgetUsd: 0, now: 0 })).toEqual({ spentUsd: 0, retryAfterSeconds: 1 });
    // Every job must leave before a budget of 1 cent is free again.
    expect(gpuBudgetWait({ jobs: [{ provedAt: 0, seconds: 3600 }, { provedAt: hour, seconds: 3600 }], usdPerHour: 2.25, budgetUsd: 0.01, now: 2 * hour })).toEqual({ spentUsd: 4.5, retryAfterSeconds: 23 * 3600 });
  });

  it("lets a caller below the limit go on and makes one at the limit wait for its oldest request to leave the window", () => {
    expect(windowWaitSeconds({ recent: { count: 9, oldest: 0 }, now: 10_000, limit: 10 })).toBe(0);
    expect(windowWaitSeconds({ recent: { count: 10, oldest: 0 }, now: 10_000, limit: 10 })).toBe(50);
    expect(windowWaitSeconds({ recent: { count: 10, oldest: null }, now: 10_000, limit: 10 })).toBe(0);
  });

  it("never asks for less than one second", () => {
    expect(windowWaitSeconds({ recent: { count: 10, oldest: 0 }, now: 59_999, limit: 10 })).toBe(1);
  });

  it("spaces only failed jobs, by 60 seconds from the failure: any other job waits for a new finality instead", () => {
    const limits = DEFAULT_RATE_LIMITS;
    expect(directionWaitSeconds({ latest: null, now: 0, limits })).toBe(0);
    expect(directionWaitSeconds({ latest: job({ createdAt: 0 }), now: 1_000, limits })).toBe(0);
    expect(directionWaitSeconds({ latest: job({ status: "failed", createdAt: 0, updatedAt: 10_000 }), now: 30_000, limits })).toBe(40);
    expect(directionWaitSeconds({ latest: job({ status: "failed", createdAt: 0, updatedAt: 10_000 }), now: 70_000, limits })).toBe(0);
  });
});
