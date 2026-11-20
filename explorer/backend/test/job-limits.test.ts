/**
 * The job limits of 2026-11-07 (owner: "yes to the job limit changes"): one job per new finality and direction, the
 * epochs of a day as the backstop, a daily GPU budget per direction, and the urgent reasons of a request (a user's
 * request, and the watcher's deposits-locked) that the minimum interval never holds back.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_RATE_LIMITS } from "../src/requests/rate-limit.ts";
import { finishStepJob, insertStepJob, UP_TO_DATE_REASON } from "../src/steps/store.ts";
import { insertJob, lastJobTargetSlot, recentJobSeconds, updateJob } from "../src/requests/jobs.ts";
import { createRequestService, type RequestServiceInput } from "../src/requests/service.ts";
import { recordProveTiming } from "../src/requests/timings.ts";
import { start as startRequests } from "../src/requests/module.ts";
import { openStorage, type Storage } from "../src/storage.ts";
import type { BillingSnapshot } from "../src/billing.ts";
import { fakeProofNeed, makeBackend, makeClock, makeConfig, memoryLogger, postFrom, controllableProver, seeFinality } from "./support.ts";

const HOUR = 3_600_000;

function build(overrides: Partial<RequestServiceInput> = {}, need = fakeProofNeed()) {
  const storage = overrides.storage ?? openStorage(":memory:");
  const clock = makeClock(100 * HOUR);
  const prover = controllableProver();
  const log = memoryLogger();
  const service = createRequestService({ storage, proverForJob: () => prover.binary, readProofNeed: need.read, now: clock.now, limits: DEFAULT_RATE_LIMITS, proverTimeoutMilliseconds: 1_800_000, logger: log.logger, ...overrides });
  const named = (name: string) => log.lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.event === name);
  return { storage, clock, prover, service, named, need };
}

/** A proof of the direction that ran `seconds` on the worker and came back at `provedAt`. */
function provedJob(storage: Storage, id: string, provedAt: number, seconds: number, direction: "first-to-second" | "second-to-first" = "first-to-second"): void {
  recordProveTiming(storage, { jobId: id, direction, startedAt: provedAt - seconds * 1000, provedAt, timing: { worker_total_ms: seconds * 1000 } });
}

const base = { pair: "eth-pls", direction: "first-to-second" as const };

describe("the urgent reasons of a request", () => {
  it("a deposits-locked request of the watcher starts a job though the indexer shows no need, and says why", async () => {
    const run = build({}, fakeProofNeed({ needed: false }));
    // From outside the reason is never `finality`: the flag does nothing there.
    expect(await run.service.submit({ ...base, caller: "203.0.113.9", reason: "user", urgent: "deposits-locked" })).toEqual({ refused: "nothing-to-prove", why: "no-need" });
    const started = await run.service.submit({ ...base, caller: "watch", reason: "finality", urgent: "deposits-locked", target: { startSlot: 100, newSlot: 200 } });
    expect(started).toMatchObject({ jobId: expect.any(String) });
    expect(run.named("job_started")).toMatchObject([{ why: "deposits-locked", reason: "finality", urgent: ["deposits-locked"] }]);
  });

  it("a user's request is logged as requested; a plain watcher request names no urgent reason", async () => {
    const run = build();
    await run.service.submit({ ...base, caller: "203.0.113.9", reason: "user" });
    expect(run.named("job_started")).toMatchObject([{ reason: "user", urgent: ["requested"] }]);
    const other = build();
    await other.service.submit({ ...base, caller: "watch", reason: "finality", target: { startSlot: 1, newSlot: 2 } });
    expect(other.named("job_started")[0]).not.toHaveProperty("urgent");
  });

  it("a request that joins the running job says so", async () => {
    const run = build();
    const first = await run.service.submit({ ...base, caller: "a", reason: "user" });
    expect(first).not.toHaveProperty("joined");
    expect(await run.service.submit({ ...base, caller: "b", reason: "user" })).toEqual({ requestId: expect.any(String), jobId: (first as { jobId: string }).jobId, joined: true });
  });

  it("requested: POST /requests proves under watch.minIntervalSeconds 3600 when the finality is new and there is a need", async () => {
    // Owner: "if a user requests a proof then it should be given one if the finality is new".
    const backend = makeBackend({ config: makeConfig({ watch: { pairs: { "eth-pls": { minIntervalSeconds: 3600 } } } }) });
    // The last proof started ten minutes ago, to the finality at slot 200.
    insertJob(backend.storage, { id: "ten-minutes-ago", direction: "first-to-second", now: backend.clock.now(), target: { startSlot: 100, newSlot: 200 } });
    updateJob(backend.storage, "ten-minutes-ago", { status: "on-chain", startSlot: "100", newSlot: "200" }, backend.clock.now(), ["queued"]);
    backend.clock.advance(10 * 60_000);
    seeFinality(backend.context, "first-to-second", 232, backend.clock.now(), 200);
    const { init, env } = postFrom("203.0.113.9");
    const answer = await backend.app.request("/requests", init, env);
    expect(answer.status).toBe(202);
    expect(backend.log.lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line.event === "job_started")).toMatchObject({ reason: "user", urgent: ["requested"] });
  });
});

