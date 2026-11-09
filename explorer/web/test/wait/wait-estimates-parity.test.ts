/**
 * Parity with the backend: the dapp computes the shared vectors of `@zkb/core` (vectors/wait-estimates-vectors.json)
 * through its own paths, the backend client and the indexer parser feeding `provingOf`, `ruleOf` and `timingFor`, the
 * timeline, the time left on an Activity card, the step list of the time drawer, the beacon clocks of Explore and the
 * "until stranded" line, so a dapp that drifts from the backend fails here. The backend's twin is
 * backend/test/wait-estimates-parity.test.ts. Owner, 2026-11-08: "make sure that your estimated calculations based on
 * configuration and deterministic behavior calculates the same thing on the backend and frontend".
 */
import { describe, expect, it } from "vitest";
import { createBackendClient } from "@zk-bridge/shared/backend-client";
import vectors from "../../../core/vectors/wait-estimates-vectors.json";
import { chainsFor, transferSteps } from "../../src/bridge/bridge-model";
import { parseBeaconClocks, parseDelivered } from "../../src/explore/explore-source";
import { hoursLeftOf } from "../../src/stranding/stranding";
import { buildTimeline, durationText, provingOf, remainingOf, ruleOf, timingFor, type FeeReading } from "../../src/wait/wait-model";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";

const { live, message, stranding } = vectors;
const close = (actual: { typical: number; worst: number }, expected: { typical: number; worst: number }) => {
  expect(actual.typical).toBeCloseTo(expected.typical, 6);
  expect(actual.worst).toBeCloseTo(expected.worst, 6);
};
const unknown: FeeReading = { kind: "unknown" };

/** A benchmark step as the backend answers it. */
const step = (stat: { count: number; medianMs: number | null; p90Ms: number | null }) => ({ ...stat });
const empty = { count: 0, medianMs: null, p90Ms: null };
const STEPS = ["workerWait", "remote", "workerQueue", "workerProve", "total", "webhookToBoard", "boardPost", "proofToOnChain", "coveredToDelivered", "sentToDelivered"] as const;
const benchmarkSteps = Object.fromEntries(STEPS.map((name) => [name, name in live.benchmarks ? step(live.benchmarks[name as keyof typeof live.benchmarks]) : empty]));

/** The backend's answers of the live case, as `GET /benchmarks?window=7d` and `GET /directions/:direction/pipeline` give them. */
const wire: Record<string, unknown> = {
  "/benchmarks?window=7d": { window: "7d", windowSeconds: 604_800, from: 0, to: 1, steps: benchmarkSteps, byDirection: { "first-to-second": benchmarkSteps, "second-to-first": benchmarkSteps }, recent: [], indexer: "ok" },
  ...Object.fromEntries(
    (["first-to-second", "second-to-first"] as const).map((direction) => [
      `/directions/${direction}/pipeline`,
      { direction, now: 1, rule: { minIntervalSeconds: live.rule.minIntervalSeconds, lookaheadSeconds: 384, profitMargin: live.rule.profitMargin, proofCostUsd: "0.025000", priced: live.rule.priced }, batch: null, job: null, latestJob: null, latestProof: null, head: null, decision: null },
    ]),
  ),
};
const client = createBackendClient({
  baseUrl: "https://prove.example",
  fetchJson: async (url) => ({ status: 200, body: wire[url.replace("https://prove.example", "")] }),
  postJson: async () => ({ status: 500, body: null }),
});

/** The indexer's `GET /api/delivered` of the live case: 14 deliveries from each source in 7 days. */
const deliveredAnswer = {
  directions: live.directions.map((direction) => ({ sourceChainId: direction.sourceChainId, last24h: 2, last7d: direction.timing.count })),
  timing: live.directions.map((direction) => {
    const window = { count: direction.timing.count, sentToDelivered: { avg: null, median: null, p90: null }, steps: { sent: { avg: null, ...direction.timing.steps[0] }, final: { avg: null, ...direction.timing.steps[1] }, ready: { avg: null, ...direction.timing.steps[2] } } };
    return { sourceChainId: direction.sourceChainId, last24h: window, last7d: window };
  }),
};

