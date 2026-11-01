import { describe, expect, it } from "vitest";
import type { PlannedJob } from "../src/requests/jobs.ts";
import type { JobTiming } from "../src/requests/timings.ts";
import { expectedFinalityAt } from "../src/watch/decide.ts";
import type { WatchDecision } from "../src/watch/decisions.ts";
import type { IndexedHead } from "../src/progress/indexer.ts";
import { NO_ESTIMATES, buildProgress, clockFromHead, coveringJob, jobStep, type ProgressInput } from "../src/progress/progress.ts";

const GENESIS = 1_600_000_000;
const SLOT = 12;
const CLOCK = { genesisTime: GENESIS, secondsPerSlot: SLOT };
const MESSAGE_SLOT = 10_000;
const SENT = GENESIS + MESSAGE_SLOT * SLOT;
const SENT_MS = SENT * 1000;
const FINAL_MS = expectedFinalityAt(MESSAGE_SLOT, CLOCK) * 1000;
const ID = `0x${"ab".repeat(32)}`;

const head = (overrides: Partial<IndexedHead> = {}): IndexedHead => ({ chainId: 369, trackedChainId: 1, storedHeadSlot: 9_900, storedHeadSlotTimestamp: GENESIS + 9_900 * SLOT, finalizedSlot: 9_950, ...overrides });

const job = (overrides: Partial<PlannedJob> = {}): PlannedJob => ({
  id: "job-1",
  direction: "first-to-second",
  status: "proving",
  createdAt: FINAL_MS + 5_000,
  updatedAt: FINAL_MS + 5_000,
  startSlot: null,
  newSlot: null,
  error: null,
  plannedStartSlot: "9900",
  plannedNewSlot: "10016",
  ...overrides,
});

const timing = (overrides: Partial<JobTiming> = {}): JobTiming => ({
  jobId: "job-1",
  direction: "first-to-second",
  startedAt: null,
  provedAt: null,
  waitWorkerMs: null,
  notReadyCount: null,
  retryCount: null,
  failoverCount: null,
  remoteMs: null,
  proveMs: null,
  totalMs: null,
  workerQueueMs: null,
  workerProveMs: null,
  workerTotalMs: null,
  remoteOverheadMs: null,
  endpoint: null,
  workerGpu: null,
  webhookStoredAt: null,
  boardPostedAt: null,
  grindMs: null,
  ...overrides,
});

const decision = (overrides: Partial<WatchDecision> = {}): WatchDecision => ({ at: FINAL_MS, finalizedSlot: 10_016, headSlot: 9_900, genesisTime: GENESIS, secondsPerSlot: SLOT, due: false, why: "nothing-due", detail: "the head is fresh", ...overrides });

function input(overrides: Partial<ProgressInput> & { status?: string; covered?: { headSlot: number | null; timestamp: number | null } | null; delivered?: { timestamp: number; success?: boolean | null } | null } = {}): ProgressInput {
  const { status = "sent", covered = null, delivered = null, ...rest } = overrides;
  return {
    messageId: ID,
    direction: "first-to-second",
    message: { messageId: ID, status, direction: { sourceChainId: 1, destinationChainId: 369 }, sent: { timestamp: SENT }, covered, delivered },
    head: head(),
    clock: CLOCK,
    decision: null,
    jobs: [],
    timingOf: () => null,
    held: [],
    workerWarmFor: () => false,
    estimates: NO_ESTIMATES,
    now: SENT_MS + 60_000,
    ...rest,
  };
}

const statuses = (progress: ReturnType<typeof buildProgress>) => Object.fromEntries(progress.stages.map((stage) => [stage.key, stage.status]));

