// The step service: one way to ask for the proof of any route step, under the guards that already exist.
import { describe, expect, it } from "vitest";
import { ProverCommandError, CommandTimeoutError } from "@zk-bridge/shared/prover";
import type { RequestService } from "../src/requests/service.ts";
import { insertJob, insertRequest } from "../src/requests/jobs.ts";
import { DEFAULT_RATE_LIMITS } from "../src/requests/rate-limit.ts";
import { recordProveTiming } from "../src/requests/timings.ts";
import { insertObservationAttempt, storeObservationProof } from "../src/seal/observations.ts";
import { createStepService, describeFailure, directionFrom, heldLightClientProof, opposite, registrySideOf, type StepServiceInput } from "../src/steps/service.ts";
import { finishStepJob, insertStepJob, insertStepRequest, latestStepJob, pruneStepRequests } from "../src/steps/store.ts";
import { openStorage } from "../src/storage.ts";
import { makeClock, memoryLogger, PAIR } from "./support.ts";
import { evidenceText, fakeArchive, fakeChain, MESSAGE, observationPackage, openingPackage, registryAt, registryProof, registryState, REGISTRY_PAIR, stepProvers, V1, V2 } from "./steps-support.ts";

/** 22.75 h after slot 1000 of the registry's clock, in ms: one period past the head. */
const PERIOD_LATER = (1_000 + 8_192) * 10_000;

function setup(options: { now?: number; requestService?: RequestService | null; withProvers?: boolean; archive?: boolean; usdPerHour?: number; limits?: Partial<typeof DEFAULT_RATE_LIMITS> } = {}) {
  const storage = openStorage(":memory:");
  const clock = makeClock(options.now ?? PERIOD_LATER);
  const log = memoryLogger();
  const chain = fakeChain();
  const provers = stepProvers();
  const archive = fakeArchive();
  const withProvers = options.withProvers ?? true;
  const input: StepServiceInput = {
    storage,
    pair: REGISTRY_PAIR,
    now: clock.now,
    logger: log.logger,
    limits: { ...DEFAULT_RATE_LIMITS, ...options.limits },
    proverTimeoutMilliseconds: 1_800_000,
    requestService: () => options.requestService ?? null,
    ...(withProvers ? { headProver: provers.headProver, observationProver: provers.observationProver, openingProver: provers.openingProver } : {}),
    archive: () => (options.archive === false ? null : archive.archive),
    chain: chain.reads,
    readUsdPerHour: async () => options.usdPerHour ?? 2,
    observationLimits: { retryMinutes: 60, maxProofsPerVersionPerDay: 4 },
    gpuEstimate: () => ({ warmMs: 60_000, coldMs: 240_000, workerWarm: false }),
  };
  const service = createStepService(input);
  const ask = (kind: Parameters<typeof service.submit>[0]["kind"], subject: string, extra: { caller?: string; liveness?: boolean } = {}) =>
    service.submit({ kind, subject, caller: extra.caller ?? "10.0.0.1", pair: "eth-pls", ...(extra.liveness === undefined ? {} : { liveness: extra.liveness }) });
  return { storage, clock, log, chain, provers, archive, service, ask };
}

/** Spends the GPU budget of a direction: 10 hours at $2 against the $5 default. */
const spendBudget = (storage: ReturnType<typeof openStorage>, direction: "first-to-second" | "second-to-first", at: number) =>
  recordProveTiming(storage, { jobId: `spent-${direction}`, direction, startedAt: at - 1000, provedAt: at - 1000, timing: { worker_total_ms: 36_000_000 } as never });

