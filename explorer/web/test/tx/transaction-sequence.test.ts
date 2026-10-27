import type { Address, Hash } from "viem";
import { describe, expect, it, vi } from "vitest";
import { FIXTURE_ACCOUNT, FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import { computeBridgeDraft, DEFAULT_DELIVERY_OPTIONS } from "../../src/tx/bridge-draft";
import { createTransactionSequence, type SequenceChainClient, type SequenceState } from "../../src/tx/transaction-sequence";
import { buildFixtureContext } from "../helpers";

const HASH_ONE: Hash = `0x${"01".repeat(32)}`;
const HASH_TWO: Hash = `0x${"02".repeat(32)}`;

const client = (status: "success" | "reverted" = "success"): SequenceChainClient => ({
  estimateGas: async () => 100_000n,
  getTransactionCount: async () => 3,
  estimateFeesPerGas: async () => ({ maxFeePerGas: 20n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n }),
  waitForTransactionReceipt: async () => ({ status, gasUsed: 90_000n, blockNumber: 5n }),
});

const stepsWithApproval = async () => {
  const { context, tokens } = await buildFixtureContext({ allowance: 0n });
  const draft = computeBridgeDraft(
    { token: `first:${FIXTURE_TOKENS[0]!.address}`, amount: "10", receiver: FIXTURE_ACCOUNT, mode: "plain", data: "", gasLimit: "" },
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

describe("createTransactionSequence", () => {
  it("prepares the first step and stops at the review, with nothing sent to the wallet", async () => {
    const send = vi.fn();
    const sequence = createTransactionSequence({ account: FIXTURE_ACCOUNT, clientFor: () => client(), sendTransaction: send });
    sequence.start(await stepsWithApproval());
    await until(sequence, "review");
    expect(send).not.toHaveBeenCalled();
    expect(sequence.getState().prepared?.gasLimit).toBe(120_000n);
    expect(sequence.getState().prepared?.maximumNetworkFee).toBe(120_000n * 20n * 10n ** 9n);
  });

  it("hands a transaction to the wallet only on confirm, then goes on to the next step in order", async () => {
    const sent: { to: Address; chainId: number }[] = [];
    const hashes = [HASH_ONE, HASH_TWO];
    const sequence = createTransactionSequence({
      account: FIXTURE_ACCOUNT,
      clientFor: () => client(),
      sendTransaction: async (transaction) => {
        sent.push({ to: transaction.to, chainId: transaction.chainId });
        return hashes[sent.length - 1]!;
      },
    });
    sequence.start(await stepsWithApproval());
    await until(sequence, "review");
    sequence.confirm();
    await until(sequence, "review");
    expect(sequence.getState().stepIndex).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to.toLowerCase()).toBe(FIXTURE_TOKENS[0]!.address.toLowerCase());
    sequence.confirm();
    await until(sequence, "finished");
    expect(sent).toHaveLength(2);
    expect(sequence.getState().outcomes.map((outcome) => outcome.transactionHash)).toEqual([HASH_ONE, HASH_TWO]);
  });

  it("ignores a confirm outside the review phase", async () => {
    const send = vi.fn();
    const sequence = createTransactionSequence({ account: FIXTURE_ACCOUNT, clientFor: () => client(), sendTransaction: send });
    sequence.confirm();
    sequence.start(await stepsWithApproval());
    sequence.confirm();
    await until(sequence, "review");
    expect(send).not.toHaveBeenCalled();
  });

  it("stops with the reason when the wallet declines, and sends nothing more", async () => {
    const sequence = createTransactionSequence({
      account: FIXTURE_ACCOUNT,
      clientFor: () => client(),
      sendTransaction: async () => {
        throw new Error("User rejected the request.");
      },
    });
    sequence.start(await stepsWithApproval());
    await until(sequence, "review");
    sequence.confirm();
    await until(sequence, "error");
    expect(sequence.getState().error).toContain("User rejected");
    expect(sequence.getState().outcomes).toEqual([]);
  });

  it("stops after a reverted transaction and does not offer a retry of the same step", async () => {
    const sequence = createTransactionSequence({ account: FIXTURE_ACCOUNT, clientFor: () => client("reverted"), sendTransaction: async () => HASH_ONE });
    sequence.start(await stepsWithApproval());
    await until(sequence, "review");
    sequence.confirm();
    await until(sequence, "error");
    expect(sequence.getState().error).toMatch(/reverted/);
    sequence.retry();
    expect(sequence.getState().phase).toBe("error");
  });

  it("shows the node's reason when the estimate fails, before anything is signed", async () => {
    const failing: SequenceChainClient = { ...client(), estimateGas: async () => { throw new Error("execution reverted: allowance"); } };
    const sequence = createTransactionSequence({ account: FIXTURE_ACCOUNT, clientFor: () => failing, sendTransaction: vi.fn() });
    sequence.start(await stepsWithApproval());
    await until(sequence, "error");
    expect(sequence.getState().error).toContain("execution reverted: allowance");
  });

  it("does not cancel once the wallet holds the transaction", async () => {
    let release: (hash: Hash) => void = () => undefined;
    const sequence = createTransactionSequence({ account: FIXTURE_ACCOUNT, clientFor: () => client(), sendTransaction: () => new Promise<Hash>((resolve) => { release = resolve; }) });
    sequence.start(await stepsWithApproval());
    await until(sequence, "review");
    sequence.confirm();
    sequence.cancel();
    expect(sequence.getState().phase).toBe("wallet");
    release(HASH_ONE);
  });
});
