import { describe, expect, it } from "vitest";
import type { Job } from "../src/requests/jobs.ts";
import { DEFAULT_RATE_LIMITS, callerWaitSeconds, directionWaitSeconds } from "../src/requests/rate-limit.ts";

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
  it("uses 10 requests a minute, 120 seconds between jobs and 60 seconds after a failure by default", () => {
    expect(DEFAULT_RATE_LIMITS).toEqual({ requestsPerCallerPerMinute: 10, secondsBetweenJobsPerDirection: 120, secondsBeforeRetryAfterFailure: 60 });
  });

  it("lets a caller below the limit go on and makes one at the limit wait for its oldest request to leave the window", () => {
    expect(callerWaitSeconds({ recent: { count: 9, oldest: 0 }, now: 10_000, limits: DEFAULT_RATE_LIMITS })).toBe(0);
    expect(callerWaitSeconds({ recent: { count: 10, oldest: 0 }, now: 10_000, limits: DEFAULT_RATE_LIMITS })).toBe(50);
    expect(callerWaitSeconds({ recent: { count: 10, oldest: null }, now: 10_000, limits: DEFAULT_RATE_LIMITS })).toBe(0);
  });

  it("never asks for less than one second", () => {
    expect(callerWaitSeconds({ recent: { count: 10, oldest: 0 }, now: 59_999, limits: DEFAULT_RATE_LIMITS })).toBe(1);
  });

  it("spaces jobs by 120 seconds and failed jobs by 60 seconds from the failure", () => {
    const limits = DEFAULT_RATE_LIMITS;
    expect(directionWaitSeconds({ latest: null, now: 0, limits })).toBe(0);
    expect(directionWaitSeconds({ latest: job({ createdAt: 0 }), now: 100_000, limits })).toBe(20);
    expect(directionWaitSeconds({ latest: job({ createdAt: 0 }), now: 120_000, limits })).toBe(0);
    expect(directionWaitSeconds({ latest: job({ status: "failed", createdAt: 0, updatedAt: 10_000 }), now: 30_000, limits })).toBe(40);
    expect(directionWaitSeconds({ latest: job({ status: "failed", createdAt: 0, updatedAt: 10_000 }), now: 70_000, limits })).toBe(0);
  });
});
