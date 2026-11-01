import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProverCommandError, type LightClientReader, type OpeningPackage, type OpeningProver } from "@zk-bridge/shared/prover";
import type { CallRequest, SendRequest, Simulation, TransactionPort } from "../../src/chain/transactions.ts";
import { OPEN_RETRY_BASE_MILLISECONDS, OPEN_RETRY_MAXIMUM_MILLISECONDS, createDepositOpener, type DepositOpenerDependencies } from "../../src/runner/opener.ts";
import { createSerialQueue } from "../../src/runner/serial-queue.ts";
import { INITIAL_RUNNER_STATE, runnerStateSchema, type RunnerState } from "../../src/runner/state.ts";
import { createStateFile, type StateStore } from "../../src/runtime/state-file.ts";
import { BRIDGE, PROGRAM_KEY, RUNNER, memoryLogger, word } from "../support/builders.ts";

const ROUTE = "pulsechain_to_ethereum";
const CALLDATA = "0x5a5a5a5a01" as Hex;

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function openingPackage(overrides: Partial<OpeningPackage> = {}): OpeningPackage {
  return {
    route: ROUTE,
    to: BRIDGE,
    calldata: CALLDATA,
    chainId: 369,
    depositsOpen: false,
    remoteBlockNumber: 9_000,
    proof: { remoteSlot: 640, storedSlot: 320 },
    ...overrides,
  } as OpeningPackage;
}

/** A light client whose head the test moves. */
function movableHead(start = 640n): LightClientReader & { headSlot: bigint; failure: Error | null } {
  const reader = {
    headSlot: start,
    failure: null as Error | null,
    async read() {
      if (reader.failure !== null) throw reader.failure;
      return { headSlot: reader.headSlot, headRoot: word(reader.headSlot === 0n ? 1 : Number(reader.headSlot)), programKey: PROGRAM_KEY };
    },
  };
  return reader;
}

/** A port that records simulations and sends. Tests replace `simulation` and `receiptSuccess`. */
function fakePort() {
  const simulations: CallRequest[] = [];
  const sends: SendRequest[] = [];
  const port = {
    chainId: 369,
    account: RUNNER,
    simulations,
    sends,
    simulation: { ok: true, gas: 200_000n } as Simulation,
    receiptSuccess: true,
    sendFailure: null as Error | null,
    async simulate(request: CallRequest) {
      simulations.push(request);
      return port.simulation;
    },
    async call(): Promise<Hex> {
      throw new Error("the opener makes no read-only call through the port");
    },
    async feeQuote() {
      return { baseFee: 7n, priorityFee: 10_000_000n };
    },
    async send(request: SendRequest) {
      if (port.sendFailure !== null) throw port.sendFailure;
      sends.push(request);
      return { hash: word(0xee), success: port.receiptSuccess, gasUsed: 150_000n, effectiveGasPrice: 17n, blockNumber: 5n, logs: [] };
    },
  };
  return port satisfies TransactionPort;
}

function memoryState(initial: RunnerState = INITIAL_RUNNER_STATE): StateStore<RunnerState> & { current: RunnerState } {
  const store = {
    current: initial,
    async load() {
      return store.current;
    },
    async update(mutate: (state: RunnerState) => RunnerState) {
      store.current = mutate(store.current);
      return store.current;
    },
  };
  return store;
}

interface WorldOptions {
  readonly open?: boolean[];
  readonly proofs?: Array<OpeningPackage | Error>;
  readonly state?: StateStore<RunnerState>;
  readonly enabled?: boolean;
}

function world(options: WorldOptions = {}) {
  let clock = 1_000_000;
  const openAnswers = [...(options.open ?? [false])];
  const readDepositsOpen = vi.fn(async () => (openAnswers.length > 1 ? openAnswers.shift()! : openAnswers[0]!));
  const proofs = [...(options.proofs ?? [openingPackage()])];
  const openingProof = vi.fn<OpeningProver["openingProof"]>(async () => {
    const next = proofs.length > 1 ? proofs.shift()! : proofs[0]!;
    if (next instanceof Error) throw next;
    return next;
  });
  const head = movableHead();
  const chain = fakePort();
  const state = options.state ?? memoryState();
  const { logger, events } = memoryLogger();
  const dependencies: DepositOpenerDependencies = {
    enabled: options.enabled ?? true,
    route: ROUTE,
    openingDirection: "second-to-first",
    bridge: BRIDGE,
    readDepositsOpen,
    lightClient: head,
    prover: { openingProof },
    chain,
    queue: createSerialQueue(),
    state,
    now: () => clock,
    logger,
  };
  const opener = createDepositOpener(dependencies);
  return {
    opener,
    readDepositsOpen,
    openingProof,
    head,
    chain,
    state,
    events,
    named: (event: string) => events().filter((entry) => entry.event === event),
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
  };
}