describe("helpers", () => {
  it("names failures safely and finds the sides", () => {
    expect(describeFailure(new ProverCommandError("prove", 2, "secret path"))).toBe("the prover stopped with exit code 2");
    expect(describeFailure(new CommandTimeoutError("late"))).toBe("the prover ran longer than its limit");
    expect(describeFailure(new Error("x"))).toBe("the prover could not make a proof");
    expect(directionFrom(PAIR, PAIR.sides[1])).toBe("second-to-first");
    expect(directionFrom(PAIR, PAIR.sides[0])).toBe("first-to-second");
    expect(opposite("second-to-first")).toBe("first-to-second");
    expect(opposite("first-to-second")).toBe("second-to-first");
    expect(registrySideOf(REGISTRY_PAIR, "369")?.chainId).toBe(369);
    expect(registrySideOf(REGISTRY_PAIR, "1")).toBeNull();
  });

  it("keeps the step requests and prunes old ones", () => {
    const storage = openStorage(":memory:");
    insertStepRequest(storage, { id: "a", jobId: "j", caller: "c", at: 1 });
    insertStepRequest(storage, { id: "b", jobId: "j", caller: "c", at: 100 });
    expect(pruneStepRequests(storage, 50)).toBe(1);
  });

  it("finds the light client proof that reaches furthest, at the webhook or on the board", () => {
    const storage = openStorage(":memory:");
    expect(heldLightClientProof(storage, "first-to-second")).toBeNull();
    storage.database.prepare("INSERT INTO proofs (direction, job_id, start_slot, new_slot, body, stored_at) VALUES (?, NULL, ?, ?, ?, ?)").run("first-to-second", "10", "20", JSON.stringify({ pair: "eth-pls", payload: "0xb0a2d" }), 5);
    expect(heldLightClientProof(storage, "first-to-second")).toEqual({ payload: "0xb0a2d", startSlot: 10, newSlot: 20, at: 5, where: "board", jobId: null });
    storage.database.exec("CREATE TABLE webhook_proofs (job_id TEXT PRIMARY KEY, direction TEXT NOT NULL, payload TEXT NOT NULL, start_slot TEXT NOT NULL, new_slot TEXT NOT NULL, stored_at INTEGER NOT NULL, posted_at INTEGER)");
    storage.database.prepare("INSERT INTO webhook_proofs (job_id, direction, payload, start_slot, new_slot, stored_at) VALUES ('j9', 'first-to-second', '0x5704ed', '20', '30', 7)").run();
    storage.database.prepare("INSERT INTO webhook_proofs (job_id, direction, payload, start_slot, new_slot, stored_at, posted_at) VALUES ('j8', 'first-to-second', '0x01d', '5', '15', 3, 4)").run();
    expect(heldLightClientProof(storage, "first-to-second")).toEqual({ payload: "0x5704ed", startSlot: 20, newSlot: 30, at: 7, where: "stored", jobId: "j9" });
  });
});

describe("the caller limit", () => {
  it("counts the requests of both routes together, and the backend's own requests not at all", async () => {
    const { ask, storage, clock, archive } = setup({ limits: { requestsPerCallerPerMinute: 2 } });
    archive.evidence.set(MESSAGE, evidenceText());
    insertJob(storage, { id: "j1", direction: "first-to-second", now: clock.now() });
    insertRequest(storage, { id: "r1", jobId: "j1", pair: "eth-pls", direction: "first-to-second", reason: "user", messageId: null, caller: "10.0.0.1", now: clock.now() - 30_000 });
    insertStepRequest(storage, { id: "s1", jobId: "x", caller: "10.0.0.1", at: clock.now() - 10_000 });
    expect(await ask("deliver", MESSAGE)).toEqual({ refused: "rate-limited", retryAfterSeconds: 30, why: "limit" });
    expect(await ask("deliver", MESSAGE, { caller: "unknown" })).toMatchObject({ ready: true });
    expect(await ask("deliver", MESSAGE, { liveness: true })).toMatchObject({ ready: true });
  });

  it("refuses a kind it does not know", async () => {
    const { service } = setup();
    expect(await service.submit({ kind: "seal" as never, subject: "369", caller: "c", pair: "eth-pls" })).toEqual({ invalid: "unknown kind seal" });
  });
});

