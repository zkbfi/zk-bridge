/**
 * Parity with the dapp: the backend computes the shared vectors of `@zkb/core` (vectors/wait-estimates-vectors.json)
 * through its own paths, the watcher's batch plan, the keep-alive deadline, the progress answer, the pipeline answer
 * and `GET /benchmarks`, so a backend that drifts from the dapp fails here. The dapp's twin is
 * web/test/wait/wait-estimates-parity.test.ts. Owner, 2026-11-08: "make sure that your estimated calculations based on
 * configuration and deterministic behavior calculates the same thing on the backend and frontend".
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { WAD, epochSeconds, expectedFinalityAt, provingPartsOf, provingRangeOf, waitDurationText, waitEstimate, type Pair, type PairSide, type ProofRule } from "@zk-bridge/shared";
import vectors from "../../core/vectors/wait-estimates-vectors.json" with { type: "json" };
import { deadlineOf } from "../src/keepalive/plan.ts";
import { buildPipeline } from "../src/progress/pipeline.ts";
import { NO_ESTIMATES, buildProgress, clockFromHead } from "../src/progress/progress.ts";
import type { HeadUpdate, IndexedMessage, IndexerReads } from "../src/progress/indexer.ts";
import { registerProgressRoutes } from "../src/progress/routes.ts";
import { insertJob, updateJob } from "../src/requests/jobs.ts";
import { recordBoardPost, recordProveTiming } from "../src/requests/timings.ts";
import { planBatch } from "../src/watch/batch.ts";
import { makeBackend, makeConfig, PAIR } from "./support.ts";

const { message, stranding, live } = vectors;
const close = (actual: { typical: number; worst: number }, expected: { typical: number; worst: number }) => {
  expect(actual.typical).toBeCloseTo(expected.typical, 6);
  expect(actual.worst).toBeCloseTo(expected.worst, 6);
};

describe("the chain's timing, as the backend computes it (vectors)", () => {
  it("the slot clock from the indexer's head, the slot of the send and the finality the progress expects", () => {
    const head = { chainId: 943, trackedChainId: message.sourceChainId, storedHeadSlot: message.head.slot, storedHeadSlotTimestamp: message.head.slotTime };
    const clock = clockFromHead(head, 12);
    expect(clock).toEqual(message.clock);
    const progress = buildProgress({
      messageId: "0x01",
      direction: "first-to-second",
      message: { messageId: "0x01", status: "sent", direction: { sourceChainId: 11155111, destinationChainId: 943 }, sent: { timestamp: message.sentAt }, covered: null, delivered: null },
      head: null,
      clock,
      decision: null,
      jobs: [],
      timingOf: () => null,
      held: [],
      workerWarmFor: () => false,
      estimates: NO_ESTIMATES,
      now: message.sentAt * 1000 + 1_000,
    });
    expect(progress.slot).toBe(message.slot);
    expect(progress.waitingOn).toMatchObject({ service: "source-chain-finality", eta: message.expectedFinalityAt * 1000 });
  });

  it("when the watcher's batch plan holds a message back and when it proves it", () => {
    for (const entry of message.batch) {
      const plan = planBatch({
        messages: [{ messageId: "0x01", slot: message.slot, finalAt: expectedFinalityAt(message.slot, message.clock) }],
        finalizedSlot: message.slot,
        nowSeconds: message.expectedFinalityAt,
        rule: { minIntervalSeconds: entry.minIntervalSeconds, lookaheadSeconds: 384, marginWad: WAD },
        economics: { kind: "unknown", why: "testnet" },
        lastProofAt: entry.lastProofAt,
      });
      if (entry.allowsAtFinality) expect(plan, JSON.stringify(entry)).toMatchObject({ due: true, trigger: "interval" });
      else expect(plan, JSON.stringify(entry)).toMatchObject({ due: false, dueAt: entry.dueAt, startAt: entry.dueAt, startWhy: "interval" });
    }
  });

  it("the stranding deadline of the keep-alive planner and the hours the pipeline answer carries", () => {
    for (const entry of stranding.cases) {
      const facts = { headSlot: entry.headSlot, nextCommitteeKnown: entry.nextCommitteeKnown, slotsPerPeriod: stranding.slotsPerPeriod, ...stranding.clock };
      const deadline = deadlineOf(facts, 0);
      expect({ headPeriod: deadline.headPeriod, lastKnownPeriod: deadline.lastKnownPeriod, strandPeriod: deadline.strandPeriod, deadlineSeconds: deadline.deadlineSeconds }).toEqual(entry.deadline);
      for (const hours of entry.hours) {
        const decision = { at: hours.nowMs, finalizedSlot: 1, headSlot: entry.headSlot, genesisTime: 0, secondsPerSlot: 12, due: false, why: "nothing-due", detail: "", deadline: { at: deadline.deadlineSeconds * 1000, period: deadline.strandPeriod, headPeriod: deadline.headPeriod, lastKnownPeriod: deadline.lastKnownPeriod } } as const;
        const pipeline = buildPipeline({ direction: "first-to-second", rule: { minIntervalSeconds: 0, lookaheadSeconds: 0, profitMargin: 1, proofCostUsd: "0", priced: false }, activeJob: null, latestJob: null, proofs: [], head: null, decision, workerWarm: false, estimates: NO_ESTIMATES, now: hours.nowMs });
        expect(pipeline.deadline?.hoursLeft).toBe(hours.hoursUntilRounded);
      }
    }
  });
});

/** The testnet pair of the live case: Sepolia first, PulseChain testnet v4 second. */
const TESTNET: Pair = {
  name: "sepolia-pls943",
  sides: [{ ...(PAIR.sides[0] as PairSide), name: "sepolia", chainId: 11155111 }, { ...(PAIR.sides[1] as PairSide), name: "pulsechain-testnet", chainId: 943 }],
};

