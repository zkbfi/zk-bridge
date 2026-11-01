import { describe, expect, it } from "vitest";
import { openStorage } from "../src/storage.ts";
import { getTiming, listTimings, recentTimings, recordBoardPost, recordProveTiming, statOf, TIMING_RETENTION_MILLISECONDS } from "../src/requests/timings.ts";

const DAY = 86_400_000;

describe("the timings of each proof (2026-11-01)", () => {
  it("keeps the prover's numbers and the board post in one row, whichever comes first", () => {
    const storage = openStorage(":memory:");
    recordBoardPost(storage, { jobId: "a", direction: "first-to-second", storedAt: 1_000, postedAt: 5_000, grindMs: 3_999.6 });
    recordProveTiming(storage, {
      jobId: "a",
      direction: "first-to-second",
      startedAt: 100,
      provedAt: 900,
      timing: {
        wait_worker_ms: 10,
        not_ready_count: 1,
        retry_count: 0,
        failover_count: 1,
        remote_ms: 20,
        prove_ms: 30,
        total_ms: 40,
        worker_queue_ms: 5,
        worker_prove_ms: 15,
        worker_total_ms: 18,
        remote_overhead_ms: 2,
        endpoint: "dedicated",
        worker_gpu: "NVIDIA GeForce RTX 4090",
        worker_timings: "reported",
      },
    });
    expect(getTiming(storage, "a")).toEqual({
      jobId: "a",
      direction: "first-to-second",
      startedAt: 100,
      provedAt: 900,
      waitWorkerMs: 10,
      notReadyCount: 1,
      retryCount: 0,
      failoverCount: 1,
      remoteMs: 20,
      proveMs: 30,
      totalMs: 40,
      workerQueueMs: 5,
      workerProveMs: 15,
      workerTotalMs: 18,
      remoteOverheadMs: 2,
      endpoint: "dedicated",
      workerGpu: "NVIDIA GeForce RTX 4090",
      webhookStoredAt: 1_000,
      boardPostedAt: 5_000,
      grindMs: 4_000,
    });
    expect(getTiming(storage, "missing")).toBeNull();
  });

  it("an older prover leaves the numbers empty; a value that is not a whole count, a label that is not a label, or a GPU name that looks like an address is dropped", () => {
    const storage = openStorage(":memory:");
    recordProveTiming(storage, { jobId: "old", direction: "second-to-first", startedAt: 1, provedAt: 2, timing: null });
    expect(getTiming(storage, "old")).toMatchObject({ startedAt: 1, provedAt: 2, waitWorkerMs: null, endpoint: null, workerGpu: null });
    recordProveTiming(storage, { jobId: "odd", direction: "second-to-first", startedAt: 1, provedAt: 2, timing: { wait_worker_ms: "12", total_ms: -1, remote_ms: 1.5, endpoint: "https://x.example", worker_gpu: "see https://x.example" } });
    expect(getTiming(storage, "odd")).toMatchObject({ waitWorkerMs: null, totalMs: null, remoteMs: null, endpoint: null, workerGpu: null });
    recordProveTiming(storage, { jobId: "gpu", direction: "second-to-first", startedAt: 1, provedAt: 2, timing: { worker_gpu: ` H100\u0007${"x".repeat(100)}`, endpoint: 7 } });
    expect(getTiming(storage, "gpu")?.workerGpu).toBe(`H100${"x".repeat(76)}`);
    recordProveTiming(storage, { jobId: "blank", direction: "second-to-first", startedAt: 1, provedAt: 2, timing: { worker_gpu: "\u0007 " } });
    expect(getTiming(storage, "blank")?.workerGpu).toBeNull();
    recordProveTiming(storage, { jobId: "mail", direction: "second-to-first", startedAt: 1, provedAt: 2, timing: { worker_gpu: "user@host" } });
    expect(getTiming(storage, "mail")?.workerGpu).toBeNull();
    recordBoardPost(storage, { jobId: "grind", direction: "second-to-first", storedAt: 1, postedAt: 2, grindMs: null });
    recordBoardPost(storage, { jobId: "grind2", direction: "second-to-first", storedAt: 1, postedAt: 2, grindMs: Number.NaN });
    recordBoardPost(storage, { jobId: "grind3", direction: "second-to-first", storedAt: 1, postedAt: 2, grindMs: -5 });
    expect([getTiming(storage, "grind")?.grindMs, getTiming(storage, "grind2")?.grindMs, getTiming(storage, "grind3")?.grindMs]).toEqual([null, null, null]);
  });

  it("lists a window newest first, the newest few whatever their age, and drops rows past the retention", () => {
    const storage = openStorage(":memory:");
    const now = 100 * DAY;
    recordProveTiming(storage, { jobId: "old", direction: "first-to-second", startedAt: 0, provedAt: now - 2 * DAY, timing: null });
    recordBoardPost(storage, { jobId: "posted-only", direction: "first-to-second", storedAt: now - 3_000, postedAt: now - 1_000, grindMs: 1 });
    recordProveTiming(storage, { jobId: "new", direction: "second-to-first", startedAt: 0, provedAt: now - 2_000, timing: null });
    expect(listTimings(storage, now - DAY).map((timing) => timing.jobId)).toEqual(["posted-only", "new"]);
    expect(recentTimings(storage, 2).map((timing) => timing.jobId)).toEqual(["posted-only", "new"]);
    recordProveTiming(storage, { jobId: "later", direction: "first-to-second", startedAt: 0, provedAt: now + TIMING_RETENTION_MILLISECONDS - DAY, timing: null });
    expect(getTiming(storage, "old")).toBeNull();
    expect(getTiming(storage, "new")).not.toBeNull();
  });

  it("states the median, the 90th percentile and the count, leaving out the unknown values", () => {
    expect(statOf([])).toEqual({ count: 0, medianMs: null, p90Ms: null });
    expect(statOf([null, 5])).toEqual({ count: 1, medianMs: 5, p90Ms: 5 });
    expect(statOf([10, 1, 9, 2, 8, 3, 7, 4, 6, 5])).toEqual({ count: 10, medianMs: 5, p90Ms: 9 });
    expect(statOf([1.4, 2.6])).toEqual({ count: 2, medianMs: 1, p90Ms: 3 });
  });
});