describe("a light client update", () => {
  it("goes through the request service and names its job", async () => {
    const answers: Array<Awaited<ReturnType<RequestService["submit"]>>> = [
      { requestId: "r", jobId: "j1" },
      { requestId: "r", jobId: "j1", joined: true },
      { refused: "duplicate" },
      { refused: "rate-limited", retryAfterSeconds: 9, why: "same-finality" },
    ];
    const seen: unknown[] = [];
    const requestService = { submit: async (request: unknown) => (seen.push(request), answers.shift()) } as unknown as RequestService;
    const { ask } = setup({ requestService });
    expect(await ask("light-client-update", "first-to-second")).toEqual({ jobId: "job:j1" });
    expect(seen[0]).toEqual({ pair: "eth-pls", direction: "first-to-second", reason: "user", caller: "10.0.0.1" });
    expect(await ask("light-client-update", "first-to-second")).toEqual({ jobId: "job:j1", joined: true });
    expect(await ask("light-client-update", "first-to-second")).toEqual({ refused: "nothing-to-prove", why: "proof-pending" });
    expect(await ask("light-client-update", "first-to-second")).toEqual({ refused: "rate-limited", retryAfterSeconds: 9, why: "same-finality" });
    expect(await ask("light-client-update", "sideways")).toEqual({ invalid: "the subject of a light client update is a direction" });
  });

  it("is not served without the request service", async () => {
    const { ask } = setup();
    expect(await ask("light-client-update", "first-to-second")).toMatchObject({ refused: "not-served" });
  });

  it("shows its job from the jobs table, done once the webhook holds its proof", () => {
    const { service, storage, clock } = setup();
    insertJob(storage, { id: "j1", direction: "first-to-second", now: clock.now() });
    expect(service.job("job:j1")).toMatchObject({ kind: "light-client-update", subject: "first-to-second", status: "queued", etaAt: clock.now() + 240_000 });
    storage.database.prepare("UPDATE jobs SET status = 'proving' WHERE id = 'j1'").run();
    expect(service.job("job:j1")).toMatchObject({ status: "running" });
    storage.database.exec("CREATE TABLE webhook_proofs (job_id TEXT PRIMARY KEY, direction TEXT NOT NULL, payload TEXT NOT NULL, start_slot TEXT NOT NULL, new_slot TEXT NOT NULL, stored_at INTEGER NOT NULL, posted_at INTEGER)");
    expect(service.job("job:j1")).toMatchObject({ status: "running" });
    storage.database.prepare("INSERT INTO webhook_proofs (job_id, direction, payload, start_slot, new_slot, stored_at) VALUES ('j1', 'first-to-second', '0x00', '1', '2', 3)").run();
    expect(service.job("job:j1")).toMatchObject({ status: "done", etaAt: null });
    storage.database.prepare("UPDATE jobs SET status = 'published' WHERE id = 'j1'").run();
    expect(service.job("job:j1")).toMatchObject({ status: "done" });
    storage.database.prepare("UPDATE jobs SET status = 'failed', error = 'the prover stopped' WHERE id = 'j1'").run();
    expect(service.job("job:j1")).toMatchObject({ status: "failed", error: "the prover stopped" });
    expect(service.job("job:none")).toBeNull();
    expect(service.job("other:1")).toBeNull();
  });

  it("serves the proof that reaches furthest, with the posting chain", () => {
    const { service, storage } = setup();
    expect(service.proof("light-client-update", "first-to-second")).toBeNull();
    expect(service.proof("light-client-update", "sideways")).toBeNull();
    storage.database.prepare("INSERT INTO proofs (direction, job_id, start_slot, new_slot, body, stored_at) VALUES (?, NULL, ?, ?, ?, ?)").run("first-to-second", "10", "20", JSON.stringify({ pair: "eth-pls", payload: "0xb0a2d" }), 5);
    expect(service.proof("light-client-update", "first-to-second")).toEqual({ kind: "light-client-update", subject: "first-to-second", chainId: 369, payload: "0xb0a2d", startSlot: 10, newSlot: 20, provedAt: 5, where: "board" });
  });
});

