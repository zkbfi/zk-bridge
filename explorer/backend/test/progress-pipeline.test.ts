import { describe, expect, it } from "vitest";
import { insertJob, updateJob, type Job } from "../src/requests/jobs.ts";
import { openStorage } from "../src/storage.ts";
import { ensureProofTable } from "../src/webhook/receive.ts";
import type { WatchDecision } from "../src/watch/decisions.ts";
import { buildPipeline, furthestProof, knownProofs, pipelineRuleOf } from "../src/progress/pipeline.ts";
import { NO_ESTIMATES } from "../src/progress/progress.ts";

const NOW = 2_000_000;
const job = (overrides: Partial<Job> = {}): Job => ({ id: "j", direction: "first-to-second", status: "proving", createdAt: NOW - 30_000, updatedAt: NOW - 30_000, startSlot: null, newSlot: null, error: null, ...overrides });
const decision = (overrides: Partial<WatchDecision> = {}): WatchDecision => ({ at: NOW, finalizedSlot: 200, headSlot: 100, genesisTime: 0, secondsPerSlot: 12, due: false, why: "nothing-due", detail: "fresh", ...overrides });
const rule = { minIntervalSeconds: 3600, lookaheadSeconds: 768, profitMargin: 1.5, proofCostUsd: "0.025000", priced: false };
const base = { direction: "first-to-second" as const, rule, activeJob: null, latestJob: null, proofs: [], head: null, decision: null, workerWarm: false, estimates: NO_ESTIMATES, now: NOW };

describe("the proofs the backend has, with where they are (2026-11-01)", () => {
  it("the board's proof, the webhook's (posted or not) and the newest job's slots", () => {
    const storage = openStorage(":memory:");
    expect(knownProofs(storage, "first-to-second")).toEqual([]);
    storage.database.prepare("INSERT INTO proofs (direction, job_id, start_slot, new_slot, body, stored_at) VALUES (?, NULL, '100', '150', '{}', 5)").run("first-to-second");
    insertJob(storage, { id: "a", direction: "first-to-second", now: 1 });
    updateJob(storage, "a", { status: "published" }, 1, ["queued"]);
    insertJob(storage, { id: "b", direction: "first-to-second", now: 2 });
    ensureProofTable(storage);
    storage.database.prepare("INSERT INTO webhook_proofs (job_id, direction, payload, start_slot, new_slot, stored_at, posted_at) VALUES ('a', 'first-to-second', '0x', '100', '160', 6, 7)").run();
    storage.database.prepare("INSERT INTO webhook_proofs (job_id, direction, payload, start_slot, new_slot, stored_at) VALUES ('b', 'first-to-second', '0x', '100', '170', 8)").run();
    updateJob(storage, "b", { status: "proving", startSlot: "100", newSlot: "170" }, 9, ["queued"]);
    expect(knownProofs(storage, "first-to-second")).toEqual([
      { startSlot: 100, newSlot: 150, where: "board", since: 5 },
      { startSlot: 100, newSlot: 160, where: "board", since: 6 },
      { startSlot: 100, newSlot: 170, where: "stored", since: 8 },
      { startSlot: 100, newSlot: 170, where: "job", since: 9 },
    ]);
    // A failed job's slots are no proof; an applied one's are, and the head then shows it applied.
    updateJob(storage, "b", { status: "failed" }, 10, ["proving"]);
    expect(knownProofs(storage, "first-to-second")).toHaveLength(3);
    insertJob(storage, { id: "c", direction: "first-to-second", now: 11 });
    updateJob(storage, "c", { status: "on-chain", startSlot: "170", newSlot: "190" }, 12, ["queued"]);
    expect(knownProofs(storage, "first-to-second").at(-1)).toEqual({ startSlot: 170, newSlot: 190, where: "job", since: 12 });
  });

  it("the furthest proof wins, the board over a stored copy; the head past it makes it applied", () => {
    expect(furthestProof([], 1)).toBeNull();
    const proofs = [
      { startSlot: 100, newSlot: 170, where: "job" as const, since: 9 },
      { startSlot: 100, newSlot: 170, where: "stored" as const, since: 8 },
      { startSlot: 100, newSlot: 150, where: "board" as const, since: 5 },
    ];
    expect(furthestProof(proofs, 100)).toEqual({ startSlot: 100, newSlot: 170, where: "stored", since: 8 });
    expect(furthestProof([...proofs, { startSlot: 100, newSlot: 170, where: "board", since: 10 }], null)).toEqual({ startSlot: 100, newSlot: 170, where: "board", since: 10 });
    expect(furthestProof([{ startSlot: 100, newSlot: 170, where: "job", since: 9 }], 100)?.where).toBe("stored");
    expect(furthestProof(proofs, 170)?.where).toBe("applied");
  });
});