describe("one job per new finality", () => {
  it("knows the newest finality a job proves to: the slot the prover reported, else the planned one; a failed job does not count", () => {
    const storage = openStorage(":memory:");
    expect(lastJobTargetSlot(storage, "first-to-second")).toBeNull();
    insertJob(storage, { id: "up-to-date", direction: "first-to-second", now: 1 });
    updateJob(storage, "up-to-date", { status: "on-chain" }, 1, ["queued"]);
    expect(lastJobTargetSlot(storage, "first-to-second")).toBeNull();
    insertJob(storage, { id: "planned", direction: "first-to-second", now: 2, target: { startSlot: 10, newSlot: 64 } });
    expect(lastJobTargetSlot(storage, "first-to-second")).toBe(64);
    updateJob(storage, "planned", { status: "on-chain" }, 2, ["queued"]);
    // A request from outside: the prover went further than any plan.
    insertJob(storage, { id: "outside", direction: "first-to-second", now: 3 });
    updateJob(storage, "outside", { status: "proving", startSlot: "10", newSlot: "96" }, 3, ["queued"]);
    expect(lastJobTargetSlot(storage, "first-to-second")).toBe(96);
    updateJob(storage, "outside", { status: "failed" }, 4, ["proving"]);
    expect(lastJobTargetSlot(storage, "first-to-second")).toBe(64);
    expect(lastJobTargetSlot(storage, "second-to-first")).toBeNull();
  });

  it("refuses a watcher request for a finality a job already proves to as a duplicate", async () => {
    const run = build();
    await run.service.submit({ ...base, caller: "watch", reason: "finality", target: { startSlot: 100, newSlot: 200 } });
    run.prover.settleAll({ kind: "up-to-date" });
    await run.service.settled();
    expect(await run.service.submit({ ...base, caller: "watch", reason: "finality", plannedHandoff: true, target: { startSlot: 150, newSlot: 200 } })).toEqual({ refused: "duplicate" });
    expect(await run.service.submit({ ...base, caller: "watch", reason: "finality", target: { startSlot: 150, newSlot: 232 } })).toMatchObject({ jobId: expect.any(String) });
  });

  it("caps a day at the epochs of the source chain unless the configuration sets a backstop", async () => {
    const fill = (storage: Storage, count: number) => {
      for (let index = 0; index < count; index += 1) {
        insertJob(storage, { id: `job-${index}`, direction: "first-to-second", now: 100 * HOUR - HOUR + index, target: { startSlot: index, newSlot: index + 1 } });
        storage.database.prepare("UPDATE jobs SET status = 'published', new_slot = planned_new_slot").run();
      }
    };
    const twelve = build();
    fill(twelve.storage, 225);
    expect(await twelve.service.submit({ ...base, caller: "a", reason: "user" })).toMatchObject({ refused: "rate-limited", why: "limit" });
    const ten = build({ jobsPerDayOf: () => 270 });
    fill(ten.storage, 225);
    expect(await ten.service.submit({ ...base, caller: "a", reason: "user" })).toMatchObject({ jobId: expect.any(String) });
    const set = build({ jobsPerDayOf: () => 270, limits: { ...DEFAULT_RATE_LIMITS, jobsPerDirectionPerDay: 3 } });
    fill(set.storage, 3);
    expect(await set.service.submit({ ...base, caller: "a", reason: "user" })).toMatchObject({ refused: "rate-limited", why: "limit" });
  });
});

