import { encodeErrorResult, encodeFunctionData, getAddress, parseAbi, type Address, type Hash, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { beaconForkGateAbi, GateEvidenceError, type GateConfirmation } from "@zk-bridge/shared";
import { FIXTURE_ACCOUNT, FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import { computeBridgeDraft, DEFAULT_DELIVERY_OPTIONS } from "../../src/tx/bridge-draft";
import type { GateCheck } from "../../src/tx/gate-check";
import { canRetry, createTransactionSequence, GATE_WAIT_LIMIT, type SequenceChainClient, type SequenceState } from "../../src/tx/transaction-sequence";
import { buildFixtureContext } from "../helpers";

const GATE = FIXTURE_PAIR.first.contracts.gate as Address;
const EVIDENCE: Hex = `0x${"ab".repeat(64)}`;
const CONFIRM_DATA = encodeFunctionData({ abi: parseAbi(["function confirm(bytes evidence)"]), functionName: "confirm", args: [EVIDENCE] });

const hashOf = (index: number): Hash => `0x${index.toString(16).padStart(2, "0").repeat(32)}`;

const client = (overrides: Partial<SequenceChainClient> = {}): SequenceChainClient => ({
  estimateGas: async () => 100_000n,
  getTransactionCount: async () => 3,
  estimateFeesPerGas: async () => ({ maxFeePerGas: 20n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n }),
  waitForTransactionReceipt: async () => ({ status: "success", gasUsed: 90_000n, blockNumber: 5n }),
  ...overrides,
});

const confirmAnswer = (epoch = 360_335n): GateConfirmation =>
  ({
    kind: "confirm",
    call: { to: GATE, data: CONFIRM_DATA },
    gas: 150_000n,
    epoch,
    forkVersion: "0x90000075",
    shape: 6,
    validUntil: 1_762_500_000n,
    evidence: { encoded: EVIDENCE, header: { slot: 11_530_720n } },
  }) as unknown as GateConfirmation;

const NOT_NEEDED: GateConfirmation = { kind: "not-needed", reason: "confirmed", epoch: 360_335n };

/** A gate check that answers from a list, in order, and repeats the last answer. */
const scripted = (...answers: (GateConfirmation | Error)[]) => {
  const calls: Parameters<GateCheck>[0][] = [];
  const check: GateCheck = async (input) => {
    calls.push(input);
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { check, calls };
};

const forkNotConfirmed = (epoch: bigint): Error =>
  Object.assign(new Error("Execution reverted for an unknown reason."), {
    cause: { data: encodeErrorResult({ abi: beaconForkGateAbi, errorName: "ForkNotConfirmed", args: [epoch] }) },
  });

const stepsWithApproval = async () => {
  const { context, tokens } = await buildFixtureContext({ allowance: 0n });
  const draft = computeBridgeDraft(
    { token: `first:${FIXTURE_TOKENS[0]!.address}`, amount: "10", receiver: FIXTURE_ACCOUNT, mode: "plain", data: "", callGas: "", callbackGas: "" },
    { ...DEFAULT_DELIVERY_OPTIONS, mode: "none" },
    { pair: FIXTURE_PAIR, tokens, context, report: null, priorityFeeWei: null },
  );
  if (draft.status !== "ready") throw new Error(draft.reason ?? "not ready");
  return draft.steps;
};

/** The relay alone: the allowance step dropped. */
const relayOnly = async () => (await stepsWithApproval()).slice(-1);

const until = async (sequence: { getState(): SequenceState }, predicate: (state: SequenceState) => boolean, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 100 && !predicate(sequence.getState()); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  expect(predicate(sequence.getState()), label).toBe(true);
};
const phase = (sequence: { getState(): SequenceState }, name: SequenceState["phase"]) => until(sequence, (state) => state.phase === name, name);

describe("createTransactionSequence: the deposit gate", () => {
  it("inserts the confirmation before the relay, with its simulated gas plus the margin, and sends the relay after it", async () => {
    const gate = scripted(confirmAnswer(), NOT_NEEDED);
    const sent: { to: Address; data: Hex; gas: bigint }[] = [];
    const sequence = createTransactionSequence({
      account: FIXTURE_ACCOUNT,
      clientFor: () => client(),
      checkGate: gate.check,
      sendTransaction: async (transaction) => {
        sent.push(transaction);
        return hashOf(sent.length);
      },
    });
    sequence.start(await stepsWithApproval());
    await phase(sequence, "review");
    // The allowance does not pass the gate, so the gate is not asked for it.
    expect(gate.calls).toHaveLength(0);
    expect(sequence.getState().steps).toHaveLength(2);
    sequence.confirm();
    await until(sequence, (state) => state.phase === "review" && state.stepIndex === 1, "confirm step under review");
    expect(gate.calls).toEqual([{ chainId: FIXTURE_PAIR.first.chainId, gate: GATE, account: FIXTURE_ACCOUNT }]);
    const state = sequence.getState();
    expect(state.steps).toHaveLength(3);
    expect(state.steps[1]!.plan.title).toBe("Confirm this epoch on the gate (epoch 360335)");
    expect(state.steps[1]!.gateConfirm).toEqual({ epoch: 360_335n, gas: 150_000n, validUntil: 1_762_500_000n });
    expect(state.prepared?.gasEstimate).toBe(150_000n);
    expect(state.prepared?.gasLimit).toBe(180_000n);
    expect(state.prepared?.plan.to).toBe(getAddress(GATE));
    sequence.confirm();
    await until(sequence, (current) => current.phase === "review" && current.stepIndex === 2, "relay under review");
    expect(gate.calls).toHaveLength(2);
    expect(sent[1]).toMatchObject({ to: getAddress(GATE), data: CONFIRM_DATA, gas: 180_000n });
    sequence.confirm();
    await phase(sequence, "finished");
    expect(sent).toHaveLength(3);
    expect(sequence.getState().outcomes.map((outcome) => outcome.gateConfirm ?? false)).toEqual([false, true, false]);
  });

  it("inserts nothing when the epoch is confirmed already or the gate does not enforce", async () => {
    for (const answer of [NOT_NEEDED, { kind: "not-needed", reason: "not-enforcing", epoch: 1n } as GateConfirmation]) {
      const gate = scripted(answer);
      const sequence = createTransactionSequence({ account: FIXTURE_ACCOUNT, clientFor: () => client(), checkGate: gate.check, sendTransaction: vi.fn() });
      sequence.start(await relayOnly());
      await phase(sequence, "review");
      expect(sequence.getState().steps).toHaveLength(1);
      expect(sequence.getState().prepared?.gasEstimate).toBe(100_000n);
      expect(gate.calls).toHaveLength(1);
    }
  });

  it("asks no gate on a chain whose deployment names none", async () => {
    const steps = (await relayOnly()).map((step) => ({ ...step, plan: { ...step.plan, chain: { ...step.plan.chain, contracts: { ...step.plan.chain.contracts, gate: null } } } }));
    const gate = scripted(confirmAnswer());
    const sequence = createTransactionSequence({ account: FIXTURE_ACCOUNT, clientFor: () => client(), checkGate: gate.check, sendTransaction: vi.fn() });
    sequence.start(steps);
    await phase(sequence, "review");
    expect(gate.calls).toHaveLength(0);
  });

  it("waits a slot when the beacon header of the epoch is not on chain yet, then asks again", async () => {
    const gate = scripted({ kind: "wait", epoch: 360_335n, headerEpoch: 360_334n, retryAfterSeconds: 12 }, NOT_NEEDED);
    let release: () => void = () => undefined;
    const sleeps: number[] = [];
    const sleep = (milliseconds: number) =>
      new Promise<void>((resolve) => {
        sleeps.push(milliseconds);
        release = resolve;
      });
    const sequence = createTransactionSequence({ account: FIXTURE_ACCOUNT, clientFor: () => client(), checkGate: gate.check, sendTransaction: vi.fn(), sleep });
    sequence.start(await relayOnly());
    await phase(sequence, "waiting");
    expect(sequence.getState().gateWait).toEqual({ chainName: "Ethereum", epoch: 360_335n, seconds: 12 });
    expect(sleeps).toEqual([12_000]);
    release();
    await phase(sequence, "review");
    expect(gate.calls).toHaveLength(2);
    expect(sequence.getState().gateWait).toBeNull();
  });

  it("stops after the wait limit with the numbers", async () => {
    const gate = scripted({ kind: "wait", epoch: 7n, headerEpoch: 6n, retryAfterSeconds: 12 });
    const sequence = createTransactionSequence({ account: FIXTURE_ACCOUNT, clientFor: () => client(), checkGate: gate.check, sendTransaction: vi.fn(), sleep: async () => undefined });
    sequence.start(await relayOnly());
    await phase(sequence, "error");
    expect(gate.calls).toHaveLength(GATE_WAIT_LIMIT + 1);
    expect(sequence.getState().error).toBe("The beacon header of epoch 7 is not on Ethereum after 10 checks 12 seconds apart. Nothing was sent.");
  });

  it("asks no more after a cancel during the wait", async () => {
    const gate = scripted({ kind: "wait", epoch: 7n, headerEpoch: 6n, retryAfterSeconds: 12 });
    let release: () => void = () => undefined;
    const sequence = createTransactionSequence({
      account: FIXTURE_ACCOUNT,
      clientFor: () => client(),
      checkGate: gate.check,
      sendTransaction: vi.fn(),
      sleep: () => new Promise<void>((resolve) => (release = resolve)),
    });
    sequence.start(await relayOnly());
    await phase(sequence, "waiting");
    sequence.cancel();
    expect(sequence.getState().phase).toBe("cancelled");
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(gate.calls).toHaveLength(1);
    expect(sequence.getState().phase).toBe("cancelled");
  });

  it("uses a timer for the wait by default", async () => {
    vi.useFakeTimers();
    try {
      const gate = scripted({ kind: "wait", epoch: 7n, headerEpoch: 6n, retryAfterSeconds: 12 }, NOT_NEEDED);
      const sequence = createTransactionSequence({ account: FIXTURE_ACCOUNT, clientFor: () => client(), checkGate: gate.check, sendTransaction: vi.fn() });
      sequence.start(await relayOnly());
      await vi.advanceTimersByTimeAsync(0);
      expect(sequence.getState().phase).toBe("waiting");
      await vi.advanceTimersByTimeAsync(12_000);
      expect(sequence.getState().phase).toBe("review");
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks on a sealed gate", async () => {
    const sequence = createTransactionSequence({ account: FIXTURE_ACCOUNT, clientFor: () => client(), checkGate: scripted({ kind: "sealed", epoch: 9n }).check, sendTransaction: vi.fn() });
    sequence.start(await relayOnly());
    await phase(sequence, "error");
    expect(sequence.getState().error).toBe("The Ethereum deposit gate is sealed: it admits no send in epoch 9 or later. Nothing was sent.");
  });

  it("names the reason when the check fails, and points to the beacon endpoints when none answered", async () => {
    const beacon = new GateEvidenceError("beacon-request-failed", "no beacon endpoint answered (2 tried; last: the beacon node answered 403 for the header 0x12)");
    const sequence = createTransactionSequence({ account: FIXTURE_ACCOUNT, clientFor: () => client(), checkGate: scripted(beacon).check, sendTransaction: vi.fn() });
    sequence.start(await relayOnly());
    await phase(sequence, "error");
    expect(sequence.getState().error).toBe(
      "Could not confirm the Ethereum deposit gate: no beacon endpoint answered (2 tried; last: the beacon node answered 403 for the header 0x12). Check Settings, Beacon endpoints, then try again.",
    );
    const other = createTransactionSequence({ account: FIXTURE_ACCOUNT, clientFor: () => client(), checkGate: scripted(new GateEvidenceError("simulation-reverted", "confirm would revert")).check, sendTransaction: vi.fn() });
    other.start(await relayOnly());
    await phase(other, "error");
    expect(other.getState().error).toBe("Could not confirm the Ethereum deposit gate: confirm would revert.");
  });

  it("drops a gate answer or failure that comes after a cancel", async () => {
    for (const answer of [NOT_NEEDED, new Error("late")]) {
      let resolve: () => void = () => undefined;
      const check: GateCheck = () =>
        new Promise((done, fail) => {
          resolve = () => (answer instanceof Error ? fail(answer) : done(answer));
        });
      const estimate = vi.fn(async () => 100_000n);
      const sequence = createTransactionSequence({ account: FIXTURE_ACCOUNT, clientFor: () => client({ estimateGas: estimate }), checkGate: check, sendTransaction: vi.fn() });
      sequence.start(await relayOnly());
      await new Promise((done) => setTimeout(done, 5));
      sequence.cancel();
      resolve();
      await new Promise((done) => setTimeout(done, 10));
      expect(sequence.getState().phase).toBe("cancelled");
      expect(estimate).not.toHaveBeenCalled();
    }
  });

  it("asks the gate once more when the relay's estimate reverts with ForkNotConfirmed (the epoch rolled over), and inserts the confirmation", async () => {
    const gate = scripted(NOT_NEEDED, confirmAnswer(360_336n));
    let estimates = 0;
    const estimateGas = async () => {
      estimates += 1;
      if (estimates === 1) throw forkNotConfirmed(360_336n);
      return 100_000n;
    };
    const sequence = createTransactionSequence({ account: FIXTURE_ACCOUNT, clientFor: () => client({ estimateGas }), checkGate: gate.check, sendTransaction: vi.fn() });
    sequence.start(await relayOnly());
    await phase(sequence, "review");
    expect(gate.calls).toHaveLength(2);
    expect(sequence.getState().steps[0]!.gateConfirm?.epoch).toBe(360_336n);
  });

  it("asks once more only, then shows the decoded revert", async () => {
    const gate = scripted(NOT_NEEDED);
    const sequence = createTransactionSequence({
      account: FIXTURE_ACCOUNT,
      clientFor: () => client({ estimateGas: async () => { throw forkNotConfirmed(360_335n); } }),
      checkGate: gate.check,
      sendTransaction: vi.fn(),
    });
    sequence.start(await relayOnly());
    await phase(sequence, "error");
    expect(gate.calls).toHaveLength(2);
    expect(sequence.getState().error).toBe(
      "Could not prepare the transaction: The Ethereum deposit gate needs epoch 360335 confirmed first. A send in this epoch reverts until one transaction confirms it.",
    );
  });

  it("does not ask the gate again for a ForkNotConfirmed when no gate check is set", async () => {
    const sequence = createTransactionSequence({ account: FIXTURE_ACCOUNT, clientFor: () => client({ estimateGas: async () => { throw forkNotConfirmed(5n); } }), sendTransaction: vi.fn() });
    sequence.start(await relayOnly());
    await phase(sequence, "error");
    expect(sequence.getState().error).toContain("needs epoch 5 confirmed first");
  });

  it("lets a retry follow a reverted confirmation: the confirmation stays as mined and the gate is asked again", async () => {
    const gate = scripted(confirmAnswer(1n), confirmAnswer(2n));
    let receipts = 0;
    const sequence = createTransactionSequence({
      account: FIXTURE_ACCOUNT,
      clientFor: () =>
        client({
          waitForTransactionReceipt: async () => {
            receipts += 1;
            return { status: receipts === 1 ? "reverted" : "success", gasUsed: 1n, blockNumber: 1n };
          },
        }),
      checkGate: gate.check,
      sendTransaction: async () => hashOf(receipts + 1),
    });
    sequence.start(await relayOnly());
    await phase(sequence, "review");
    sequence.confirm();
    await phase(sequence, "error");
    const failed = sequence.getState();
    expect(failed.error).toBe(`The confirmation of epoch 1 reverted in ${hashOf(1)}. Nothing else was sent. Try again to check the gate and confirm the current epoch.`);
    expect(canRetry(failed)).toBe(true);
    sequence.retry();
    await until(sequence, (state) => state.phase === "review" && state.stepIndex === 1, "new confirmation");
    const state = sequence.getState();
    expect(state.steps.map((step) => step.gateConfirm?.epoch ?? null)).toEqual([1n, 2n, null]);
    expect(gate.calls).toHaveLength(2);
  });

  it("drops a confirmation that the wallet declined, and asks the gate again on retry", async () => {
    const gate = scripted(confirmAnswer(1n), NOT_NEEDED);
    const sequence = createTransactionSequence({
      account: FIXTURE_ACCOUNT,
      clientFor: () => client(),
      checkGate: gate.check,
      sendTransaction: async () => {
        throw new Error("User rejected the request.");
      },
    });
    sequence.start(await relayOnly());
    await phase(sequence, "review");
    sequence.confirm();
    await phase(sequence, "error");
    sequence.retry();
    await phase(sequence, "review");
    expect(sequence.getState().steps).toHaveLength(1);
    expect(sequence.getState().steps[0]!.gateConfirm).toBeUndefined();
    expect(gate.calls).toHaveLength(2);
  });

  it("still refuses a retry after a reverted transaction that is not a confirmation", () => {
    const base = { phase: "error", steps: [], stepIndex: 0, prepared: null, submittedHash: null, error: "x" } as const;
    expect(canRetry({ ...base, outcomes: [{ title: "Relay", status: "reverted", transactionHash: hashOf(1) }] })).toBe(false);
    expect(canRetry({ ...base, outcomes: [{ title: "Confirm", status: "reverted", transactionHash: hashOf(1), gateConfirm: true }] })).toBe(true);
    expect(canRetry({ ...base, phase: "review", outcomes: [] })).toBe(false);
  });
});
