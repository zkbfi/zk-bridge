import { describe, expect, it } from "vitest";
import type { Job } from "../src/requests/jobs.ts";
import type { JobTiming } from "../src/requests/timings.ts";
import { RECENT_LIMIT, buildBenchmarks, parseWindow } from "../src/progress/benchmarks.ts";
import type { IndexedMessage } from "../src/progress/indexer.ts";

const NOW = 100 * 86_400_000;
const timing = (jobId: string, overrides: Partial<JobTiming> = {}): JobTiming => ({
  jobId,
  direction: "first-to-second",
  startedAt: NOW - 200_000,
  provedAt: NOW - 100_000,
  waitWorkerMs: 60_000,
  notReadyCount: 2,
  retryCount: 0,
  failoverCount: 0,
  remoteMs: 40_000,
  proveMs: 95_000,
  totalMs: 100_000,
  workerQueueMs: 0,
  workerProveMs: 35_000,
  workerTotalMs: 38_000,
  remoteOverheadMs: 2_000,
  endpoint: "serverless",
  workerGpu: "RTX 4090",
  webhookStoredAt: NOW - 99_000,
  boardPostedAt: NOW - 90_000,
  grindMs: 8_000,
  ...overrides,
});
const job = (id: string, newSlot: string | null): Job => ({ id, direction: "first-to-second", status: "published", createdAt: 0, updatedAt: 0, startSlot: newSlot === null ? null : "100", newSlot, error: null });
const delivered = (sent: number, covered: number | null, at: number | null): IndexedMessage => ({
  messageId: "0x",
  status: "delivered",
  direction: { sourceChainId: 1, destinationChainId: 369 },
  sent: { timestamp: sent },
  covered: covered === null ? null : { headSlot: 1, timestamp: covered },
  delivered: at === null ? null : { timestamp: at },
});

describe("the window of the benchmarks", () => {
  it("takes minutes, hours or days from one hour to thirty days", () => {
    expect(parseWindow("24h")).toBe(86_400);
    expect(parseWindow("90m")).toBe(5_400);
    expect(parseWindow("7d")).toBe(604_800);
    expect(parseWindow("30d")).toBe(2_592_000);
    for (const bad of ["59m", "31d", "1w", "h", "-1h", "1.5h", "100000d"]) expect(parseWindow(bad)).toBeNull();
  });
});