describe("the progress of a transfer (2026-11-01)", () => {
  it("a send that is not final yet waits for the source chain's finality, with its expected time", () => {
    const progress = buildProgress(input());
    expect(progress).toMatchObject({ messageId: ID, direction: "first-to-second", status: "sent", slot: MESSAGE_SLOT });
    expect(statuses(progress)).toEqual({ sent: "done", final: "current", batched: "pending", proving: "pending", "proof-ready": "pending", "update-posted": "pending", delivered: "pending" });
    expect(progress.stages[0]).toEqual({ key: "sent", status: "done", at: SENT_MS });
    expect(progress.waitingOn).toMatchObject({ service: "source-chain-finality", since: SENT_MS, eta: FINAL_MS });
    expect(progress).not.toHaveProperty("proof");
    expect(progress).not.toHaveProperty("job");
  });

  it("a final send without a decision waits for the watcher's next finality", () => {
    const progress = buildProgress(input({ head: head({ finalizedSlot: 10_016 }), now: FINAL_MS + 60_000 }));
    expect(statuses(progress)).toMatchObject({ final: "done", batched: "current" });
    expect(progress.stages[1]).toEqual({ key: "final", status: "done", at: FINAL_MS, detail: `slot ${MESSAGE_SLOT}; the source chain finalized slot 10016` });
    expect(progress.waitingOn).toMatchObject({ service: "source-chain-finality", since: FINAL_MS, detail: expect.stringContaining("decided nothing") });
  });

  it("a batch that waits for profit, or for the minimum interval since the last proof, names that wait and when it ends", () => {
    const batch = { messages: 2, feesUsd: "0.01", costUsd: "0.05", unknownWhy: null, oldestFinalAt: FINAL_MS, startAt: FINAL_MS + 100_000, startWhy: "profit" as const, dueAt: FINAL_MS + 3_600_000, lastProofAt: FINAL_MS - 600_000 };
    const final = { head: head({ finalizedSlot: 10_016 }), now: FINAL_MS + 60_000 };
    const profit = buildProgress(input({ ...final, decision: decision({ why: "min-interval", detail: "2 messages wait", batch }) }));
    expect(profit.waitingOn).toEqual({ service: "batch-profit", since: FINAL_MS, eta: FINAL_MS + 100_000, detail: "2 messages wait" });
    const fallback = buildProgress(input({ ...final, decision: decision({ why: "min-interval", detail: "2 messages wait", batch: { ...batch, startWhy: "interval" } }) }));
    // The service keeps its first name on the wire.
    expect(fallback.waitingOn).toMatchObject({ service: "batch-max-wait", eta: FINAL_MS + 3_600_000 });
    // The decision's finalized slot stands in for the indexer's when the indexer gave none.
    const noHead = buildProgress(input({ head: null, decision: decision({ why: "min-interval", detail: "x", batch }) }));
    expect(statuses(noHead)).toMatchObject({ final: "done", batched: "current" });
    expect(noHead.stages[1]?.detail).toBe(`slot ${MESSAGE_SLOT}; the source chain finalized slot 10016`);
  });

  it("a proof we have that waits to land holds the transfer; any other decision waits for the next finality", () => {
    const pending = buildProgress(input({ head: head({ finalizedSlot: 10_016 }), decision: decision({ why: "proof-pending", detail: "the proof from slot 9900 to slot 9990 (board) waits to land" }) }));
    expect(pending.waitingOn).toMatchObject({ service: "proof-dedup-pending", detail: "the proof from slot 9900 to slot 9990 (board) waits to land" });
    const other = buildProgress(input({ head: head({ finalizedSlot: 10_016 }), decision: decision() }));
    expect(other.waitingOn).toMatchObject({ service: "source-chain-finality", detail: "the watcher acts on the next finality of the source chain; its last decision: the head is fresh" });
    const noBatch = buildProgress(input({ head: head({ finalizedSlot: 10_016 }), decision: decision({ why: "min-interval" }) }));
    expect(noBatch.waitingOn.service).toBe("source-chain-finality");
  });

  it("a queued job waits for the prover, a cold one for a worker, then the GPU proves", () => {
    const estimates = { ...NO_ESTIMATES, workerWaitMs: 60_000, totalMs: 120_000 };
    const queued = buildProgress(input({ jobs: [job({ status: "queued" })], estimates }));
    expect(statuses(queued)).toMatchObject({ final: "done", batched: "done", proving: "current" });
    expect(queued.stages[2]).toEqual({ key: "batched", status: "done", at: FINAL_MS + 5_000, detail: "job job-1" });
    expect(queued.waitingOn).toMatchObject({ service: "gpu-worker-start", since: FINAL_MS + 5_000, eta: FINAL_MS + 125_000 });
    expect(queued.job).toEqual({ jobId: "job-1", status: "queued" });
    const cold = buildProgress(input({ jobs: [job()], estimates, now: FINAL_MS + 30_000 }));
    expect(cold.waitingOn).toMatchObject({ service: "gpu-worker-start", detail: expect.stringContaining("a cold worker took 60 s") });
    const proving = buildProgress(input({ jobs: [job()], estimates, now: FINAL_MS + 70_000 }));
    expect(proving.waitingOn).toMatchObject({ service: "gpu-proving", detail: expect.stringContaining("estimated from recent jobs") });
    const warm = buildProgress(input({ jobs: [job()], estimates, now: FINAL_MS + 30_000, workerWarmFor: () => true }));
    expect(warm.waitingOn).toMatchObject({ service: "gpu-proving", detail: "a warm-up made a worker ready before the job" });
  });

  it("the proof is stored but not on the board: the board post is what it waits on, with the proof and where it is", () => {
    const stored = buildProgress(
      input({ jobs: [job({ startSlot: "9900", newSlot: "10016" })], timingOf: () => timing({ provedAt: FINAL_MS + 100_000, webhookStoredAt: FINAL_MS + 99_000 }), estimates: { ...NO_ESTIMATES, grindMs: 20_000 } }),
    );
    expect(statuses(stored)).toMatchObject({ proving: "done", "proof-ready": "current" });
    expect(stored.stages[3]).toEqual({ key: "proving", status: "done", at: FINAL_MS + 99_000 });
    expect(stored.waitingOn).toMatchObject({ service: "board-post", since: FINAL_MS + 99_000, eta: FINAL_MS + 119_000 });
    expect(stored.proof).toEqual({ startSlot: 9_900, newSlot: 10_016, where: "stored" });
    // With the prover's slots alone, the job's last change is when the proof was made.
    const slotsOnly = buildProgress(input({ jobs: [job({ startSlot: "9900", newSlot: "10016", updatedAt: FINAL_MS + 80_000 })] }));
    expect(slotsOnly.stages[3]?.at).toBe(FINAL_MS + 80_000);
  });

  it("on the board, it waits for a runner to update the light client", () => {
    const posted = buildProgress(input({ jobs: [job({ status: "published", startSlot: "9900", newSlot: "10016" })], timingOf: () => timing({ boardPostedAt: FINAL_MS + 150_000 }), estimates: { ...NO_ESTIMATES, proofToOnChainMs: 30_000 } }));
    expect(statuses(posted)).toMatchObject({ "proof-ready": "done", "update-posted": "current" });
    expect(posted.waitingOn).toMatchObject({ service: "light-client-update", since: FINAL_MS + 150_000, eta: FINAL_MS + 180_000 });
    expect(posted.proof).toEqual({ startSlot: 9_900, newSlot: 10_016, where: "board" });
    const onChainJob = buildProgress(input({ jobs: [job({ status: "on-chain", startSlot: "9900", newSlot: "10016" })] }));
    expect(statuses(onChainJob)).toMatchObject({ "proof-ready": "done", "update-posted": "current" });
  });

  it("a proof the board holds for the message counts without a job", () => {
    const progress = buildProgress(input({ held: [{ startSlot: 9_900, newSlot: 10_100, where: "board", since: FINAL_MS + 1_000 }, { startSlot: 9_800, newSlot: 10_100, where: "board", since: FINAL_MS }, { startSlot: 9_900, newSlot: 10_200, where: "stored", since: FINAL_MS + 2_000 }] }));
    expect(statuses(progress)).toMatchObject({ final: "done", batched: "done", proving: "done", "proof-ready": "done", "update-posted": "current" });
    expect(progress.proof).toEqual({ startSlot: 9_900, newSlot: 10_100, where: "board" });
    expect(progress.stages[3]?.at).toBe(FINAL_MS + 1_000);
    // A held proof that does not reach the message carries nothing.
    expect(buildProgress(input({ held: [{ startSlot: 9_900, newSlot: 9_990, where: "stored", since: 1 }] }))).not.toHaveProperty("proof");
  });

  it("covered by the light client, it waits for delivery; the proof is applied", () => {
    const progress = buildProgress(
      input({
        status: "covered",
        covered: { headSlot: 10_016, timestamp: SENT + 2_000 },
        head: head({ storedHeadSlot: 10_016 }),
        jobs: [job({ status: "on-chain", startSlot: "9900", newSlot: "10016" })],
        estimates: { ...NO_ESTIMATES, coveredToDeliveredMs: 40_000 },
      }),
    );
    expect(statuses(progress)).toMatchObject({ "update-posted": "done", delivered: "current" });
    expect(progress.stages[5]).toEqual({ key: "update-posted", status: "done", at: (SENT + 2_000) * 1000, detail: "the light client head is at slot 10016" });
    expect(progress.waitingOn).toMatchObject({ service: "delivery", since: (SENT + 2_000) * 1000, eta: (SENT + 2_000) * 1000 + 40_000 });
    expect(progress.proof).toEqual({ startSlot: 9_900, newSlot: 10_016, where: "applied" });
    // A head that passed the slot covers it even before the indexer's status says so; a later proof is still on the board.
    const byHead = buildProgress(input({ head: head({ storedHeadSlot: 10_000 }), jobs: [job({ status: "published", startSlot: "9900", newSlot: "10016" })] }));
    expect(statuses(byHead)).toMatchObject({ "update-posted": "done", delivered: "current" });
    expect(byHead.proof?.where).toBe("applied");
    expect(byHead.waitingOn).toMatchObject({ service: "delivery" });
    expect(byHead.waitingOn).not.toHaveProperty("eta");
  });

  it("delivered: nothing is waited on; a failed delivery says how it ended", () => {
    const delivered = buildProgress(input({ status: "delivered", covered: { headSlot: 10_016, timestamp: null }, delivered: { timestamp: SENT + 3_000, success: true } }));
    expect(new Set(Object.values(statuses(delivered)))).toEqual(new Set(["done"]));
    expect(delivered.waitingOn).toEqual({ service: "none", since: (SENT + 3_000) * 1000, detail: "delivered" });
    expect(delivered.stages[6]).toEqual({ key: "delivered", status: "done", at: (SENT + 3_000) * 1000 });
    const failed = buildProgress(input({ status: "failed_call", delivered: { timestamp: SENT + 3_000, success: false } }));
    expect(failed.waitingOn.detail).toBe("the delivery ended as failed call");
    expect(failed.stages[6]?.detail).toBe("the delivery ended as failed call");
    const release = buildProgress(input({ status: "release_failed", delivered: null }));
    expect(release.waitingOn).toEqual({ service: "none", since: SENT_MS, detail: "the delivery ended as release failed" });
  });

  it("without a slot clock or a head, the indexer's status and the jobs carry it", () => {
    const unknown = buildProgress(input({ clock: null, head: null }));
    expect(unknown.slot).toBeNull();
    expect(unknown.waitingOn).toEqual({ service: "source-chain-finality", since: SENT_MS, detail: expect.any(String) });
    expect(unknown.stages[1]).toEqual({ key: "final", status: "current" });
    const waiting = buildProgress(input({ clock: null, head: null, status: "waiting_for_finality" }));
    expect(statuses(waiting)).toMatchObject({ final: "done", batched: "current" });
    expect(waiting.stages[1]).toEqual({ key: "final", status: "done" });
    const withJob = buildProgress(input({ clock: null, head: null, jobs: [job({ plannedNewSlot: "1" })] }));
    expect(statuses(withJob)).toMatchObject({ batched: "done", proving: "current" });
    expect(withJob.stages[5]).toEqual({ key: "update-posted", status: "pending" });
    const clockOnly = buildProgress(input({ head: null }));
    expect(clockOnly.stages[1]).toEqual({ key: "final", status: "current", detail: `slot ${MESSAGE_SLOT}` });
    const headWithoutSlot = buildProgress(input({ head: head({ storedHeadSlot: null }), held: [{ startSlot: 1, newSlot: 10_100, where: "stored", since: 5 }] }));
    expect(headWithoutSlot.proof).toEqual({ startSlot: 1, newSlot: 10_100, where: "stored" });
  });
});