describe("an update of the fork registry's light client", () => {
  it("proves from the head on the GPU, records the time, and serves the proof", async () => {
    const { ask, provers, service, storage, log } = setup();
    const answer = await ask("registry-light-client-update", "369");
    expect(answer).toMatchObject({ jobId: expect.stringMatching(/^step:/) });
    const jobId = (answer as { jobId: string }).jobId;
    expect(provers.head.calls[0]).toEqual({ direction: "second-to-first", head: registryState().head, programKey: registryState().programKey });
    expect(service.job(jobId)).toMatchObject({ kind: "registry-light-client-update", subject: "369", status: "running", etaAt: expect.any(Number) });
    expect(await ask("registry-light-client-update", "369")).toEqual({ jobId, joined: true });
    provers.head.settle({ kind: "proof", proofPackage: (registryProof() as unknown as { proofPackage: never }).proofPackage });
    await service.settled();
    expect(service.job(jobId)).toMatchObject({ status: "done", etaAt: null });
    expect(service.proof("registry-light-client-update", "369")).toMatchObject({ kind: "registry-light-client-update", chainId: 369, startSlot: 1_000, newSlot: 1_064, publicValues: "0xabcd", proof: "0x1234", lightClient: "0x5555555555555555555555555555555555555555" });
    expect(storage.database.prepare("SELECT direction FROM job_timings WHERE job_id LIKE 'registry-%'").get()).toEqual({ direction: "second-to-first" });
    expect(await ask("registry-light-client-update", "369")).toEqual({ jobId, ready: true });
    expect(log.lines.join("\n")).toContain("step_job_done");
  });

  it("refuses another chain, needs the head prover, and cannot check a failed read", async () => {
    expect(await setup().ask("registry-light-client-update", "1")).toEqual({ invalid: "chain 1 has no fork registry in this pair" });
    expect(await setup({ withProvers: false }).ask("registry-light-client-update", "369")).toMatchObject({ refused: "not-served" });
    const broken = setup();
    broken.chain.state.registry = new Error("rpc down");
    expect(await broken.ask("registry-light-client-update", "369")).toEqual({ refused: "cannot-check", retryAfterSeconds: 30 });
  });

  it("finds nothing to prove for a head younger than two epochs, unless the backend asks", async () => {
    const fresh = setup({ now: 1_000 * 10_000 + 60_000 });
    expect(await fresh.ask("registry-light-client-update", "369")).toEqual({ refused: "nothing-to-prove", why: "no-need" });
    expect(await fresh.ask("registry-light-client-update", "369", { liveness: true })).toMatchObject({ jobId: expect.any(String) });
  });

  it("waits after a failure, and fails a job for an up-to-date head or a prover error", async () => {
    const { ask, provers, service } = setup();
    await ask("registry-light-client-update", "369");
    provers.head.settle({ kind: "up-to-date" });
    await service.settled();
    expect(await ask("registry-light-client-update", "369")).toMatchObject({ refused: "rate-limited", why: "limit", retryAfterSeconds: 60 });
    const later = setup();
    const answer = (await later.ask("registry-light-client-update", "369")) as { jobId: string };
    later.provers.head.fail(new ProverCommandError("prove", 1, "boom"));
    await later.service.settled();
    expect(later.service.job(answer.jobId)).toMatchObject({ status: "failed", error: "the prover stopped with exit code 1" });
    later.clock.advance(61_000);
    expect(await later.ask("registry-light-client-update", "369")).toMatchObject({ jobId: expect.any(String) });
  });

  it("keeps to the GPU budget, which the backend's fallback passes", async () => {
    const { ask, storage, clock, log } = setup();
    spendBudget(storage, "second-to-first", clock.now());
    expect(await ask("registry-light-client-update", "369")).toMatchObject({ refused: "rate-limited", why: "gpu-budget", detail: "the 24 h GPU budget of $5.00 for second-to-first is spent: $20.00" });
    expect(await ask("registry-light-client-update", "369", { liveness: true })).toMatchObject({ jobId: expect.any(String) });
    expect(log.lines.join("\n")).toContain("gpu_budget_bypassed");
  });

  it("charges a failed update of the registry's light client to the GPU budget, and then waits", async () => {
    const { ask, provers, service, clock } = setup();
    expect(await ask("registry-light-client-update", "369")).toMatchObject({ jobId: expect.any(String) });
    // Three hours on the GPU at $2 an hour is $6 against the $5 budget, and no proof came back.
    clock.advance(3 * 3_600_000);
    provers.head.fail(new ProverCommandError("prove", 1, "boom"));
    await service.settled();
    clock.advance(61_000);
    expect(await ask("registry-light-client-update", "369")).toMatchObject({ refused: "rate-limited", why: "gpu-budget", detail: "the 24 h GPU budget of $5.00 for second-to-first is spent: $6.00" });
  });

  it("joins the job a concurrent request started", async () => {
    const { ask, storage, clock } = setup();
    // The read of the chain is the await between the check and the insert: another request inserts meanwhile.
    const answer = ask("registry-light-client-update", "369");
    insertStepJob(storage, { id: "step:other", kind: "registry-light-client-update", subject: "369", at: clock.now(), startSlot: 1_000 });
    expect(await answer).toEqual({ jobId: "step:other", joined: true });
  });
});