describe("the deposit opener", () => {
  it("proves, simulates and sends openDeposits for a closed bridge, then records it as open", async () => {
    const run = world();
    const result = await run.opener.check();
    expect(result).toEqual({ kind: "opened", transactionHash: word(0xee) });
    expect(run.openingProof).toHaveBeenCalledWith({ direction: "second-to-first" });
    expect(run.chain.simulations).toEqual([{ to: BRIDGE, data: CALLDATA }]);
    expect(run.chain.sends).toHaveLength(1);
    // The fee terms come from the port, which applies the runner's priority settings: the tip is the quoted one.
    expect(run.chain.sends[0]).toMatchObject({ to: BRIDGE, data: CALLDATA, gas: 260_000n, maxFeePerGas: 10_000_014n, maxPriorityFeePerGas: 10_000_000n });
    expect((await run.state.load()).depositsOpen).toBe(true);
    expect(run.named("deposits_open_checked")[0]).toMatchObject({ bridge: BRIDGE, headSlot: "640", open: false });
    expect(run.named("deposits_opening")[0]).toMatchObject({ route: ROUTE, bridge: BRIDGE, remoteSlot: 640, storedSlot: 320, remoteBlockNumber: 9_000 });
    expect(run.named("deposits_opened")[0]).toMatchObject({ route: ROUTE, bridge: BRIDGE, transactionHash: word(0xee), gasUsed: "150000" });

    // Open for good: later checks read nothing, even after the head moves.
    run.head.headSlot = 704n;
    expect(await run.opener.check()).toEqual({ kind: "open" });
    expect(run.readDepositsOpen).toHaveBeenCalledTimes(1);
    expect(run.openingProof).toHaveBeenCalledTimes(1);
  });

  it("reads nothing when the configuration turns it off", async () => {
    const run = world({ enabled: false });
    expect(await run.opener.check()).toEqual({ kind: "disabled" });
    expect(run.readDepositsOpen).not.toHaveBeenCalled();
    expect(run.openingProof).not.toHaveBeenCalled();
  });

  it("does nothing but record the flag when the bridge already reports open", async () => {
    const run = world({ open: [true] });
    expect(await run.opener.check()).toEqual({ kind: "open" });
    expect(run.openingProof).not.toHaveBeenCalled();
    expect(run.chain.simulations).toHaveLength(0);
    expect((await run.state.load()).depositsOpen).toBe(true);
    expect(run.named("deposits_open_checked")[0]).toMatchObject({ open: true });
    run.head.headSlot = 704n;
    await run.opener.check();
    expect(run.readDepositsOpen).toHaveBeenCalledTimes(1);
  });

  it("records open without a send when the prover finds the bridge open", async () => {
    const run = world({ proofs: [openingPackage({ depositsOpen: true })] });
    expect(await run.opener.check()).toEqual({ kind: "open" });
    expect(run.chain.simulations).toHaveLength(0);
    expect((await run.state.load()).depositsOpen).toBe(true);
  });

  it("logs a proof-window failure, waits for the next update and the backoff, then opens", async () => {
    const windowError = new ProverCommandError("opening-proof", 1, "rpc error 4444/-32602: distance to target block exceeds maximum proof window");
    const run = world({ proofs: [windowError, openingPackage({ proof: { remoteSlot: 704, storedSlot: 352 } } as Partial<OpeningPackage>)] });
    expect(await run.opener.check()).toMatchObject({ kind: "failed", reason: "proof-failed" });
    const failed = run.named("deposits_open_failed")[0]!;
    expect(failed).toMatchObject({ reason: "proof-failed", route: ROUTE, failures: 1, retryAfterSeconds: OPEN_RETRY_BASE_MILLISECONDS / 1000, headSlot: "640" });
    expect(String(failed.detail)).toContain("maximum proof window");
    expect(run.chain.sends).toHaveLength(0);

    // The same head again: no new block was stored, so no second proof. It never loops.
    run.advance(OPEN_RETRY_BASE_MILLISECONDS);
    expect(await run.opener.check()).toEqual({ kind: "waiting", reason: "no-new-head" });
    // A new head inside the backoff waits too.
    run.advance(-1);
    run.head.headSlot = 704n;
    expect(await run.opener.check()).toEqual({ kind: "waiting", reason: "backing-off" });
    expect(run.openingProof).toHaveBeenCalledTimes(1);
    // A new head after the backoff: the next try, which opens.
    run.advance(1);
    expect(await run.opener.check()).toEqual({ kind: "opened", transactionHash: word(0xee) });
    expect(run.openingProof).toHaveBeenCalledTimes(2);
    expect(run.named("deposits_opening")[0]).toMatchObject({ remoteSlot: 704, storedSlot: 352 });
  });

  it("doubles the wait after each failure, up to the maximum, and starts over after a success", async () => {
    const run = world({ proofs: [new Error("node down")] });
    const waits: unknown[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      run.head.headSlot += 32n;
      run.advance(OPEN_RETRY_MAXIMUM_MILLISECONDS);
      await run.opener.check();
    }
    for (const entry of run.named("deposits_open_failed")) waits.push(entry.retryAfterSeconds);
    expect(waits).toEqual([60, 120, 240, 480, 960, 1800, 1800, 1800]);
  });

  it("never sends when the simulation reverts", async () => {
    const run = world();
    run.chain.simulation = { ok: false, reason: "OpeningEntryEmpty(320)" };
    expect(await run.opener.check()).toMatchObject({ kind: "failed", reason: "simulation-reverted", detail: "OpeningEntryEmpty(320)" });
    expect(run.chain.sends).toHaveLength(0);
    expect((await run.state.load()).depositsOpen).toBe(false);
  });

  it("refuses a proof for another contract", async () => {
    const run = world({ proofs: [openingPackage({ to: `0x${"ab".repeat(20)}` })] });
    expect(await run.opener.check()).toMatchObject({ kind: "failed", reason: "wrong-target" });
    expect(run.chain.simulations).toHaveLength(0);
  });

  it("reports a reverted transaction and a send that threw as failures", async () => {
    const reverted = world();
    reverted.chain.receiptSuccess = false;
    expect(await reverted.opener.check()).toMatchObject({ kind: "failed", reason: "transaction-reverted", detail: word(0xee) });
    expect((await reverted.state.load()).depositsOpen).toBe(false);

    const lost = world();
    lost.chain.sendFailure = new Error("no receipt");
    expect(await lost.opener.check()).toMatchObject({ kind: "failed", reason: "send-failed", detail: "no receipt" });
  });

  it("counts an unreadable head or bridge as a failure, without a proof", async () => {
    const run = world();
    run.head.failure = new Error("rpc down");
    expect(await run.opener.check()).toMatchObject({ kind: "failed", reason: "read-failed", detail: "rpc down" });
    run.head.failure = null;
    run.readDepositsOpen.mockRejectedValueOnce("socket closed");
    run.advance(OPEN_RETRY_MAXIMUM_MILLISECONDS);
    expect(await run.opener.check()).toMatchObject({ kind: "failed", reason: "read-failed", detail: "socket closed" });
    expect(run.openingProof).not.toHaveBeenCalled();
  });

  it("keeps the open flag in the state file across a restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opener-"));
    scratch.push(directory);
    const path = join(directory, "runner.json");
    const file = () => createStateFile({ path, schema: runnerStateSchema, initial: INITIAL_RUNNER_STATE });
    const first = world({ state: file() });
    expect(await first.opener.check()).toMatchObject({ kind: "opened" });

    const restarted = world({ state: file() });
    expect(await restarted.opener.check()).toEqual({ kind: "open" });
    expect(restarted.readDepositsOpen).not.toHaveBeenCalled();
    expect(restarted.openingProof).not.toHaveBeenCalled();
    expect((await file().load()).depositsOpen).toBe(true);
  });

  it("reads an old state file without the flag as closed", () => {
    const { depositsOpen: _ignored, ...old } = INITIAL_RUNNER_STATE;
    expect(runnerStateSchema.parse(old).depositsOpen).toBe(false);
  });
});

describe("the deposit opener and its state file", () => {
  it("stops with the error of a state file that cannot be written", async () => {
    const state = memoryState();
    state.update = async () => {
      throw new Error("disk full");
    };
    const run = world({ open: [true], state });
    await expect(run.opener.check()).rejects.toThrow("disk full");
  });
});