describe("the rule of a direction (2026-11-07)", () => {
  it("the interval, the lookahead, the margin as a number and the proof cost as text, and whether fees can be priced", () => {
    const resolved = { minIntervalSeconds: 3600, lookaheadSeconds: 768, marginWad: 1_500_000_000_000_000_000n };
    expect(pipelineRuleOf(resolved, false)).toEqual(rule);
    expect(pipelineRuleOf({ ...resolved, minIntervalSeconds: 0, marginWad: 10n ** 18n }, true)).toEqual({ ...rule, minIntervalSeconds: 0, profitMargin: 1, priced: true });
    expect(buildPipeline(base).rule).toBe(rule);
  });
});

describe("the pipeline of a direction (2026-11-01)", () => {
  it("an idle direction: nothing waits, nothing runs", () => {
    expect(buildPipeline(base)).toEqual({ direction: "first-to-second", now: NOW, rule, batch: null, job: null, latestJob: null, latestProof: null, head: null, decision: null });
  });

  it("a batch that waits, with its count, trigger, expected time and fallback (the wire keeps max-wait and fallbackAt)", () => {
    const batch = { messages: 2, feesUsd: "0.01", costUsd: "0.05", unknownWhy: null, oldestFinalAt: 10, startAt: 20, startWhy: "interval" as const, dueAt: 20, lastProofAt: 5 };
    const waiting = decision({ why: "min-interval", detail: "2 messages wait", batch });
    expect(buildPipeline({ ...base, decision: waiting }).batch).toEqual({ count: 2, oldestFinalAt: 10, trigger: "max-wait", eta: 20, fallbackAt: 20, feesUsd: "0.01", costUsd: "0.05", detail: "2 messages wait" });
    const paying = decision({ why: "min-interval", detail: "2 messages wait", batch: { ...batch, startWhy: "profit", startAt: 15 } });
    expect(buildPipeline({ ...base, decision: paying }).batch).toMatchObject({ trigger: "profit", eta: 15, fallbackAt: 20 });
    expect(buildPipeline({ ...base, decision: decision({ why: "min-interval" }) }).batch).toBeNull();
    expect(buildPipeline({ ...base, decision: decision() }).batch).toBeNull();
  });

  it("a running job with its step and elapsed time, the newest job, and the light client head", () => {
    const pipeline = buildPipeline({
      ...base,
      activeJob: job(),
      latestJob: job(),
      workerWarm: true,
      estimates: { ...NO_ESTIMATES, totalMs: 100_000 },
      head: { chainId: 369, trackedChainId: 1, storedHeadSlot: 100, finalizedSlot: 230, lastUpdateTimestamp: 1_900, lagSeconds: 1_400 },
      proofs: [{ startSlot: 100, newSlot: 200, where: "board", since: 5 }],
    });
    expect(pipeline.job).toEqual({ jobId: "j", status: "proving", step: "gpu-proving", startedAt: NOW - 30_000, elapsedMs: 30_000, eta: NOW + 70_000, detail: "a warm-up made a worker ready before the job" });
    expect(pipeline.latestJob).toEqual({ jobId: "j", status: "proving", createdAt: NOW - 30_000, updatedAt: NOW - 30_000, startSlot: null, newSlot: null, error: null });
    expect(pipeline.head).toEqual({ slot: 100, finalizedSlot: 230, lastUpdateAt: 1_900_000, lagSeconds: 1_400 });
    expect(pipeline.latestProof).toEqual({ startSlot: 100, newSlot: 200, where: "board", since: 5 });
    const bare = buildPipeline({ ...base, activeJob: job({ status: "queued" }), head: { chainId: 369, trackedChainId: 1, storedHeadSlot: null } });
    expect(bare.job).not.toHaveProperty("eta");
    expect(bare.head).toEqual({ slot: null, finalizedSlot: null, lastUpdateAt: null, lagSeconds: null });
  });
});