/**
 * A backend of the testnet pair with ten proofs a direction and ten deliveries, at the live medians and 90th
 * percentiles; `proofToOnChainMs` replaces the board-to-chain times (the fault of 2026-11-08).
 */
async function liveBackend(proofToOnChainMs?: number) {
    const backend = makeBackend({ config: makeConfig({ watch: { enabled: false, minIntervalSeconds: live.rule.minIntervalSeconds } }) });
  (backend.context as { pair: Pair }).pair = TESTNET;
  const now = backend.clock.now();
  const updates: HeadUpdate[] = [];
  const delivered: IndexedMessage[] = [];
  const bench = live.benchmarks;
  // Ten proofs a direction: half at the median, half at the 90th percentile of each step (nearest rank), the slower
  // half older, so the 20 newest prover runs the progress reads keep the same median.
  let slot = 1_000;
  for (const direction of ["first-to-second", "second-to-first"] as const) {
    for (let index = 0; index < 10; index += 1) {
      const fast = index >= 5;
      const id = `${direction}-${index}`;
      const at = now - 900_000 + (fast ? 300_000 : 0) + index * 10_000 + (direction === "first-to-second" ? 0 : 1_000);
      const provedAt = at + (fast ? bench.total.medianMs : bench.total.p90Ms);
      const posted = provedAt + 1_000 + (fast ? bench.webhookToBoard.medianMs : bench.webhookToBoard.p90Ms);
      slot += 32;
      insertJob(backend.storage, { id, direction, now: at, target: { startSlot: slot - 32, newSlot: slot } });
      updateJob(backend.storage, id, { status: "on-chain", startSlot: String(slot - 32), newSlot: String(slot) }, provedAt, ["queued"]);
      recordProveTiming(backend.storage, { jobId: id, direction, startedAt: at, provedAt, timing: { total_ms: fast ? bench.total.medianMs : bench.total.p90Ms } });
      recordBoardPost(backend.storage, { jobId: id, direction, storedAt: provedAt + 1_000, postedAt: posted, grindMs: 1_000 });
      updates.push({ chainId: 943, slot, timestamp: (posted + (proofToOnChainMs ?? (fast ? bench.proofToOnChain.medianMs : bench.proofToOnChain.p90Ms))) / 1000 });
    }
  }
  for (let index = 0; index < 10; index += 1) {
    const coveredAt = 100 + index * 10;
    const wait = (index < 5 ? bench.coveredToDelivered.medianMs : bench.coveredToDelivered.p90Ms) / 1000;
    delivered.push({ messageId: `0x${index}`, status: "delivered", direction: { sourceChainId: 11155111, destinationChainId: 943 }, sent: { timestamp: coveredAt - 900 }, covered: { headSlot: null, timestamp: coveredAt }, delivered: { timestamp: coveredAt + wait } });
  }
  const state = { message: null as IndexedMessage | null };
  const indexer: IndexerReads = { message: async () => state.message, heads: async () => [], headUpdates: async () => updates, delivered: async () => delivered, covered: async () => [] };
  const app = new Hono();
  registerProgressRoutes(app, backend.context, { indexer, callerOf: () => "10.0.0.1" });
  const get = async (path: string) => (await (await app.request(path)).json()) as Record<string, any>;
  return { backend, now, slot, state, get, bench };
}