describe("a fork observation", () => {
  it("proves when the chain runs a version the registry does not hold, and serves the observation", async () => {
    const { ask, provers, service } = setup();
    const answer = (await ask("fork-observation", "369")) as { jobId: string };
    expect(answer.jobId).toMatch(/^observation:/);
    expect(provers.observation.calls[0]).toEqual({ direction: "second-to-first", registry: "0x4444444444444444444444444444444444444444" });
    expect(await ask("fork-observation", "369")).toEqual({ jobId: answer.jobId, joined: true });
    expect(service.job(answer.jobId)).toMatchObject({ kind: "fork-observation", subject: "369", status: "running" });
    provers.observation.settle({ observation: observationPackage(), timing: null });
    await service.settled();
    expect(service.job(answer.jobId)).toMatchObject({ status: "done" });
    expect(service.proof("fork-observation", "369")).toMatchObject({ kind: "fork-observation", observation: { observedVersion: V2 } });
    expect(await ask("fork-observation", "369")).toEqual({ jobId: answer.jobId, ready: true });
    expect(service.proof("fork-observation", "x")).toBeNull();
  });

  it("shows a failed attempt and one of an unknown chain", async () => {
    const { ask, provers, service, storage, clock } = setup();
    const answer = (await ask("fork-observation", "369")) as { jobId: string };
    provers.observation.fail(new Error("no fold"));
    await service.settled();
    expect(service.job(answer.jobId)).toMatchObject({ status: "failed", error: "the prover could not make an observation proof" });
    insertObservationAttempt(storage, { id: "far", chainId: 5, version: V2, why: "first", at: clock.now() });
    expect(service.job("observation:far")).toMatchObject({ subject: "5" });
    expect(service.job("observation:none")).toBeNull();
  });

  it("finds nothing to prove when the registry holds the version, and cannot check a failed read", async () => {
    const { ask, chain } = setup();
    chain.state.facts = { activeVersion: V1, registry: registryAt(V1, 50n) };
    expect(await ask("fork-observation", "369")).toEqual({ refused: "nothing-to-prove", why: "no-need" });
    chain.state.facts = new Error("beacon down");
    expect(await ask("fork-observation", "369")).toEqual({ refused: "cannot-check", retryAfterSeconds: 30 });
  });

  it("refuses a chain without a registry and is not served without a prover", async () => {
    expect(await setup().ask("fork-observation", "1")).toMatchObject({ invalid: expect.any(String) });
    expect(await setup({ withProvers: false }).ask("fork-observation", "369")).toMatchObject({ refused: "not-served" });
  });

  it("keeps the caps of the observations: the tries per day and their spacing", async () => {
    const { ask, storage, clock } = setup();
    insertObservationAttempt(storage, { id: "a1", chainId: 369, version: V2, why: "first", at: clock.now() - 7_200_000 });
    storage.database.prepare("UPDATE fork_observations SET status = 'failed'").run();
    insertObservationAttempt(storage, { id: "a2", chainId: 369, version: V2, why: "first", at: clock.now() - 1_800_000 });
    storage.database.prepare("UPDATE fork_observations SET status = 'failed'").run();
    expect(await ask("fork-observation", "369")).toMatchObject({ refused: "rate-limited", retryAfterSeconds: 1_800, why: "limit" });
    for (const id of ["a3", "a4"]) insertObservationAttempt(storage, { id, chainId: 369, version: V2, why: "first", at: clock.now() - 7_000_000 });
    storage.database.prepare("UPDATE fork_observations SET status = 'failed'").run();
    expect(await ask("fork-observation", "369")).toMatchObject({ refused: "rate-limited", retryAfterSeconds: 3_600, detail: expect.stringContaining("4 observation proofs") });
  });

  it("keeps a first observation to the GPU budget, and lets a new version past it", async () => {
    const first = setup();
    first.chain.state.facts = { activeVersion: V2, registry: registryAt("0x00000000", 0n) };
    spendBudget(first.storage, "second-to-first", first.clock.now());
    expect(await first.ask("fork-observation", "369")).toMatchObject({ refused: "rate-limited", why: "gpu-budget" });
    const fork = setup();
    spendBudget(fork.storage, "second-to-first", fork.clock.now());
    expect(await fork.ask("fork-observation", "369")).toMatchObject({ jobId: expect.any(String) });
    expect(fork.log.lines.join("\n")).toContain("safety: an observation of a new fork version");
  });

  it("does not offer a held proof of another version or one the registry passed", async () => {
    const { ask, storage, clock } = setup();
    insertObservationAttempt(storage, { id: "old", chainId: 369, version: V1, why: "first", at: clock.now() - 90_000_000 });
    storeObservationProof(storage, { id: "old", observation: observationPackage({ observedVersion: V1 }), at: clock.now() - 90_000_000 });
    expect(await ask("fork-observation", "369")).toMatchObject({ jobId: expect.not.stringContaining("old") });
  });
});

