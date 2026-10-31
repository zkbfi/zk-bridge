import { describe, expect, it } from "vitest";
import { quantile, stepDurations, timingStats } from "../src/transfer-timing.js";

describe("transfer timing", () => {
  it("splits sent → delivered into Sent, Final and Proof ready by the finality window and the covering time", () => {
    // Sent at 1,000; final 768 s later at 1,768; covered at 2,000; delivered at 2,100.
    expect(stepDurations({ sentAt: 1_000, coveredAt: 2_000, deliveredAt: 2_100, finalitySeconds: 768 })).toEqual({ sent: 768, final: 232, ready: 100, total: 1_100 });
  });

  it("takes a delivery that posted its own proof as the moment the proof was ready", () => {
    expect(stepDurations({ sentAt: 1_000, coveredAt: null, deliveredAt: 2_100, finalitySeconds: 768 })).toEqual({ sent: 768, final: 332, ready: 0, total: 1_100 });
    // A covering time after the delivery counts as the delivery.
    expect(stepDurations({ sentAt: 1_000, coveredAt: 2_500, deliveredAt: 2_100, finalitySeconds: 768 })).toMatchObject({ final: 332, ready: 0 });
  });

  it("puts a message covered before its finality window ended (a head ahead of the window) at Sent only", () => {
    expect(stepDurations({ sentAt: 1_000, coveredAt: 1_500, deliveredAt: 1_600, finalitySeconds: 768 })).toEqual({ sent: 500, final: 0, ready: 100, total: 600 });
  });

  it("computes quantiles as percentile_cont does: linear between the closest ranks", () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([7], 0.9)).toBe(7);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.9)).toBe(91);
    expect(quantile([3, 1, 2], 0.5)).toBe(2);
  });

  it("gives count, average, median and p90", () => {
    const stats = timingStats([60, 120, 180, 600]);
    expect(stats).toMatchObject({ count: 4, avg: 240, median: 150 });
    expect(stats.p90).toBeCloseTo(474);
    expect(timingStats([])).toEqual({ count: 0, avg: null, median: null, p90: null });
  });
});