describe("the live case through the backend's routes (vectors)", () => {
  it("GET /benchmarks and the pipeline's rule give the dapp's timeline: Sepolia to 943 about 48/83 min, 943 to Sepolia about 46/80; the progress answer times its stages from the same steps", async () => {
    const { backend, now, slot, state, get, bench } = await liveBackend();
    const benchmarks = await get("/benchmarks?window=7d");
    for (const direction of live.directions) {
      const name = direction.sourceChainId === 11155111 ? "first-to-second" : "second-to-first";
      const steps = benchmarks.byDirection[name];
      expect({ total: steps.total.medianMs, webhookToBoard: steps.webhookToBoard.medianMs, proofToOnChain: steps.proofToOnChain.medianMs }).toEqual({ total: bench.total.medianMs, webhookToBoard: bench.webhookToBoard.medianMs, proofToOnChain: bench.proofToOnChain.medianMs });
      expect([steps.total.p90Ms, steps.webhookToBoard.p90Ms, steps.proofToOnChain.p90Ms, steps.coveredToDelivered.medianMs, steps.coveredToDelivered.p90Ms]).toEqual([bench.total.p90Ms, bench.webhookToBoard.p90Ms, bench.proofToOnChain.p90Ms, bench.coveredToDelivered.medianMs, bench.coveredToDelivered.p90Ms]);
      const wire = (await get(`/directions/${name}/pipeline`)).rule;
      expect(wire).toEqual({ minIntervalSeconds: live.rule.minIntervalSeconds, lookaheadSeconds: epochSeconds(direction.sourceChainId), profitMargin: live.rule.profitMargin, proofCostUsd: "0.025000", priced: live.rule.priced });
      const rule: ProofRule = { minIntervalSeconds: wire.minIntervalSeconds, profitMargin: wire.profitMargin, proofCostUsd: Number(wire.proofCostUsd), priced: wire.priced };
      const proving = provingRangeOf(provingPartsOf(steps));
      close(proving as { typical: number; worst: number }, live.proving);
      const estimate = waitEstimate({ sourceChainId: direction.sourceChainId, timing: direction.timing as never, rule, proving }, { kind: "unknown" });
      for (const key of ["sent", "final", "proved", "delivered", "total"] as const) close(estimate[key], direction.expected[key]);
      expect([waitDurationText(estimate.total.typical), waitDurationText(estimate.total.worst)]).toEqual([direction.expected.text.typical, direction.expected.text.worst]);
    }

    // A proof stored by the webhook and not yet on the board: the board post is expected the webhook-to-board median later.
    const sentAt = Math.floor(now / 1000) - 200;
    insertJob(backend.storage, { id: "pending", direction: "first-to-second", now: now - 100_000, target: { startSlot: slot, newSlot: slot + 32 } });
    updateJob(backend.storage, "pending", { status: "proving", startSlot: String(slot), newSlot: String(slot + 32) }, now - 100_000, ["queued"]);
    recordProveTiming(backend.storage, { jobId: "pending", direction: "first-to-second", startedAt: now - 100_000, provedAt: now - 50_000, timing: null });
    backend.storage.database.prepare("UPDATE job_timings SET webhook_stored_at = ? WHERE job_id = ?").run(now - 40_000, "pending");
    const id = `0x${"cd".repeat(32)}`;
    state.message = { messageId: id, status: "waiting_for_finality", direction: { sourceChainId: 11155111, destinationChainId: 943 }, sent: { timestamp: sentAt }, covered: null, delivered: null };
    expect((await get(`/progress/${id}`)).waitingOn).toMatchObject({ service: "board-post", since: now - 40_000, eta: now - 40_000 + bench.webhookToBoard.medianMs });
    // A covered message: the delivery is expected the covered-to-delivered median after the light client update.
    state.message = { ...state.message, status: "covered", covered: { headSlot: slot + 32, timestamp: sentAt + 100 } };
    backend.clock.advance(6_000);
    expect((await get(`/progress/${id}`)).waitingOn).toMatchObject({ service: "delivery", eta: (sentAt + 100) * 1000 + bench.coveredToDelivered.medianMs });
  });

  it("the board-to-chain step: its median after the board post, and no time at all when the measured steps are past the sanity limit, as the dapp leaves them out", async () => {
    const onBoard = async (proofToOnChainMs?: number) => {
      const { backend, now, slot, state, get } = await liveBackend(proofToOnChainMs);
      insertJob(backend.storage, { id: "posted", direction: "first-to-second", now: now - 100_000, target: { startSlot: slot, newSlot: slot + 32 } });
      updateJob(backend.storage, "posted", { status: "published", startSlot: String(slot), newSlot: String(slot + 32) }, now - 20_000, ["queued"]);
      recordBoardPost(backend.storage, { jobId: "posted", direction: "first-to-second", storedAt: now - 30_000, postedAt: now - 20_000, grindMs: 1_000 });
      const id = `0x${"ef".repeat(32)}`;
      state.message = { messageId: id, status: "waiting_for_finality", direction: { sourceChainId: 11155111, destinationChainId: 943 }, sent: { timestamp: Math.floor(now / 1000) - 200 }, covered: null, delivered: null };
      return { now, waitingOn: (await get(`/progress/${id}`)).waitingOn };
    };
    const fine = await onBoard();
    expect(fine.waitingOn).toMatchObject({ service: "light-client-update", since: fine.now - 20_000, eta: fine.now - 20_000 + live.benchmarks.proofToOnChain.medianMs });
    const faulty = await onBoard(52 * 3_600_000);
    expect(faulty.waitingOn.service).toBe("light-client-update");
    expect(faulty.waitingOn.eta).toBeUndefined();
  });
});