describe("the daily GPU budget per direction", () => {
  it("prices the worker seconds of each proved job, and the wait for a cold worker", () => {
    const storage = openStorage(":memory:");
    recordProveTiming(storage, { jobId: "worker", direction: "first-to-second", startedAt: 0, provedAt: 100_000, timing: { worker_total_ms: 50_000, remote_ms: 60_000 } });
    recordProveTiming(storage, { jobId: "remote", direction: "first-to-second", startedAt: 0, provedAt: 100_000, timing: { remote_ms: 60_000, not_ready_count: 2, wait_worker_ms: 30_000 } });
    recordProveTiming(storage, { jobId: "old-prover", direction: "first-to-second", startedAt: 20_000, provedAt: 100_000, timing: { not_ready_count: 1 } });
    recordProveTiming(storage, { jobId: "other", direction: "second-to-first", startedAt: 0, provedAt: 100_000, timing: null });
    storage.database.prepare("INSERT INTO job_timings (job_id, direction, proved_at) VALUES ('no-start', 'first-to-second', 100000)").run();
    expect(recentJobSeconds(storage, "first-to-second", 0).map((job) => job.seconds).sort((a, b) => a - b)).toEqual([0, 50, 80, 90]);
    expect(recentJobSeconds(storage, "first-to-second", 100_000)).toEqual([]);
  });

  it("charges a failed job from its creation to its failure, once, and leaves a failure before the window out", () => {
    const storage = openStorage(":memory:");
    const fail = (id: string, direction: "first-to-second" | "second-to-first", createdAt: number, failedAt: number) => {
      insertJob(storage, { id, direction, now: createdAt });
      updateJob(storage, id, { status: "proving" }, createdAt + 1000, ["queued"]);
      updateJob(storage, id, { status: "failed", error: "the prover ran longer than its limit" }, failedAt, ["proving"]);
    };
    fail("timed-out", "first-to-second", 10_000, 1_810_000);
    fail("other", "second-to-first", 10_000, 1_810_000);
    fail("old", "first-to-second", 0, 5_000);
    // A job that proved and then failed at the board is already priced by its timing row.
    fail("posted", "first-to-second", 10_000, 500_000);
    provedJob(storage, "posted", 400_000, 300);
    expect(recentJobSeconds(storage, "first-to-second", 6_000)).toEqual([{ provedAt: 400_000, seconds: 300 }, { provedAt: 1_810_000, seconds: 1800 }]);
  });

  it("charges a failed fork-registry step job from its start to its failure, to its direction, and not an up-to-date one", () => {
    const storage = openStorage(":memory:");
    const step = (id: string, direction: "first-to-second" | "second-to-first" | undefined, startedAt: number, failedAt: number, error: string, kind: "registry-light-client-update" | "deliver" = "registry-light-client-update") => {
      insertStepJob(storage, { id, kind, subject: id, at: startedAt, startSlot: null, ...(direction === undefined ? {} : { direction }) });
      finishStepJob(storage, { id, at: failedAt, error });
    };
    step("step:failed", "first-to-second", 10_000, 700_000, "the prover stopped");
    step("step:other-direction", "second-to-first", 10_000, 700_000, "the prover stopped");
    step("step:old", "first-to-second", 0, 5_000, "the prover stopped");
    step("step:no-gpu", undefined, 10_000, 700_000, "the prover stopped", "deliver");
    step("step:up-to-date", "first-to-second", 10_000, 700_000, UP_TO_DATE_REASON);
    insertStepJob(storage, { id: "step:running", kind: "registry-light-client-update", subject: "running", at: 10_000, startSlot: null, direction: "first-to-second" });
    // A step that proved and then failed is priced by its timing row, once.
    step("step:proved", "first-to-second", 10_000, 800_000, "the result could not be stored");
    recordProveTiming(storage, { jobId: "registry-proved", direction: "first-to-second", startedAt: 10_000, provedAt: 600_000, timing: { worker_total_ms: 120_000 } });
    expect(recentJobSeconds(storage, "first-to-second", 6_000)).toEqual([{ provedAt: 600_000, seconds: 120 }, { provedAt: 700_000, seconds: 690 }]);
  });

  it("waits for the budget after failed jobs alone have spent it", async () => {
    const run = build();
    const now = run.clock.now();
    // Two hours of failed proving at $2.25 and then a bit: $5.04 against the $5.00 budget, and no proof came back.
    for (const [id, seconds] of [["a", 3600], ["b", 3600 + 864]] as const) {
      insertJob(run.storage, { id, direction: "first-to-second", now: now - 10 * HOUR });
      updateJob(run.storage, id, { status: "proving" }, now - 10 * HOUR, ["queued"]);
      updateJob(run.storage, id, { status: "failed", error: "the prover failed" }, now - 10 * HOUR + seconds * 1000, ["proving"]);
    }
    expect(await run.service.submit({ ...base, caller: "a", reason: "user" })).toMatchObject({ refused: "rate-limited", why: "gpu-budget" });
  });

  it("refuses a job once the direction's spend in 24 h reaches the budget, says by how much, and logs it", async () => {
    const run = build();
    const now = run.clock.now();
    // Two hours and a bit at $2.25: $5.04 against the $5.00 budget.
    provedJob(run.storage, "a", now - 20 * HOUR, 3600);
    provedJob(run.storage, "b", now - 10 * HOUR, 4464);
    provedJob(run.storage, "c", now - 25 * HOUR, 3600);
    const refused = await run.service.submit({ ...base, caller: "a", reason: "user" });
    expect(refused).toEqual({ refused: "rate-limited", why: "gpu-budget", retryAfterSeconds: 4 * 3600, detail: "the 24 h GPU budget of $5.00 for first-to-second is spent: $5.04" });
    expect(run.named("gpu_budget_spent")).toMatchObject([{ level: "warn", direction: "first-to-second", budgetUsd: 5, spentUsd: 5.04, usdPerHour: 2.25, retryAfterSeconds: 14_400 }]);
    // The other direction has its own budget.
    expect(await run.service.submit({ ...base, direction: "second-to-first", caller: "b", reason: "user" })).toMatchObject({ jobId: expect.any(String) });
  });

  it("uses the measured rate, and lets a liveness proof past a spent budget with a log line", async () => {
    const run = build({ readUsdPerHour: async () => 10 }, fakeProofNeed({ needed: false }));
    provedJob(run.storage, "a", run.clock.now() - HOUR, 1800);
    // A planned handoff keeps the light client alive: it goes past the budget.
    expect(await run.service.submit({ ...base, caller: "watch", reason: "finality", plannedHandoff: true, target: { startSlot: 1, newSlot: 2 } })).toMatchObject({ jobId: expect.any(String) });
    expect(run.named("gpu_budget_bypassed")).toMatchObject([{ spentUsd: 5, usdPerHour: 10, detail: "the 24 h GPU budget of $5.00 for first-to-second is spent: $5.00" }]);
    // A deposits-locked proof does not.
    run.prover.settleAll({ kind: "up-to-date" });
    await run.service.settled();
    expect(await run.service.submit({ ...base, caller: "watch", reason: "finality", urgent: "deposits-locked", target: { startSlot: 2, newSlot: 3 } })).toMatchObject({ refused: "rate-limited", why: "gpu-budget" });
  });
});

