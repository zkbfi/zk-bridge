// The fork observations of the seal module: the watch of one chain, the store of its proofs, the public route, and the
// wiring of the module for a chain whose gate seals from a fork registry.
import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, type Address, type Hex } from "viem";
import { forkRegistryAbi, type ForkObservation, type ForkObservationPackage, type PairSide } from "@zk-bridge/shared";
import type { ObservationOutcome } from "@zk-bridge/shared/prover";
import { createObservationWatch, type BudgetState, type ObservationFacts } from "../src/seal/observe-watch.ts";
import { latestObservationProof, latestObservationView } from "../src/seal/observations.ts";
import { start } from "../src/seal/module.ts";
import { openStorage } from "../src/storage.ts";
import type { SealSender } from "../src/seal/seal-watch.ts";
import { makeBackend, makeClock, makeConfig, memoryLogger, PAIR } from "./support.ts";

const REGISTRY: Address = "0x4444444444444444444444444444444444444444";
const HASH: Hex = `0x${"ab".repeat(32)}`;
const TEST_ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const V1: Hex = "0x0000036a";
const V2: Hex = "0x0000036b";

const proof = (overrides: Partial<ForkObservationPackage> = {}): ForkObservationPackage => ({
  schemaVersion: 1,
  route: "pulsechain_to_ethereum",
  chainId: 369,
  registry: REGISTRY,
  lightClient: "0x5555555555555555555555555555555555555555",
  programKey: `0x${"66".repeat(32)}`,
  startHeadSlot: 100,
  observedVersion: V2,
  shape: 5,
  observedAttestedSlot: 900,
  foldSteps: 3,
  publicValues: `0x${"00".repeat(256)}`,
  proof: "0x1234",
  observeCalldata: "0xabcd",
  backend: "remote",
  createdAt: "2026-11-11T00:00:00Z",
  ...overrides,
});

const registryAt = (version: Hex, shape: number, slot: bigint): ForkObservation => ({ registry: REGISTRY, version, shape, slot, shapeAllowed: shape >= 5 && shape <= 7, observed: BigInt(version) !== 0n });

const TIMING = { worker_total_ms: 90_000, remote_ms: 95_000, endpoint: "serverless" };

function setup(options: {
  facts?: () => Promise<ObservationFacts>;
  prove?: () => Promise<ObservationOutcome>;
  simulate?: (data: Hex) => Promise<bigint>;
  send?: SealSender;
  budget?: BudgetState;
  limits?: { retryMinutes: number; maxProofsPerVersionPerDay: number };
} = {}) {
  const storage = openStorage(":memory:");
  const clock = makeClock(1_794_000_000_000);
  const log = memoryLogger();
  const alerts: string[] = [];
  const recorded: boolean[] = [];
  const prove = vi.fn(options.prove ?? (async () => ({ observation: proof(), timing: TIMING })));
  const simulate = vi.fn(options.simulate ?? (async () => 250_000n));
  const send = vi.fn<SealSender>(options.send ?? (async () => ({ hash: HASH, success: true })));
  const watch = createObservationWatch({
    chainId: 369,
    chainName: "PulseChain",
    registry: REGISTRY,
    direction: "second-to-first",
    storage,
    now: clock.now,
    logger: log.logger,
    alert: (text) => alerts.push(text),
    limits: options.limits ?? { retryMinutes: 60, maxProofsPerVersionPerDay: 4 },
    readFacts: options.facts ?? (async () => ({ activeVersion: V2, registry: registryAt(V1, 5, 500n) })),
    budget: async () => options.budget ?? null,
    prove,
    simulate,
    send,
    onRecorded: ({ shapeAllowed }) => recorded.push(shapeAllowed),
  });
  return { watch, storage, clock, log, alerts, recorded, prove, simulate, send };
}

const linesOf = (log: { lines: string[] }, event: string) => log.lines.filter((line) => JSON.parse(line).event === event);

