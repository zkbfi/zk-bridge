import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProverCommandError, type LightClientReader, type OpeningPackage, type OpeningProver } from "@zk-bridge/shared/prover";
import type { CallRequest, SendRequest, Simulation, TransactionPort } from "../../src/chain/transactions.ts";
import {
  OPEN_RETRY_BASE_MILLISECONDS,
  OPEN_RETRY_MAXIMUM_MILLISECONDS,
  RPC_RETRY_BASE_MILLISECONDS,
  RPC_RETRY_MAXIMUM_MILLISECONDS,
  createDepositOpener,
  isRpcErrorText,
  type DepositOpenerDependencies } from "../../src/runner/opener.ts";
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
  readonly random?: (() => number) | null;
  /** Leave the scheduler out of the dependencies, so the opener uses its own timer. */
  readonly realTimer?: boolean;
  readonly prepareOpening?: () => Promise<void>;
}

/** A timer the test fires by hand: the fake clock of the retries. */
function fakeTimers() {
  const timers: Array<{ delay: number; callback: () => void; cancelled: boolean; fired: boolean }> = [];
  return {
    timers,
    schedule(callback: () => void, delay: number) {
      const timer = { delay, callback, cancelled: false, fired: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    live: () => timers.filter((timer) => !timer.cancelled && !timer.fired),
  };
}

/** Lets the work that a fired timer started finish. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
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
  const timers = fakeTimers();
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
    ...(options.realTimer === true ? {} : { schedule: timers.schedule }),
    ...(options.prepareOpening === undefined ? {} : { prepareOpening: options.prepareOpening }),
    ...(options.random === null ? {} : { random: options.random ?? (() => 0) }),
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
    timers,
    /** Fires the pending retry timer, as the clock would, and waits for the attempt. */
    async fire() {
      const timer = timers.live().at(-1)!;
      clock += timer.delay;
      timer.fired = true;
      timer.callback();
      await flush();
    },
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

  it("retries a proof-window failure of the same head on the timer and opens once the window widens", async () => {
    const windowError = new ProverCommandError("opening-proof", 1, "rpc error 4444/-32602: distance to target block exceeds maximum proof window");
    // The provider's window is too short for two tries, then it is raised.
    const run = world({ proofs: [windowError, windowError, openingPackage()] });
    expect(await run.opener.check()).toMatchObject({ kind: "failed", reason: "proof-failed", failureClass: "rpc" });
    const failed = run.named("deposits_open_failed")[0]!;
    expect(failed).toMatchObject({ reason: "proof-failed", failureClass: "rpc", route: ROUTE, failures: 1, retryAfterSeconds: RPC_RETRY_BASE_MILLISECONDS / 1000, headSlot: "640" });
    expect(String(failed.detail)).toContain("maximum proof window");
    expect(run.named("deposits_open_retry")[0]).toMatchObject({ route: ROUTE, reason: "proof-failed", reasonClass: "rpc", attempt: 1, retryAfterSeconds: 30, headSlot: "640" });
    expect(run.timers.live()).toHaveLength(1);

    // Polls before the timer fires neither prove nor read the bridge again: the head did not move.
    expect(await run.opener.check()).toEqual({ kind: "waiting", reason: "backing-off" });
    expect(run.openingProof).toHaveBeenCalledTimes(1);

    // The timer retries the same head with no new head, and fails again with a longer delay.
    await run.fire();
    expect(run.openingProof).toHaveBeenCalledTimes(2);
    expect(run.named("deposits_open_retry")[1]).toMatchObject({ attempt: 2, retryAfterSeconds: 60, headSlot: "640" });
    expect(run.chain.sends).toHaveLength(0);

    // The window widens: the next timer opens the bridge, and nothing is scheduled any more.
    await run.fire();
    expect(run.chain.sends).toHaveLength(1);
    expect((await run.state.load()).depositsOpen).toBe(true);
    expect(run.named("deposits_opened")).toHaveLength(1);
    expect(run.timers.live()).toHaveLength(0);
    expect(await run.opener.check()).toEqual({ kind: "open" });
    expect(run.chain.sends).toHaveLength(1);
  });

  it("doubles the RPC retry delay up to 10 minutes, jitters it below the cap, and starts over after a success", async () => {
    const run = world({ proofs: [new Error("HTTP request failed: status 503")], random: () => 0.5 });
    await run.opener.check();
    for (let attempt = 0; attempt < 7; attempt += 1) await run.fire();
    const delays = run.named("deposits_open_retry").map((entry) => entry.retryAfterSeconds);
    // Base 30, 60, 120, 240, 480, then 600 (the cap), each less 12.5 percent at a jitter of one half.
    expect(delays).toEqual([26.25, 52.5, 105, 210, 420, 525, 525, 525]);
    expect(run.named("deposits_open_failed").every((entry) => entry.failureClass === "rpc")).toBe(true);
    expect(RPC_RETRY_MAXIMUM_MILLISECONDS).toBe(600_000);
  });

  it("does not retry a logic failure on a timer: it waits for a newer head and the backoff", async () => {
    const run = world({ proofs: [openingPackage({ to: `0x${"ab".repeat(20)}` })] });
    expect(await run.opener.check()).toMatchObject({ kind: "failed", reason: "wrong-target", failureClass: "logic" });
    expect(run.timers.timers).toHaveLength(0);
    expect(run.named("deposits_open_retry")).toHaveLength(0);
    expect(run.named("deposits_open_failed")[0]).toMatchObject({ failureClass: "logic", retryAfterSeconds: 60 });

    run.advance(OPEN_RETRY_BASE_MILLISECONDS);
    expect(await run.opener.check()).toEqual({ kind: "waiting", reason: "no-new-head" });
    run.advance(-1);
    run.head.headSlot = 704n;
    expect(await run.opener.check()).toEqual({ kind: "waiting", reason: "backing-off" });
    expect(run.openingProof).toHaveBeenCalledTimes(1);
    run.advance(1);
    await run.opener.check();
    expect(run.openingProof).toHaveBeenCalledTimes(2);
  });

  it("never retries a simulation revert or a failed send on a timer, so no transaction goes out twice", async () => {
    const reverted = world();
    reverted.chain.simulation = { ok: false, reason: "timeout in the contract?" };
    await reverted.opener.check();
    expect(reverted.timers.timers).toHaveLength(0);

    const lost = world();
    lost.chain.sendFailure = new Error("request timed out");
    expect(await lost.opener.check()).toMatchObject({ kind: "failed", reason: "send-failed", failureClass: "logic" });
    expect(lost.timers.timers).toHaveLength(0);
  });

  it("switches to a newer head at once during an RPC backoff, and the timer is cancelled", async () => {
    const windowError = new Error("distance to target block exceeds maximum proof window");
    const run = world({ proofs: [windowError, openingPackage({ proof: { remoteSlot: 704, storedSlot: 352 } } as Partial<OpeningPackage>)] });
    await run.opener.check();
    const first = run.timers.live()[0]!;
    run.head.headSlot = 704n;
    expect(await run.opener.check()).toEqual({ kind: "opened", transactionHash: word(0xee) });
    expect(first.cancelled).toBe(true);
    expect(run.named("deposits_opening")[0]).toMatchObject({ remoteSlot: 704 });
    expect(run.chain.sends).toHaveLength(1);
    // The cancelled timer fires anyway (it was queued): it does nothing.
    first.callback();
    await flush();
    expect(run.openingProof).toHaveBeenCalledTimes(2);
    expect(run.chain.sends).toHaveLength(1);
  });

  it("starts the RPC backoff over on a newer head that fails again, and a logic failure ends the retries", async () => {
    const windowError = new Error("distance to target block exceeds maximum proof window");
    const run = world({ proofs: [windowError, windowError, windowError, openingPackage({ to: `0x${"ab".repeat(20)}` })] });
    await run.opener.check();
    await run.fire();
    expect(run.named("deposits_open_retry")[1]).toMatchObject({ attempt: 2, retryAfterSeconds: 60 });
    run.head.headSlot = 704n;
    // The newer head fails the same way: the count starts over at one.
    await run.opener.check();
    expect(run.named("deposits_open_retry")[2]).toMatchObject({ attempt: 1, retryAfterSeconds: 30, headSlot: "704" });
    // The next timer meets a logic failure: it stops retrying and waits for a newer head.
    await run.fire();
    expect(run.named("deposits_open_failed").at(-1)).toMatchObject({ failureClass: "logic", reason: "wrong-target" });
    expect(run.timers.live()).toHaveLength(0);
    expect(await run.opener.check()).toEqual({ kind: "waiting", reason: "backing-off" });
    run.advance(OPEN_RETRY_BASE_MILLISECONDS);
    expect(await run.opener.check()).toEqual({ kind: "waiting", reason: "no-new-head" });
  });

  it("retries a head that cannot be read on the timer, and polls do not touch it meanwhile", async () => {
    const run = world();
    run.head.failure = new Error("rpc down");
    expect(await run.opener.check()).toMatchObject({ kind: "failed", reason: "read-failed", failureClass: "rpc" });
    // No attempt used a head yet, so a poll waits for the timer, also when the head can be read again.
    run.head.failure = null;
    expect(await run.opener.check()).toEqual({ kind: "waiting", reason: "backing-off" });
    // A poll that cannot read the head waits too, and counts as nothing.
    run.head.failure = new Error("still down");
    expect(await run.opener.check()).toEqual({ kind: "waiting", reason: "backing-off" });
    expect(run.named("deposits_open_failed")).toHaveLength(1);
    // The timer's own read fails: another retry with a longer delay.
    await run.fire();
    expect(run.named("deposits_open_retry")[1]).toMatchObject({ attempt: 2, retryAfterSeconds: 60, headSlot: null });
    run.head.failure = null;
    await run.fire();
    expect(run.chain.sends).toHaveLength(1);
  });

  it("waits during an RPC backoff when the head cannot be read or has not moved", async () => {
    const run = world({ proofs: [new Error("connection reset")] });
    await run.opener.check();
    run.head.failure = new Error("down");
    expect(await run.opener.check()).toEqual({ kind: "waiting", reason: "backing-off" });
    run.head.failure = null;
    expect(await run.opener.check()).toEqual({ kind: "waiting", reason: "backing-off" });
    expect(run.openingProof).toHaveBeenCalledTimes(1);
  });

  it("stops retrying once the bridge reports open, and when stop is called", async () => {
    const run = world({ open: [false, true], proofs: [new Error("HTTP 429 too many requests")] });
    await run.opener.check();
    expect(run.timers.live()).toHaveLength(1);
    await run.fire();
    expect(await run.opener.check()).toEqual({ kind: "open" });
    expect(run.timers.live()).toHaveLength(0);

    const stopped = world({ proofs: [new Error("timeout")] });
    await stopped.opener.check();
    stopped.opener.stop();
    expect(stopped.timers.live()).toHaveLength(0);
  });

  it("does nothing on a timer that finds the state file marked open by another process", async () => {
    const run = world({ proofs: [new Error("timeout")] });
    await run.opener.check();
    await run.state.update((state) => ({ ...state, depositsOpen: true }));
    await run.fire();
    expect(run.openingProof).toHaveBeenCalledTimes(1);
    expect(run.timers.live()).toHaveLength(0);
  });

  it("logs a retry whose state file cannot be written instead of throwing from the timer", async () => {
    const state = memoryState();
    const run = world({ state, proofs: [new Error("timeout"), openingPackage()] });
    await run.opener.check();
    state.update = async () => {
      throw new Error("disk full");
    };
    await run.fire();
    expect(run.named("deposits_open_retry_crashed")[0]).toMatchObject({ route: ROUTE });
  });

  it("uses a real unreferenced timer by default", async () => {
    vi.useFakeTimers();
    try {
      const run = world({ proofs: [new Error("timeout"), openingPackage()], realTimer: true });
      await run.opener.check();
      await vi.advanceTimersByTimeAsync(RPC_RETRY_BASE_MILLISECONDS);
      expect(run.chain.sends).toHaveLength(1);

      const cancelled = world({ proofs: [new Error("timeout")], realTimer: true });
      await cancelled.opener.check();
      cancelled.opener.stop();
      await vi.advanceTimersByTimeAsync(RPC_RETRY_MAXIMUM_MILLISECONDS);
      expect(cancelled.openingProof).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses Math.random for the jitter when none is given", async () => {
    const spy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const run = world({ proofs: [new Error("timeout")], random: null });
      await run.opener.check();
      expect(spy).toHaveBeenCalled();
      expect(run.timers.live()[0]!.delay).toBe(RPC_RETRY_BASE_MILLISECONDS);
    } finally {
      spy.mockRestore();
    }
  });

  it("classifies RPC error text", () => {
    for (const text of [
      "rpc error -32602/4444: distance to target block exceeds maximum proof window",
      "header not found",
      "request timed out",
      "connect ECONNREFUSED 127.0.0.1:8545",
      "HTTP request failed. Status: 429",
      "HTTP request failed. Status: 502",
      "rate limit exceeded",
      "getaddrinfo ENOTFOUND rpc.example",
      "fetch failed",
      "502 Bad Gateway",
    ]) {
      expect(isRpcErrorText(text), text).toBe(true);
    }
    for (const text of ["OpeningEntryEmpty(320)", "execution reverted", "it needs its first update", "the proof is for 0xab"]) {
      expect(isRpcErrorText(text), text).toBe(false);
    }
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
    await run.fire();
    expect(run.named("deposits_open_failed")[1]).toMatchObject({ reason: "read-failed", detail: "socket closed" });
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

describe("the opener fetches the cache entry of the stored head before the prover runs", () => {
  it("prepares before each opening proof, and goes on with the proof when the preparation fails, logging no URL", async () => {
    const order: string[] = [];
    const prepareOpening = vi.fn(async () => {
      order.push("prepare");
      if (prepareOpening.mock.calls.length === 1) throw new Error("the proof archive at https://indexer.example/key answered 503");
    });
    const setup = world({ prepareOpening });
    setup.openingProof.mockImplementation(async () => {
      order.push("prove");
      return openingPackage();
    });
    await setup.opener.check();
    expect(order).toEqual(["prepare", "prove"]);
    const warning = setup.events().find((event) => event.event === "deposits_opening_cache_failed");
    expect(warning).toMatchObject({ route: ROUTE, bridge: BRIDGE, detail: "the proof archive at https://indexer.example answered 503" });
  });
});