describe("a companion proof of the watcher (2026-11-19, one GPU session for both directions)", () => {
  it("takes a keep-alive companion past the indexer's age rule, only from the watcher, and logs it as a companion", async () => {
    // The watcher found the keep-alive due within the minimum interval: the indexer's age rule does not call for it yet.
    const run = build({}, fakeProofNeed({ needed: false }));
    expect(await run.service.submit({ ...base, caller: "203.0.113.9", reason: "user", companion: "keep-alive" })).toEqual({ refused: "nothing-to-prove", why: "no-need" });
    // A message companion meets the indexer's need like any message proof.
    expect(await run.service.submit({ ...base, caller: "watch", reason: "finality", companion: "messages", target: { startSlot: 1, newSlot: 2 } })).toEqual({ refused: "nothing-to-prove", why: "no-need" });
    const started = await run.service.submit({ ...base, caller: "watch", reason: "finality", companion: "keep-alive", target: { startSlot: 1, newSlot: 2 } });
    expect(started).toMatchObject({ jobId: expect.any(String) });
    expect(run.named("job_started")).toMatchObject([{ why: "keep-alive", reason: "finality", companion: "keep-alive" }]);
  });

  it("never lets a companion past a spent GPU budget, not even a keep-alive", async () => {
    const run = build({ readUsdPerHour: async () => 10 }, fakeProofNeed({ needed: true, why: "keep-alive" }));
    provedJob(run.storage, "a", run.clock.now() - HOUR, 1800);
    expect(await run.service.submit({ ...base, caller: "watch", reason: "finality", companion: "keep-alive", target: { startSlot: 1, newSlot: 2 } })).toMatchObject({ refused: "rate-limited", why: "gpu-budget" });
    expect(run.named("gpu_budget_bypassed")).toEqual([]);
    expect(run.named("gpu_budget_spent")).toMatchObject([{ direction: "first-to-second" }]);
  });
});