describe("createObservationWatch", () => {
  it("proves nothing while the registry holds the version the chain runs, and logs the reason once", async () => {
    const run = setup({ facts: async () => ({ activeVersion: V1, registry: registryAt(V1, 5, 500n) }) });
    expect(await run.watch.check()).toMatchObject({ kind: "not-needed", reason: expect.stringContaining(`holds version ${V1}`) });
    await run.watch.check();
    expect(run.prove).not.toHaveBeenCalled();
    expect(linesOf(run.log, "observation_not_needed")).toHaveLength(1);
  });

  it("proves a new version, records its GPU time with the direction, posts observe() with the simulated gas, and alerts", async () => {
    const run = setup();
    expect(await run.watch.check()).toEqual({ kind: "posted", hash: HASH, success: true, version: V2, shape: 5 });
    const sent = run.send.mock.calls[0]![0];
    expect(sent).toMatchObject({ to: REGISTRY, gas: 250_000n });
    expect(decodeFunctionData({ abi: forkRegistryAbi, data: sent.data })).toMatchObject({ functionName: "observe", args: ["0x1234", proof().publicValues] });
    const timing = run.storage.database.prepare("SELECT job_id, direction, worker_total_ms FROM job_timings").all() as Array<{ job_id: string; direction: string; worker_total_ms: number }>;
    expect(timing).toHaveLength(1);
    expect(timing[0]).toMatchObject({ direction: "second-to-first", worker_total_ms: 90_000 });
    expect(timing[0]!.job_id).toMatch(/^observation-/);
    expect(run.alerts).toEqual([
      `The PulseChain chain runs fork version ${V2}, which its fork registry does not hold: proving a fork observation on the GPU.`,
      `The PulseChain fork registry recorded fork version ${V2} (shape 5, allowed by the gate) by transaction ${HASH}.`,
    ]);
    expect(run.recorded).toEqual([true]);
    expect(latestObservationView(run.storage, 369)).toMatchObject({ observedVersion: V2, postedTransaction: HASH, shapeAllowed: true });
    expect(latestObservationView(run.storage, 1)).toBeNull();
  });

  it("wakes the seal for a shape the gate does not allow", async () => {
    const run = setup({ prove: async () => ({ observation: proof({ shape: 8 }), timing: null }) });
    await run.watch.check();
    expect(run.recorded).toEqual([false]);
    expect(run.alerts[1]).toContain("shape 8, not allowed by the gate");
  });

  it("seeds an empty registry without an alert, within the GPU budget, and waits while the budget is spent", async () => {
    const empty = async () => ({ activeVersion: V1, registry: registryAt("0x00000000", 0, 0n) });
    const seeded = setup({ facts: empty, prove: async () => ({ observation: proof({ observedVersion: V1 }), timing: null }) });
    expect(await seeded.watch.check()).toMatchObject({ kind: "posted" });
    expect(seeded.alerts).toHaveLength(1);
    const spent = setup({ facts: empty, budget: { spentUsd: 5.2, budgetUsd: 5, retryAfterSeconds: 600 } });
    expect(await spent.watch.check()).toMatchObject({ kind: "waiting", reason: expect.stringContaining("GPU budget of $5.00") });
    expect(spent.prove).not.toHaveBeenCalled();
    expect(linesOf(spent.log, "gpu_budget_spent")).toHaveLength(1);
  });

  it("passes a spent budget for a new fork version, logged", async () => {
    const run = setup({ budget: { spentUsd: 5.2, budgetUsd: 5, retryAfterSeconds: 600 } });
    expect(await run.watch.check()).toMatchObject({ kind: "posted" });
    expect(linesOf(run.log, "gpu_budget_bypassed")).toHaveLength(1);
  });

  it("spaces the tries of one version and caps them per day", async () => {
    const run = setup({ prove: async () => Promise.reject(new Error("worker gone")), limits: { retryMinutes: 30, maxProofsPerVersionPerDay: 2 } });
    expect(await run.watch.check()).toEqual({ kind: "failed", stage: "prove", error: "worker gone" });
    expect(run.alerts[1]).toBe("The fork observation for PulseChain could not be proven; it is tried again in 30 minutes.");
    expect(await run.watch.check()).toMatchObject({ kind: "waiting", reason: expect.stringContaining("tries are 30 minutes apart") });
    run.clock.advance(31 * 60_000);
    await run.watch.check();
    run.clock.advance(31 * 60_000);
    expect(await run.watch.check()).toMatchObject({ kind: "waiting", reason: expect.stringContaining("2 observation proofs of version") });
    expect(run.prove).toHaveBeenCalledTimes(2);
    expect(latestObservationProof(run.storage, 369)).toBeNull();
  });

  it("says nothing to a person when a seed fails, and survives a check that fails", async () => {
    const seed = setup({ facts: async () => ({ activeVersion: V1, registry: registryAt("0x00000000", 0, 0n) }), prove: async () => Promise.reject("text") });
    expect(await seed.watch.check()).toEqual({ kind: "failed", stage: "prove", error: "text" });
    expect(seed.alerts).toEqual([]);
    const broken = setup({ facts: async () => Promise.reject(new Error("beacon down")) });
    expect(await broken.watch.check()).toEqual({ kind: "failed", stage: "check", error: "beacon down" });
    expect(linesOf(broken.log, "observation_check_failed")).toHaveLength(1);
  });

  it("refuses a proof for another registry or chain", async () => {
    const other = setup({ prove: async () => ({ observation: proof({ registry: "0x9999999999999999999999999999999999999999" }), timing: null }) });
    expect(await other.watch.check()).toEqual({ kind: "failed", stage: "prove", error: "the proof is for another registry" });
    const chain = setup({ prove: async () => ({ observation: proof({ chainId: 943 }), timing: null }) });
    expect(await chain.watch.check()).toMatchObject({ kind: "failed", stage: "prove" });
    expect(other.send).not.toHaveBeenCalled();
  });

  it("keeps a proof the registry refused, and posts the held proof later without proving again", async () => {
    let refuse = true;
    const run = setup({ simulate: async () => (refuse ? Promise.reject(new Error("PreviousHeadSlotMismatch")) : 240_000n) });
    expect(await run.watch.check()).toEqual({ kind: "failed", stage: "simulate", error: "PreviousHeadSlotMismatch" });
    expect(run.alerts[1]).toContain("refuses the observation of fork version");
    // Still refused: the held proof is tried, then the spacing holds back a new one.
    expect(await run.watch.check()).toMatchObject({ kind: "waiting" });
    refuse = false;
    expect(await run.watch.check()).toMatchObject({ kind: "posted", success: true });
    expect(run.prove).toHaveBeenCalledTimes(1);
    expect(latestObservationView(run.storage, 369)?.postedTransaction).toBe(HASH);
  });

  it("does not post a held proof of another version, or one the registry has passed", async () => {
    // The held proof (V2 at slot 900) is behind the registry (slot 950): a new proof is asked for.
    const next = setup({ facts: async () => ({ activeVersion: V2, registry: registryAt(V1, 5, 950n) }), simulate: async () => Promise.reject(new Error("x")) });
    await next.watch.check();
    next.clock.advance(61 * 60_000);
    await next.watch.check();
    expect(next.prove).toHaveBeenCalledTimes(2);
    const moved = setup({ facts: async () => ({ activeVersion: "0x0000036c", registry: registryAt(V1, 5, 500n) }), simulate: async () => Promise.reject(new Error("x")) });
    await moved.watch.check();
    moved.clock.advance(61 * 60_000);
    await moved.watch.check();
    expect(moved.prove).toHaveBeenCalledTimes(2);
  });

  it("says when observe() reverted on chain or could not be sent", async () => {
    const reverted = setup({ send: async () => ({ hash: HASH, success: false }) });
    expect(await reverted.watch.check()).toMatchObject({ kind: "posted", success: false });
    expect(reverted.alerts[1]).toContain("reverted on chain");
    expect(reverted.recorded).toEqual([]);
    const broken = setup({ send: async () => Promise.reject(new Error("nonce too low")) });
    expect(await broken.watch.check()).toEqual({ kind: "failed", stage: "send", error: "nonce too low" });
    expect(broken.alerts[1]).toContain("could not be sent (nonce too low)");
  });

  it("never runs two checks at once", async () => {
    let release = (): void => {};
    const run = setup({ prove: () => new Promise((resolve) => (release = () => resolve({ observation: proof(), timing: null }))) });
    const first = run.watch.check();
    await vi.waitFor(() => expect(run.prove).toHaveBeenCalledTimes(1));
    expect(await run.watch.check()).toBeNull();
    release();
    expect(await first).toMatchObject({ kind: "posted" });
  });
});