describe("opening deposits", () => {
  it("makes the opening proof of the bridge on the destination, from the opposite route", async () => {
    const { ask, provers, service } = setup();
    const answer = (await ask("open-deposits", "second-to-first")) as { jobId: string };
    expect(provers.opening.calls[0]).toEqual({ direction: "first-to-second" });
    expect(await ask("open-deposits", "second-to-first")).toEqual({ jobId: answer.jobId, joined: true });
    provers.opening.settle(openingPackage());
    await service.settled();
    expect(service.job(answer.jobId)).toMatchObject({ kind: "open-deposits", status: "done", etaAt: null });
    expect(service.proof("open-deposits", "second-to-first")).toMatchObject({ kind: "open-deposits", chainId: 1, bridge: "0x1111111111111111111111111111111111111111", calldata: "0xfeed", remoteSlot: 10, storedSlot: 20, remoteBlockNumber: 77 });
    expect(await ask("open-deposits", "second-to-first")).toEqual({ jobId: answer.jobId, ready: true });
  });

  it("finds nothing to prove for an open bridge, cannot check a failed read, and refuses a bad subject", async () => {
    const { ask, chain } = setup();
    chain.state.depositsOpen = true;
    expect(await ask("open-deposits", "second-to-first")).toEqual({ refused: "nothing-to-prove", why: "no-need" });
    chain.state.depositsOpen = new Error("rpc down");
    expect(await ask("open-deposits", "second-to-first")).toEqual({ refused: "cannot-check", retryAfterSeconds: 30 });
    expect(await ask("open-deposits", "369")).toMatchObject({ invalid: expect.any(String) });
    expect(await setup({ withProvers: false }).ask("open-deposits", "second-to-first")).toMatchObject({ refused: "not-served" });
  });

  it("fails a proof for another bridge, a bridge that opened, and a prover error", async () => {
    for (const [settle, error] of [
      [openingPackage({ chainId: 369 }), "the proof is for another bridge"],
      [openingPackage({ to: "0x9999999999999999999999999999999999999999" }), "the proof is for another bridge"],
      [openingPackage({ depositsOpen: true }), "the bridge takes deposits already"],
    ] as const) {
      const { ask, provers, service } = setup();
      const answer = (await ask("open-deposits", "second-to-first")) as { jobId: string };
      provers.opening.settle(settle);
      await service.settled();
      expect(service.job(answer.jobId)).toMatchObject({ status: "failed", error });
    }
    const broken = setup();
    const answer = (await broken.ask("open-deposits", "second-to-first")) as { jobId: string };
    broken.provers.opening.fail(new CommandTimeoutError("late"));
    await broken.service.settled();
    expect(broken.service.job(answer.jobId)).toMatchObject({ error: "the prover ran longer than its limit" });
    expect(await broken.ask("open-deposits", "second-to-first")).toMatchObject({ refused: "rate-limited" });
  });

  it("offers a made proof for ten minutes, then makes a new one", async () => {
    const { ask, storage, clock } = setup();
    insertStepJob(storage, { id: "step:old", kind: "open-deposits", subject: "second-to-first", at: clock.now() - 700_000, startSlot: null });
    finishStepJob(storage, { id: "step:old", at: clock.now() - 700_000, result: "{}" });
    expect(await ask("open-deposits", "second-to-first")).toMatchObject({ jobId: expect.not.stringMatching("step:old") });
  });
});