describe("the GPU budget and an unpriced tip at the automatic maximum (review, 2026-11-10)", () => {
  it("refuses the finality proof of a message that pays only by its unpriced 1% tip once the budget is spent: no liveness bypass", async () => {
    // A worthless token can carry a 1% tip, and such a tip counts as paying (owner: "yes, deliver straight away"), so
    // its batch proves at finality. The watcher asks as for any waiting message (see watch-watcher.test.ts), and the
    // indexer reports a waiting message: the $5 a day of the direction bounds what such messages cost.
    const run = build({}, fakeProofNeed({ needed: true, why: "waiting-message" }));
    provedJob(run.storage, "a", run.clock.now() - HOUR, 8000);
    const request = { ...base, caller: "watch", reason: "finality" as const, messageId: `0x${"aa".repeat(32)}` as `0x${string}`, target: { startSlot: 1, newSlot: 2 } };
    expect(await run.service.submit(request)).toMatchObject({ refused: "rate-limited", why: "gpu-budget" });
    expect(run.named("gpu_budget_bypassed")).toEqual([]);
    expect(run.named("gpu_budget_spent")).toHaveLength(1);
    expect(run.named("job_started")).toEqual([]);
  });
});

describe("the requests module and the job limits", () => {
  const snapshot = (amountUsd: number, at: number): BillingSnapshot => ({ spend: { days: [{ start: new Date(at).toISOString().slice(0, 10), amountUsd }], hours: [], readAt: at }, balance: null });

  it("prices the budget at the configured price, whatever dollars RunPod's billing shows (it gives no billed time to measure a rate from)", async () => {
    const backend = makeBackend();
    const now = backend.clock.now();
    provedJob(backend.storage, "a", now - HOUR, 3600);
    // RunPod's billing shows $6 for the day, but the hour of proving is priced at the configured $2.25 an hour, under the $5 budget.
    const billed = { ...backend.context, billing: { read: async () => snapshot(6, now) } };
    const app = (await import("../src/app.ts")).createApp({ context: billed, modules: (await import("../src/main.ts")).MODULES, enabled: ["requests"] });
    const { init, env } = postFrom("203.0.113.9");
    expect((await app.request("/requests", init, env)).status).toBe(202);
  });

  it("caps a day at the source chain's epochs: 225 from Ethereum, 270 from PulseChain", async () => {
    const backend = makeBackend();
    for (let index = 0; index < 225; index += 1) {
      for (const direction of ["first-to-second", "second-to-first"] as const) insertJob(backend.storage, { id: `${direction}-${index}`, direction, now: backend.clock.now() - 1000 + index, target: { startSlot: index, newSlot: index + 1 } });
      backend.storage.database.prepare("UPDATE jobs SET status = 'published', new_slot = planned_new_slot").run();
    }
    const post = (direction: string, caller: string) => {
      const { init, env } = postFrom(caller, { direction });
      return backend.app.request("/requests", init, env);
    };
    expect((await post("first-to-second", "203.0.113.1")).status).toBe(429);
    expect((await post("second-to-first", "203.0.113.2")).status).toBe(202);
  });

  it("loads a file that still sets secondsBetweenJobsPerDirection, ignores it and says so", async () => {
    const config = makeConfig({ limits: { secondsBetweenJobsPerDirection: 120 }, watch: { enabled: false } });
    expect(config.limits.secondsBetweenJobsPerDirection).toBe(120);
    const backend = makeBackend({ config });
    const stop = await startRequests(backend.context);
    await stop();
    const lines = backend.log.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.filter((line) => line.event === "config_deprecated")).toMatchObject([{ level: "warn", key: "limits.secondsBetweenJobsPerDirection" }]);
    const clean = makeBackend({ config: makeConfig({ watch: { enabled: false } }) });
    await (await startRequests(clean.context))();
    expect(clean.log.lines.some((line) => line.includes("config_deprecated"))).toBe(false);
  });
});