describe("the seal module with a fork registry", () => {
  const sealConfig = (observation: Record<string, unknown> = {}) => makeConfig({ seal: { signer: { kind: "private-key", key: "env:ZKB_SEAL_KEY" }, observation } });
  const withRegistry: PairSide = { ...PAIR.sides[1], contracts: { ...PAIR.sides[1].contracts, forkRegistry: REGISTRY } };
  const pair = { ...PAIR, sides: [PAIR.sides[0], withRegistry] as const };
  const scheduleFetch = (async (url: string) => {
    const body = url.includes("fork_schedule")
      ? { data: [{ current_version: V1, epoch: "0" }, { current_version: V2, epoch: "1" }] }
      : url.includes("genesis")
        ? { data: { genesis_time: "1000" } }
        : { data: { SECONDS_PER_SLOT: "10", SLOTS_PER_EPOCH: "32" } };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  // The gate is sealed already (no seal is offered), and the registry holds V1 at slot 500.
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) =>
    functionName === "latestObserved" ? [V1, 5, 500n] : ({ mode: 4, enforcing: true, isSealed: true, forkRegistry: REGISTRY } as Record<string, unknown>)[functionName],
  );

  const run = async (options: { observation?: Record<string, unknown>; prover?: boolean; fetch?: typeof fetch | null; billing?: boolean; budgetUsd?: number; noBeacon?: boolean; first?: boolean; shape?: number; every?: boolean } = {}) => {
    const config = sealConfig(options.observation);
    const limited = options.budgetUsd === undefined ? config : { ...config, limits: { ...config.limits, gpuBudgetUsdPerDirectionPerDay: options.budgetUsd } };
    const backend = makeBackend({ config: limited, enabled: ["seal"] });
    const forkObservation = vi.fn(async () => ({ observation: proof({ shape: options.shape ?? 5, chainId: options.first === true ? 1 : 369 }), timing: TIMING }));
    const estimateGas = vi.fn(async () => 250_000n);
    const port = { send: vi.fn(async () => ({ hash: HASH, success: true })), feeQuote: vi.fn(async () => ({ baseFee: 10n, priorityFee: 1n })) };
    const context = {
      ...backend.context,
      pair:
        options.noBeacon === true
          ? { ...pair, sides: [pair.sides[0], { ...withRegistry, beaconUrl: null }] as const }
          : options.first === true
            ? { ...PAIR, sides: [{ ...PAIR.sides[0], contracts: { ...PAIR.sides[0].contracts, forkRegistry: REGISTRY } }, PAIR.sides[1]] as const }
            : pair,
      now: () => 1_794_000_000_000,
      openSealSigner: async () => ({ address: TEST_ACCOUNT }) as never,
      ...(options.prover === false ? {} : { observationProver: { forkObservation } }),
      ...(options.billing === true ? { billing: { read: async () => ({ spend: null, balance: null }) } } : {}),
    };
    const stop = await start(context, {
      client: () => ({ readContract, estimateGas }) as never,
      port: () => port as never,
      every: (_milliseconds, check) => {
        if (options.every === true) check();
        return () => {};
      },
      ...(options.fetch === null ? {} : { fetch: options.fetch ?? scheduleFetch }),
    });
    return { ...backend, context, stop, forkObservation, estimateGas, port };
  };

  it("proves and posts the observation of the chain with a registry, and serves it on the public route", async () => {
    const { app, log, stop, forkObservation, port, estimateGas } = await run();
    await vi.waitFor(() => expect(port.send).toHaveBeenCalledTimes(1));
    expect(forkObservation).toHaveBeenCalledWith({ direction: "second-to-first", registry: REGISTRY });
    expect(estimateGas).toHaveBeenCalledWith(expect.objectContaining({ account: TEST_ACCOUNT, to: REGISTRY }));
    expect(log.lines.join("\n")).toContain('"observing":[369]');
    await stop();
    const response = await app.request("/fork-observations/369/latest");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ chainId: 369, observedVersion: V2, shapeAllowed: true, postedTransaction: HASH });
    expect(body).not.toHaveProperty("backend");
    expect((await app.request("/fork-observations/1/latest")).status).toBe(404);
    expect((await app.request("/fork-observations/abc/latest")).status).toBe(404);
  });

  it("prices the budget from the billing when it is read, and passes a spent budget for the new version", async () => {
    const { log, stop, port } = await run({ billing: true, budgetUsd: 0 });
    await vi.waitFor(() => expect(port.send).toHaveBeenCalledTimes(1));
    expect(log.lines.join("\n")).toContain("gpu_budget_bypassed");
    await stop();
  });

  it("observes nothing when it is switched off, without a proving backend, or without a beacon endpoint", async () => {
    for (const options of [{ observation: { enabled: false } }, { prover: false }, { noBeacon: true }]) {
      const { log, stop, forkObservation } = await run(options);
      await stop();
      expect(forkObservation).not.toHaveBeenCalled();
      expect(log.lines.join("\n")).toContain('"observing":[]');
    }
  });

  it("observes a registry on the first chain for the first direction, and wakes the seal for a shape the gate does not allow", async () => {
    const { log, stop, forkObservation, port } = await run({ first: true, shape: 8, every: true });
    await vi.waitFor(() => expect(port.send).toHaveBeenCalled());
    expect(forkObservation).toHaveBeenCalledWith({ direction: "first-to-second", registry: REGISTRY });
    // The seal watch was woken: one more gate read than its own start and timer give.
    await vi.waitFor(() => expect(log.lines.filter((line) => line.includes("seal_gate_sealed")).length).toBeGreaterThan(0));
    await stop();
  });

  it("reads the beacon node with the global fetch by default", async () => {
    const { log, stop } = await run({ fetch: null });
    // The beacon endpoint of the test pair does not resolve.
    await vi.waitFor(() => expect(log.lines.join("\n")).toContain("observation_check_failed"), { timeout: 20_000 });
    await stop();
  });

  it("logs a beacon node that does not answer, and proves nothing", async () => {
    const down = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    const { log, stop, forkObservation } = await run({ fetch: down });
    await vi.waitFor(() => expect(log.lines.join("\n")).toContain("observation_check_failed"));
    await stop();
    expect(forkObservation).not.toHaveBeenCalled();
  });
});
