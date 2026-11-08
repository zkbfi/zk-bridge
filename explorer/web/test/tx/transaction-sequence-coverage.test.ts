import type { Hash } from "viem";
import { describe, expect, it, vi } from "vitest";
import { FIXTURE_ACCOUNT, FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import { computeBridgeDraft, DEFAULT_DELIVERY_OPTIONS } from "../../src/tx/bridge-draft";
import { createTransactionSequence, type SequenceChainClient, type SequenceState } from "../../src/tx/transaction-sequence";
import { buildFixtureContext } from "../helpers";

const HASH_ONE: Hash = `0x${"01".repeat(32)}`;
const HASH_TWO: Hash = `0x${"02".repeat(32)}`;

const client = (overrides: Partial<SequenceChainClient> = {}): SequenceChainClient => ({
  estimateGas: async () => 100_000n,
  getTransactionCount: async () => 3,
  estimateFeesPerGas: async () => ({ maxFeePerGas: 20n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n }),
  waitForTransactionReceipt: async () => ({ status: "success", gasUsed: 90_000n, blockNumber: 5n }),
  ...overrides,
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

const until = async (sequence: { getState(): SequenceState }, phase: SequenceState["phase"]): Promise<void> => {
  for (let attempt = 0; attempt < 50 && sequence.getState().phase !== phase; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  expect(sequence.getState().phase).toBe(phase);
};

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

describe("createTransactionSequence: listeners", () => {
  it("tells a listener about each change and stops after the unsubscribe", async () => {
    const sequence = createTransactionSequence({ account: FIXTURE_ACCOUNT, clientFor: () => client(), sendTransaction: vi.fn() });
    const phases: string[] = [];
    const unsubscribe = sequence.subscribe(() => phases.push(sequence.getState().phase));
    sequence.start(await stepsWithApproval());
    await until(sequence, "review");
    expect(phases).toEqual(["preparing", "preparing", "review"]);
    unsubscribe();
    sequence.cancel();
    expect(sequence.getState().phase).toBe("cancelled");
    expect(phases).toHaveLength(3);
  });
});

describe("createTransactionSequence: start", () => {
  it("ignores a second start while a transaction is under review", async () => {
    const sequence = createTransactionSequence({ account: FIXTURE_ACCOUNT, clientFor: () => client(), sendTransaction: vi.fn() });
    const steps = await stepsWithApproval();
    sequence.start(steps);
    await until(sequence, "review");
    sequence.start(steps.slice(1));
    expect(sequence.getState().steps).toHaveLength(steps.length);
    expect(sequence.getState().phase).toBe("review");
  });

  it("starts again after a cancel, with fresh steps and no old outcome", async () => {
    const sequence = createTransactionSequence({ account: FIXTURE_ACCOUNT, clientFor: () => client(), sendTransaction: vi.fn() });
    const steps = await stepsWithApproval();
    sequence.start(steps);
    await until(sequence, "review");
    sequence.cancel();
    sequence.start(steps.slice(1));
    await until(sequence, "review");
    expect(sequence.getState().steps).toHaveLength(steps.length - 1);
    expect(sequence.getState().stepIndex).toBe(0);
  });

  it("starts again after a finished sequence", async () => {
    const hashes = [HASH_ONE, HASH_TWO];
    let count = 0;
    const sequence = createTransactionSequence({ account: FIXTURE_ACCOUNT, clientFor: () => client(), sendTransaction: async () => hashes[count++]! });
    const steps = await stepsWithApproval();
    sequence.start(steps.slice(1));
    await until(sequence, "review");
    sequence.confirm();
    await until(sequence, "finished");
    expect(sequence.getState().outcomes).toHaveLength(1);
    sequence.start(steps);
    expect(sequence.getState().outcomes).toEqual([]);
    await until(sequence, "review");
    expect(sequence.getState().steps).toHaveLength(steps.length);
  });
});

describe("createTransactionSequence: retry and cancel", () => {
  it("prepares the same step again after a failed estimate, and reaches the review", async () => {
    let calls = 0;
    const flaky = client({
      estimateGas: async () => {
        calls += 1;
        if (calls === 1) throw new Error("node busy");
        return 100_000n;
      },
    });
    const sequence = createTransactionSequence({ account: FIXTURE_ACCOUNT, clientFor: () => flaky, sendTransaction: vi.fn() });
    sequence.start(await stepsWithApproval());
    await until(sequence, "error");
    expect(sequence.getState().error).toBe("Could not prepare the transaction: node busy");
    sequence.retry();
    await until(sequence, "review");
    expect(sequence.getState().error).toBeNull();
    expect(sequence.getState().stepIndex).toBe(0);
    expect(sequence.getState().prepared?.gasLimit).toBe(120_000n);
  });

  it("ignores a retry outside the error phase", async () => {
    const estimate = vi.fn(async () => 100_000n);
    const sequence = createTransactionSequence({ account: FIXTURE_ACCOUNT, clientFor: () => client({ estimateGas: estimate }), sendTransaction: vi.fn() });
    sequence.start(await stepsWithApproval());
    await until(sequence, "review");
    sequence.retry();
    await settle();
    expect(estimate).toHaveBeenCalledTimes(1);
  });

  it("keeps the earlier outcomes when a retry follows a declined second transaction", async () => {
    let sends = 0;
    const sequence = createTransactionSequence({
      account: FIXTURE_ACCOUNT,
      clientFor: () => client(),
      sendTransaction: async () => {
        sends += 1;
        if (sends === 2) throw new Error("User rejected the request.");
        return HASH_ONE;
      },
    });
    sequence.start(await stepsWithApproval());
    await until(sequence, "review");
    sequence.confirm();
    await until(sequence, "review");
    sequence.confirm();
    await until(sequence, "error");
    expect(sequence.getState().error).toBe("Not sent: User rejected the request.");
    sequence.retry();
    await until(sequence, "review");
    expect(sequence.getState().stepIndex).toBe(1);
    expect(sequence.getState().outcomes.map((outcome) => outcome.transactionHash)).toEqual([HASH_ONE]);
  });

  it("writes a thrown value that is not an Error as text", async () => {
    const sequence = createTransactionSequence({
      account: FIXTURE_ACCOUNT,
      clientFor: () => client(),
      sendTransaction: () => Promise.reject("plain text refusal"),
    });
    sequence.start(await stepsWithApproval());
    await until(sequence, "review");
    sequence.confirm();
    await until(sequence, "error");
    expect(sequence.getState().error).toBe("Not sent: plain text refusal");
  });

  it("cancels a transaction under review and drops the prepared data", async () => {
    const send = vi.fn();
    const sequence = createTransactionSequence({ account: FIXTURE_ACCOUNT, clientFor: () => client(), sendTransaction: send });
    sequence.start(await stepsWithApproval());
    await until(sequence, "review");
    sequence.cancel();
    expect(sequence.getState().phase).toBe("cancelled");
    expect(sequence.getState().prepared).toBeNull();
    sequence.confirm();
    expect(send).not.toHaveBeenCalled();
  });

  it("ignores a cancel when nothing runs", () => {
    const sequence = createTransactionSequence({ account: FIXTURE_ACCOUNT, clientFor: () => client(), sendTransaction: vi.fn() });
    sequence.cancel();
    expect(sequence.getState().phase).toBe("idle");
  });

  it("drops the result of an estimate that finishes after a cancel", async () => {
    let release: (gas: bigint) => void = () => undefined;
    const slow = client({ estimateGas: () => new Promise<bigint>((resolve) => { release = resolve; }) });
    const sequence = createTransactionSequence({ account: FIXTURE_ACCOUNT, clientFor: () => slow, sendTransaction: vi.fn() });
    sequence.start(await stepsWithApproval());
    await until(sequence, "preparing");
    await settle();
    sequence.cancel();
    release(100_000n);
    await settle();
    expect(sequence.getState().phase).toBe("cancelled");
    expect(sequence.getState().prepared).toBeNull();
  });

  it("drops the failure of an estimate that fails after a cancel", async () => {
    let fail: (error: Error) => void = () => undefined;
    const slow = client({ estimateGas: () => new Promise<bigint>((_resolve, reject) => { fail = reject; }) });
    const sequence = createTransactionSequence({ account: FIXTURE_ACCOUNT, clientFor: () => slow, sendTransaction: vi.fn() });
    sequence.start(await stepsWithApproval());
    await until(sequence, "preparing");
    await settle();
    sequence.cancel();
    fail(new Error("late failure"));
    await settle();
    expect(sequence.getState().phase).toBe("cancelled");
    expect(sequence.getState().error).toBeNull();
  });
});

describe("createTransactionSequence: confirmation", () => {
  it("holds the hash while it waits for the receipt, and sends the prepared gas limit", async () => {
    let release: (receipt: { status: "success"; gasUsed: bigint; blockNumber: bigint }) => void = () => undefined;
    const sendTransaction = vi.fn(async () => HASH_ONE);
    const waiting = client({ waitForTransactionReceipt: () => new Promise((resolve) => { release = resolve; }) });
    const sequence = createTransactionSequence({ account: FIXTURE_ACCOUNT, clientFor: () => waiting, sendTransaction });
    sequence.start(await stepsWithApproval());
    await until(sequence, "review");
    sequence.confirm();
    await until(sequence, "confirming");
    expect(sequence.getState().submittedHash).toBe(HASH_ONE);
    expect(sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ gas: 120_000n, value: 0n }));
    sequence.cancel();
    expect(sequence.getState().phase).toBe("confirming");
    release({ status: "success", gasUsed: 90_000n, blockNumber: 6n });
    await until(sequence, "review");
  });

  it("records a reverted transaction with its hash and names the hash in the error", async () => {
    const reverted = client({ waitForTransactionReceipt: async () => ({ status: "reverted", gasUsed: 90_000n, blockNumber: 5n }) });
    const sequence = createTransactionSequence({ account: FIXTURE_ACCOUNT, clientFor: () => reverted, sendTransaction: async () => HASH_ONE });
    sequence.start(await stepsWithApproval());
    await until(sequence, "review");
    sequence.confirm();
    await until(sequence, "error");
    expect(sequence.getState().error).toBe(`The transaction ${HASH_ONE} reverted.`);
    expect(sequence.getState().outcomes).toEqual([
      { title: sequence.getState().steps[0]!.plan.title, status: "reverted", transactionHash: HASH_ONE },
    ]);
  });

  it("reports a failed wait for the receipt as not sent and clears the hash", async () => {
    const broken = client({ waitForTransactionReceipt: async () => { throw new Error("receipt lookup failed"); } });
    const sequence = createTransactionSequence({ account: FIXTURE_ACCOUNT, clientFor: () => broken, sendTransaction: async () => HASH_ONE });
    sequence.start(await stepsWithApproval());
    await until(sequence, "review");
    sequence.confirm();
    await until(sequence, "error");
    expect(sequence.getState().error).toBe("Not sent: receipt lookup failed");
    expect(sequence.getState().submittedHash).toBeNull();
  });
});