describe("the job that carries a message", () => {
  const sentAt = 1_000;
  it("skips failed jobs, jobs made before the send, and jobs that end before the slot; a running job without a target counts", () => {
    expect(coveringJob([job({ status: "failed", createdAt: 2_000 }), job({ id: "early", createdAt: 500 }), job({ id: "short", createdAt: 2_000, plannedNewSlot: "5" }), job({ id: "ok", createdAt: 3_000, newSlot: "20", plannedNewSlot: "5" })], 10, sentAt)?.id).toBe("ok");
    expect(coveringJob([job({ id: "open", createdAt: 2_000, plannedNewSlot: null })], 10, sentAt)?.id).toBe("open");
    expect(coveringJob([job({ id: "q", status: "queued", createdAt: 2_000, plannedNewSlot: null })], 10, sentAt)?.id).toBe("q");
    // A job that found the chain up to date proved nothing.
    expect(coveringJob([job({ status: "on-chain", createdAt: 2_000, plannedNewSlot: null })], 10, sentAt)).toBeNull();
    expect(coveringJob([job({ createdAt: 2_000, plannedNewSlot: "5" })], null, sentAt)?.id).toBe("job-1");
  });

  it("the step of a running job without estimates", () => {
    expect(jobStep({ job: job(), workerWarm: false, estimates: NO_ESTIMATES, now: FINAL_MS + 6_000 })).toEqual({ service: "gpu-proving", since: FINAL_MS + 5_000, detail: "estimated from recent jobs; the prover reports its steps when it ends" });
  });
});

describe("the slot clock from the indexer's head", () => {
  it("is the head's slot start minus its slots, or null when the head lacks either", () => {
    expect(clockFromHead(head(), SLOT)).toEqual(CLOCK);
    expect(clockFromHead(null, SLOT)).toBeNull();
    expect(clockFromHead(head({ storedHeadSlot: null }), SLOT)).toBeNull();
    expect(clockFromHead(head({ storedHeadSlotTimestamp: null }), SLOT)).toBeNull();
    expect(clockFromHead(head({ storedHeadSlotTimestamp: undefined }), SLOT)).toBeNull();
  });
});