describe("the benchmarks of a window (2026-11-01)", () => {
  it("states each step's median, p90 and count, per direction and in all, and the recent proofs with when they landed", () => {
    const sec = (ms: number) => ms / 1000;
    const benchmarks = buildBenchmarks({
      window: "24h",
      windowSeconds: 86_400,
      now: NOW,
      timings: [timing("a"), timing("b", { direction: "second-to-first", waitWorkerMs: 0, notReadyCount: 0, workerProveMs: null, grindMs: null, boardPostedAt: null }), timing("c", { notReadyCount: null })],
      jobOf: (id) => (id === "a" ? job("a", "200") : id === "b" ? job("b", null) : job("c", "999")),
      indexer: {
        "first-to-second": {
          headUpdates: [
            { chainId: 369, slot: 210, timestamp: sec(NOW - 50_000) },
            { chainId: 369, slot: 200, timestamp: sec(NOW - 60_000) },
            { chainId: 369, slot: 150, timestamp: sec(NOW - 500_000) },
            { chainId: 369, slot: 220, timestamp: sec(NOW - 40_000) },
          ],
          delivered: [delivered(sec(NOW - 400_000), sec(NOW - 100_000), sec(NOW - 40_000)), delivered(sec(NOW - 90 * 86_400_000), null, sec(NOW - 89 * 86_400_000)), delivered(sec(NOW - 1_000), null, null)],
        },
        "second-to-first": { headUpdates: [], delivered: [{ ...delivered(sec(NOW - 300_000), null, sec(NOW - 100_000)), sent: null }, delivered(sec(NOW - 200_000), null, sec(NOW - 100_000))] },
      },
    });
    expect(benchmarks).toMatchObject({ window: "24h", windowSeconds: 86_400, from: NOW - 86_400_000, to: NOW, indexer: "ok" });
    expect(benchmarks.steps.workerWait).toEqual({ count: 3, medianMs: 60_000, p90Ms: 60_000 });
    expect(benchmarks.steps.workerProve).toEqual({ count: 2, medianMs: 35_000, p90Ms: 35_000 });
    expect(benchmarks.steps.webhookToBoard).toEqual({ count: 2, medianMs: 9_000, p90Ms: 9_000 });
    expect(benchmarks.steps.boardPost).toEqual({ count: 2, medianMs: 8_000, p90Ms: 8_000 });
    expect(benchmarks.steps.proofToOnChain).toEqual({ count: 1, medianMs: 30_000, p90Ms: 30_000 });
    expect(benchmarks.steps.coveredToDelivered).toEqual({ count: 1, medianMs: 60_000, p90Ms: 60_000 });
    expect(benchmarks.steps.sentToDelivered).toEqual({ count: 2, medianMs: 100_000, p90Ms: 360_000 });
    expect(benchmarks.byDirection["second-to-first"].workerWait).toEqual({ count: 1, medianMs: 0, p90Ms: 0 });
    expect(benchmarks.byDirection["second-to-first"].sentToDelivered).toEqual({ count: 1, medianMs: 100_000, p90Ms: 100_000 });
    expect(benchmarks.byDirection["first-to-second"].total.count).toBe(2);
    expect(benchmarks.recent.map((proof) => [proof.jobId, proof.startSlot, proof.newSlot, proof.coldWorker, proof.onChainAt])).toEqual([
      ["a", 100, 200, true, NOW - 60_000],
      ["b", null, null, false, null],
      ["c", 100, 999, null, null],
    ]);
    expect(benchmarks.recent[0]).toMatchObject({ endpoint: "serverless", workerGpu: "RTX 4090", grindMs: 8_000, totalMs: 100_000 });
  });

  it("counts only proofs whose own light client update landed, not a later head that covered them (live 2026-11-08: 52 h median)", () => {
    // Live, 7 d window: the light client was redeployed 19 h ago, so the indexer's head updates start at slot 11274912.
    // The proofs of the days before (the old light client) were matched to that first update "at or past" their slot,
    // which put proofToOnChain at a 52 h median and a 113 h p90 although every proof landed seconds after its board post.
    const hour = 3_600_000;
    const sec = (ms: number) => Math.floor(ms / 1000);
    const posted = (jobId: string, ageMs: number, direction: "first-to-second" | "second-to-first" = "second-to-first") =>
      timing(jobId, { direction, boardPostedAt: NOW - ageMs, webhookStoredAt: NOW - ageMs - 16_000 });
    const slots: Record<string, string> = { old1: "11250000", old2: "11262000", old3: "11270400", skipped: "11281376", fresh1: "11280928", fresh2: "11281792" };
    const benchmarks = buildBenchmarks({
      window: "7d",
      windowSeconds: 7 * 86_400,
      now: NOW,
      timings: [posted("fresh2", 1 * hour), posted("skipped", 2 * hour), posted("fresh1", 3 * hour), posted("old3", 30 * hour), posted("old2", 70 * hour), posted("old1", 120 * hour)],
      jobOf: (id) => ({ ...job(id, slots[id] as string), direction: "second-to-first" }),
      indexer: {
        "first-to-second": { headUpdates: [], delivered: [] },
        "second-to-first": {
          headUpdates: [
            { chainId: 11155111, slot: 11281792, timestamp: sec(NOW - 1 * hour + 2_298) },
            // "skipped" was deduplicated on the board: no update of its own; the next head covered it an hour later.
            { chainId: 11155111, slot: 11280928, timestamp: sec(NOW - 3 * hour + 8_350) },
            { chainId: 11155111, slot: 11274912, timestamp: sec(NOW - 19 * hour) },
          ],
          delivered: [],
        },
      },
    });
    expect(benchmarks.recent.map((proof) => [proof.jobId, proof.onChainAt])).toEqual([
      ["fresh2", sec(NOW - 1 * hour + 2_298) * 1000],
      ["skipped", null],
      ["fresh1", sec(NOW - 3 * hour + 8_350) * 1000],
      ["old3", null],
      ["old2", null],
      ["old1", null],
    ]);
    expect(benchmarks.steps.proofToOnChain.count).toBe(2);
    expect(benchmarks.steps.proofToOnChain.p90Ms).toBeLessThan(60_000);
  });

  it("the earliest update of the slot is the landing, and one stored before the board post is not counted", () => {
    const update = (ago: number) => ({ chainId: 369, slot: 200, timestamp: (NOW - ago) / 1000 });
    const benchmarks = buildBenchmarks({
      window: "24h",
      windowSeconds: 86_400,
      now: NOW,
      timings: [timing("a")],
      jobOf: () => job("a", "200"),
      indexer: { "first-to-second": { headUpdates: [update(10_000), update(95_000), update(50_000)], delivered: [] }, "second-to-first": { headUpdates: [], delivered: [] } },
    });
    expect(benchmarks.recent[0]?.onChainAt).toBe(NOW - 95_000);
    expect(benchmarks.steps.proofToOnChain.count).toBe(0);
  });

  it("without the indexer the on-chain and delivery steps are empty, and the recent list has a limit", () => {
    const timings = Array.from({ length: RECENT_LIMIT + 5 }, (_, index) => timing(`j${index}`));
    const benchmarks = buildBenchmarks({ window: "1h", windowSeconds: 3_600, now: NOW, timings, jobOf: () => null, indexer: null });
    expect(benchmarks.recent[0]).toMatchObject({ startSlot: null, newSlot: null });
    expect(benchmarks.indexer).toBe("unavailable");
    expect(benchmarks.steps.proofToOnChain).toEqual({ count: 0, medianMs: null, p90Ms: null });
    expect(benchmarks.steps.sentToDelivered.count).toBe(0);
    expect(benchmarks.recent).toHaveLength(RECENT_LIMIT);
    expect(benchmarks.recent[0]?.onChainAt).toBeNull();
  });
});