describe("the evidence of a delivery", () => {
  it("is ready when the archive holds it, and serves it", async () => {
    const { ask, archive, service } = setup();
    archive.evidence.set(MESSAGE, evidenceText(2));
    expect(await ask("layout-rows", MESSAGE.toUpperCase().replace("0X", "0x"))).toEqual({ jobId: `ready:layout-rows:${MESSAGE}`, ready: true });
    expect(service.job(`ready:layout-rows:${MESSAGE}`)).toMatchObject({ status: "done", kind: "layout-rows", subject: MESSAGE });
    expect(service.proof("deliver", MESSAGE)).toMatchObject({ kind: "deliver", subject: MESSAGE, evidence: { prerequisites: [{}, {}] } });
    expect(service.proof("deliver", "0x12")).toBeNull();
    expect(service.job(`ready:deliver:0x${"00".repeat(32)}`)).toBeNull();
    expect(service.job("ready:deliver")).toBeNull();
  });

  it("builds it on request through the archive, and fails a message the archive cannot build", async () => {
    const built = setup();
    built.archive.state.builds = { messageId: MESSAGE, text: evidenceText() };
    let release = () => {};
    built.archive.state.hold = new Promise((resolve) => (release = resolve));
    const answer = (await built.ask("deliver", MESSAGE)) as { jobId: string };
    expect(await built.ask("deliver", MESSAGE)).toEqual({ jobId: answer.jobId, joined: true });
    release();
    await built.service.settled();
    expect(built.service.job(answer.jobId)).toMatchObject({ kind: "deliver", status: "done", etaAt: null });
    const missing = setup();
    const second = (await missing.ask("deliver", MESSAGE)) as { jobId: string };
    await missing.service.settled();
    expect(missing.service.job(second.jobId)).toMatchObject({ status: "failed", error: expect.stringContaining("covers the message") });
    expect(await missing.ask("deliver", MESSAGE)).toMatchObject({ refused: "rate-limited" });
    expect(missing.service.job("step:none")).toBeNull();
  });

  it("refuses a bad message id, and is not served without an archive", async () => {
    expect(await setup().ask("deliver", "0x12")).toMatchObject({ invalid: expect.any(String) });
    expect(await setup({ archive: false }).ask("deliver", MESSAGE)).toMatchObject({ refused: "not-served" });
    expect(setup({ archive: false }).service.proof("deliver", MESSAGE)).toBeNull();
  });
});

describe("the jobs", () => {
  it("fails a job that ran past the prover limit, waits for one, and serves no proof of a seal", async () => {
    const { ask, service, clock, storage } = setup();
    const answer = (await ask("registry-light-client-update", "369")) as { jobId: string };
    clock.advance(1_800_001);
    await ask("deliver", MESSAGE);
    expect(latestStepJob(storage, "registry-light-client-update", "369")).toMatchObject({ status: "failed", error: "the job ran longer than its limit" });
    await service.wait("step:unknown");
    expect(service.proof("seal", "369")).toBeNull();
    void answer;
  });

  it("gives no eta for a job whose direction has no measured proof", () => {
    const storage = openStorage(":memory:");
    const service = createStepService({
      ...({} as StepServiceInput),
      storage,
      pair: REGISTRY_PAIR,
      now: () => 5,
      logger: memoryLogger().logger,
      limits: DEFAULT_RATE_LIMITS,
      proverTimeoutMilliseconds: 1,
      requestService: () => null,
      archive: () => null,
      chain: fakeChain().reads,
      readUsdPerHour: async () => 2,
      observationLimits: { retryMinutes: 1, maxProofsPerVersionPerDay: 1 },
      gpuEstimate: () => ({ warmMs: null, coldMs: 1, workerWarm: true }),
    });
    insertStepJob(storage, { id: "step:r", kind: "registry-light-client-update", subject: "369", at: 1, startSlot: 1 });
    expect(service.job("step:r")).toMatchObject({ etaAt: null });
    expect(service.proof("open-deposits", "first-to-second")).toBeNull();
    insertStepJob(storage, { id: "step:w", kind: "registry-light-client-update", subject: "1", at: 1, startSlot: 1 });
    expect(service.job("step:w")).toMatchObject({ etaAt: null });
  });
});