describe("the live case through the dapp's paths (vectors)", () => {
  it("Sepolia to 943 about 45 min typical and 77 min worst, 943 to Sepolia about 43 and 75, from the backend client and the indexer parser", async () => {
    const delivered = parseDelivered(deliveredAnswer);
    for (const direction of live.directions) {
      const name = direction.sourceChainId === 11155111 ? "first-to-second" : "second-to-first";
      const [pipeline, benchmarks] = await Promise.all([client.pipeline(name), client.benchmarks("7d")]);
      const proving = provingOf(benchmarks.byDirection[name]);
      close(proving as { typical: number; worst: number }, live.proving);
      const timeline = buildTimeline({ sourceChainId: direction.sourceChainId, timing: timingFor(delivered, direction.sourceChainId), rule: ruleOf(pipeline.rule), proving }, unknown);
      const keys = ["sent", "final", "proved", "delivered"] as const;
      keys.forEach((key, index) => close(timeline.steps[index]!.range, direction.expected[key]));
      close(timeline.total, direction.expected.total);
      expect([durationText(timeline.total.typical), durationText(timeline.total.worst)]).toEqual([direction.expected.text.typical, direction.expected.text.worst]);
      expect(timeline).toMatchObject({ basis: "measured", samples: direction.timing.count, start: "testnet", batchSeconds: 3600 });
    }
  });

  it("without the indexer's deliveries: the chain's finality rule and the defaults, the backend watcher's rule", async () => {
    for (const direction of live.derived) {
      const name = direction.sourceChainId === 11155111 ? "first-to-second" : "second-to-first";
      const timeline = buildTimeline({ sourceChainId: direction.sourceChainId, timing: null, rule: ruleOf((await client.pipeline(name)).rule), proving: provingOf((await client.benchmarks("7d")).byDirection[name]) }, unknown);
      close(timeline.total, direction.expected.total);
      expect([durationText(timeline.total.typical), durationText(timeline.total.worst)]).toEqual([direction.expected.text.typical, direction.expected.text.worst]);
    }
  });

  it("a fee that pays proves at finality, one a unit short waits for a batch", () => {
    for (const entry of live.fees) {
      const timeline = buildTimeline({ sourceChainId: 11155111, timing: null, rule: entry.rule, proving: live.proving }, { kind: "known", feeUsd: BigInt(entry.feeUsd), costUsd: BigInt(entry.costUsd) });
      close(timeline.steps[2].range, entry.proved);
      expect(timeline.start).toBe(entry.start);
    }
  });

  it("the time left on an Activity card", async () => {
    const direction = live.directions[0]!;
    const timeline = buildTimeline({ sourceChainId: direction.sourceChainId, timing: timingFor(parseDelivered(deliveredAnswer), direction.sourceChainId), rule: ruleOf((await client.pipeline("first-to-second")).rule), proving: live.proving }, unknown);
    for (const entry of live.remaining) {
      const left = remainingOf(timeline, entry.status, entry.elapsedSeconds);
      if (entry.left === null) expect(left).toBeNull();
      else {
        close(left as { typical: number; worst: number }, entry.left);
        expect(left?.late).toBe(entry.left.late);
      }
    }
  });

  it("the time drawer's steps carry the same chain figures: final on the source by the chain's rule, then the defaults", () => {
    const { source, destination } = chainsFor(FIXTURE_PAIR, "first-to-second");
    const from = vectors.chains.find((chain) => chain.chainId === source.chainId)!;
    const to = vectors.chains.find((chain) => chain.chainId === destination.chainId)!;
    expect(transferSteps(source, destination).map((row) => row.seconds)).toEqual([from.secondsPerSlot, from.finalityWait.typical - from.secondsPerSlot, 120, to.secondsPerSlot, 60]);
  });
});

describe("the chain's timing through the dapp's paths (vectors)", () => {
  it("Explore's beacon clock from a head is the backend's", () => {
    const [clock] = parseBeaconClocks({ heads: [{ chainId: 943, trackedChainId: message.sourceChainId, storedHeadSlot: message.head.slot, storedHeadSlotTimestamp: message.head.slotTime }] });
    expect(clock).toEqual({ trackedChainId: message.sourceChainId, ...message.clock });
  });

  it("the hours until stranded are the backend's, unrounded", () => {
    for (const entry of stranding.cases) {
      for (const hours of entry.hours) {
        const left = hoursLeftOf({ at: entry.deadline.deadlineSeconds * 1000, period: entry.deadline.strandPeriod }, hours.nowMs);
        expect(left).toBeCloseTo(hours.hoursUntil, 9);
        expect(Math.round(left * 100) / 100).toBe(hours.hoursUntilRounded);
      }
    }
  });
});
