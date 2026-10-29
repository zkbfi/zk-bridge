import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, keccak256, toFunctionSelector, type Hex } from "viem";
import { messageBridgeAbi, multicall3Abi } from "@zk-bridge/shared";
import { describe, expect, it } from "vitest";
import type { ReceiptLog, ReceiptSummary } from "../../src/chain/transactions.ts";
import { BATCH_ITEM_OVERHEAD_GAS, deliverItem, MAXIMUM_SETTLING_ROUNDS, sendBatch, UPDATE_GAS_FALLBACK, type UpdateOffer } from "../../src/runner/batch.ts";
import type { DeliveryDependencies, ReadyDelivery } from "../../src/runner/delivery.ts";
import { skip } from "../../src/runner/delivery.ts";
import type { PrerequisiteLedger } from "../../src/runner/prerequisite-ledger.ts";
import {
  BRIDGE,
  EXECUTED,
  FAILED_IN_BRIDGE,
  DELIVERY_ROUTER,
  LIGHT_CLIENT,
  MULTICALL,
  REWARD_ADDRESS,
  SKIPPED_INSUFFICIENT_GAS,
  UPDATE_FAILED,
  WRAPPED_NATIVE,
  emptyExecuteMessage,
  fakeChain,
  fakeIndexer,
  fakeProver,
  feedItem,
  headUpdatedLog,
  memoryLogger,
  proofMessage,
  transferLog,
  word,
  type FakeChain,
  TEST_PROOF_CHECK_GAS,
  FEED_REQUIRED_GAS,
} from "../support/builders.ts";

const AGGREGATE3 = toFunctionSelector(multicall3Abi.find((entry) => entry.type === "function" && entry.name === "aggregate3") as never);

/** The cost of one item at the single entry plus the overhead of the batch entry: 300,000 gas at 10 wei. */
const ITEM_GAS = 300_000n;
const ITEM_COST_WEI = 3_000_000n;
/** The fee of an item, in wei: well above its cost, and above the cost of an update as well. */
const FEE_WEI = 10_000_000n;

/** A ledger that keeps every call it receives, in order. */
function recordingLedger(): PrerequisiteLedger & { readonly calls: Array<{ readonly method: string; readonly wei: bigint }> } {
  const calls: Array<{ readonly method: string; readonly wei: bigint }> = [];
  const unused = async (): Promise<never> => {
    throw new Error("the batch never uses this method of the ledger");
  };
  return {
    calls,
    capWei: 0n,
    spentWei: 0n,
    refusal: unused,
    reserve: unused,
    settle: unused,
    async recordLoss(wei) {
      calls.push({ method: "recordLoss", wei });
    },
    async reserveDelivery(wei) {
      calls.push({ method: "reserveDelivery", wei });
      return { id: "reservation", wei };
    },
    async settleDelivery(_reservation, actualWei) {
      calls.push({ method: "settleDelivery", wei: actualWei });
    },
    async deliverySpendWei() {
      return 0n;
    },
  };
}

/** A chain and the dependencies of a batch on it. An item costs 3,000,000 wei and its fee is 10,000,000 wei. */
function setup(options: { deliveryRouter?: DeliveryDependencies["deliveryRouter"]; rewardAddress?: DeliveryDependencies["rewardAddress"]; multicall?: DeliveryDependencies["multicall"] } = {}) {
  const chain = fakeChain();
  chain.executionGas = ITEM_GAS - BATCH_ITEM_OVERHEAD_GAS;
  chain.feeTokens = FEE_WEI;
  const { logger, events } = memoryLogger();
  const dependencies: DeliveryDependencies = {
    direction: "first-to-second",
    sourceChainId: 1,
    chain,
    prover: fakeProver(),
    indexer: fakeIndexer([], {}),
    source: { findMessageLogIndex: async () => 0 },
    deliveryRouter: options.deliveryRouter === undefined ? DELIVERY_ROUTER : options.deliveryRouter,
    multicall: options.multicall === undefined ? MULTICALL : options.multicall,
    rewardAddress: options.rewardAddress === undefined ? REWARD_ADDRESS : options.rewardAddress,
    wrappedNative: WRAPPED_NATIVE,
    tokenFactory: null,
    settings: {
      maximumLossPercent: 20,
      deliverWithoutOffer: false,
      tokenValuationsWei: {},
      proofCheckGas: TEST_PROOF_CHECK_GAS,
      maximumPrerequisiteRounds: 3,
      prerequisiteGasFallback: ITEM_GAS,
      maximumPrerequisiteSpendPerSweepWei: 10n ** 18n,
      maximumPrerequisiteSpendPerDayWei: 10n ** 18n,
      maximumUnrecoveredPrerequisiteLossWei: 10n ** 18n,
      maximumBatchSize: 5,
      maximumBatchGas: 6_000_000n,
    },
    logger,
  };
  return { chain, dependencies, events, ledger: recordingLedger() };
}

/** An item that waits for a batch. The slot of the anchor header of its proof is its number, which names its message. */
function readyItem(id: number, options: { prerequisiteCostWei?: bigint } = {}): ReadyDelivery {
  const decoded = decodeFunctionData({ abi: messageBridgeAbi, data: emptyExecuteMessage(BigInt(id)) });
  if (decoded.functionName !== "executeMessage") throw new Error("the builder must make an executeMessage call");
  return {
    item: feedItem({ id, token: WRAPPED_NATIVE }),
    messageId: word(id),
    offer: { kind: "offer", director: { recipient: REWARD_ADDRESS, settings: 1n, limit: 10n, multiplier: 0n }, value: 1000n, call: null },
    proof: decoded.args[0],
    requiredGas: FEED_REQUIRED_GAS,
    assumedGas: ITEM_GAS,
    prerequisiteCostWei: options.prerequisiteCostWei ?? 0n,
  };
}

const updateOffer = (): UpdateOffer => ({ message: proofMessage({ startSlot: 100n, newSlot: 164n }), lightClient: LIGHT_CLIENT });

/** Changes what the chain answers to the read-only runs of the batch. The read counts from one. */
function interceptReads(chain: FakeChain, intercept: (read: number, original: () => Promise<Hex>) => Promise<Hex>): void {
  const original = chain.call.bind(chain);
  let reads = 0;
  chain.call = (request) => {
    if (!request.data.startsWith(AGGREGATE3)) return original(request);
    reads += 1;
    return intercept(reads, () => original(request));
  };
}

/** Changes the logs of the receipt that the chain returns for a send. */
function rewriteReceiptLogs(chain: FakeChain, rewrite: (logs: readonly ReceiptLog[]) => readonly ReceiptLog[]): void {
  const original = chain.send.bind(chain);
  chain.send = async (request): Promise<ReceiptSummary> => {
    const receipt = await original(request);
    return { ...receipt, logs: [...rewrite(receipt.logs)] };
  };
}

const MINED = word(0xee);

describe("the configuration that a batch needs", () => {
  it.each([
    ["the delivery router", { deliveryRouter: null }],
    ["the reward address", { rewardAddress: null }],
    ["the Multicall3 address", { multicall: null }],
  ])("refuses to start without %s, and touches neither the chain nor the ledger", async (_name, missing) => {
    const { chain, dependencies, ledger } = setup(missing);
    await expect(sendBatch(dependencies, ledger, { readies: [readyItem(1)], update: null })).rejects.toThrow(
      "a batch needs a delivery router, a reward address and a Multicall3 address, and the runner has none",
    );
    expect(chain.log).toEqual([]);
    expect(ledger.calls).toEqual([]);
  });
});

describe("the read of the results of a batch", () => {
  it("drops every item when Multicall3 returns fewer results than the batch has calls", async () => {
    const { chain, dependencies, ledger } = setup();
    interceptReads(chain, async () => encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: [{ success: true, returnData: "0x" }] }));
    const report = await sendBatch(dependencies, ledger, { readies: [readyItem(1), readyItem(2)], update: null });
    const detail = "Multicall3 returned 1 results for 2 calls";
    expect(report).toEqual({
      outcomes: [skip(word(1), "simulation-reverted", { detail }), skip(word(2), "simulation-reverted", { detail })],
      update: { kind: "not-offered" },
    });
    // The intercepted read never reaches the log of the fake chain.
    expect(chain.log.map((entry) => entry.kind)).toEqual(["simulate"]);
  });

  it("counts the update as a call, and keeps the update pending when the count is wrong", async () => {
    const { chain, dependencies, ledger } = setup();
    interceptReads(chain, async () =>
      encodeFunctionResult({
        abi: multicall3Abi,
        functionName: "aggregate3",
        result: [
          { success: true, returnData: "0x" },
          { success: true, returnData: "0x" },
        ],
      }),
    );
    const report = await sendBatch(dependencies, ledger, { readies: [readyItem(1), readyItem(2)], update: updateOffer() });
    const detail = "Multicall3 returned 2 results for 3 calls";
    expect(report).toEqual({
      outcomes: [skip(word(1), "simulation-reverted", { detail }), skip(word(2), "simulation-reverted", { detail })],
      update: { kind: "dropped", reason: "no-batch", detail: "no transaction was sent" },
    });
  });

  it.each([
    ["an error", new Error("rpc is down"), "rpc is down"],
    ["a value that is no error", "plain failure", "plain failure"],
  ])("drops every item with the reason when the first read throws %s", async (_name, thrown, detail) => {
    const { chain, dependencies, ledger } = setup();
    interceptReads(chain, async () => {
      throw thrown;
    });
    const report = await sendBatch(dependencies, ledger, { readies: [readyItem(1)], update: null });
    expect(report.outcomes).toEqual([skip(word(1), "simulation-reverted", { detail })]);
    // The intercepted read never reaches the log of the fake chain.
    expect(chain.log.map((entry) => entry.kind)).toEqual(["simulate"]);
  });

  it("drops every item when the read under the gas limit of the send throws, and sends nothing", async () => {
    const { chain, dependencies, ledger } = setup();
    interceptReads(chain, (read, original) => (read === 1 ? original() : Promise.reject(new Error("out of gas at the limit"))));
    const report = await sendBatch(dependencies, ledger, { readies: [readyItem(1), readyItem(2)], update: null });
    const detail = "out of gas at the limit";
    expect(report.outcomes).toEqual([skip(word(1), "simulation-reverted", { detail }), skip(word(2), "simulation-reverted", { detail })]);
    // Batch, first read, one measure for each item, one fee question for each item. The second read throws. No send.
    expect(chain.log.map((entry) => entry.kind)).toEqual(["simulate", "call", "simulate", "simulate", "call", "call"]);
    expect(ledger.calls).toEqual([]);
  });
});

describe("the revert data of a failed call", () => {
  it.each([
    ["an error that no ABI of this build holds", "0xdeadbeef" as Hex],
    ["empty revert data", "0x" as Hex],
  ])("names %s as unknown and carries the hash of the data", async (_name, returnData) => {
    const { chain, dependencies, ledger } = setup();
    chain.batchResult = (position, count) => (count === 2 && position === 0 ? { success: false, returnData } : EXECUTED);
    const report = await sendBatch(dependencies, ledger, { readies: [readyItem(1), readyItem(2)], update: null });
    expect(report.outcomes[0]).toEqual(
      skip(word(1), "simulation-reverted", { detail: `the call reverted: an error that this build does not know, keccak256 of the revert data is ${keccak256(returnData)}` }),
    );
    expect(report.outcomes[1]).toMatchObject({ status: "delivered", messageId: word(2) });
  });

  it("names a known error that has no skip of its own", async () => {
    const { chain, dependencies, ledger } = setup();
    chain.batchResult = (position, count) => (count === 1 && position === 0 ? FAILED_IN_BRIDGE : EXECUTED);
    const report = await sendBatch(dependencies, ledger, { readies: [readyItem(1)], update: null });
    expect(report.outcomes).toEqual([
      skip(word(1), "simulation-reverted", { detail: `the call reverted: IndexMismatch, keccak256 of the revert data is ${keccak256(FAILED_IN_BRIDGE.returnData)}` }),
    ]);
  });
});

describe("the read under the gas limit of the send", () => {
  it("drops the update that the light client refuses only at the limit, then sends the items without it", async () => {
    const { chain, dependencies, ledger, events } = setup();
    chain.receiptLogsOfItem = () => [transferLog(WRAPPED_NATIVE, REWARD_ADDRESS, 7n)];
    interceptReads(chain, (read, original) => {
      if (read === 2) chain.updateResult = UPDATE_FAILED;
      return original();
    });
    const report = await sendBatch(dependencies, ledger, { readies: [readyItem(1)], update: updateOffer() });
    expect(report.update).toEqual({
      kind: "dropped",
      reason: "update-failed",
      detail: `the light client reverted: InvalidPublicValuesLength, keccak256 of the revert data is ${keccak256(UPDATE_FAILED.returnData)}`,
    });
    expect(report.outcomes).toEqual([
      {
        status: "delivered",
        messageId: word(1),
        path: "delivery-router",
        transactionHash: MINED,
        gasUsed: ITEM_GAS,
        gasCostWei: ITEM_COST_WEI,
        prerequisiteCostWei: 0n,
        feeExpectedWei: FEE_WEI,
        feeReceivedTokens: 7n,
      },
    ]);
    // The batch that went out has the item and no update call.
    const sent = chain.log.filter((entry) => entry.kind === "send");
    expect(sent).toHaveLength(1);
    const decoded = decodeFunctionData({ abi: multicall3Abi, data: sent[0]?.request.data as Hex });
    expect(decoded.functionName === "aggregate3" ? decoded.args[0].map((call) => call.target) : []).toEqual([DELIVERY_ROUTER]);
    expect(events().filter((event) => event.event === "delivery_batch_mined")).toHaveLength(1);
  });

  it("drops the items that the limit starves, and sends the rest", async () => {
    const { chain, dependencies, ledger } = setup();
    chain.receiptResult = () => EXECUTED;
    interceptReads(chain, (read, original) => {
      if (read === 2) chain.batchResult = (position, count) => (count === 2 && position === 0 ? SKIPPED_INSUFFICIENT_GAS : EXECUTED);
      return original();
    });
    const report = await sendBatch(dependencies, ledger, { readies: [readyItem(1), readyItem(2)], update: null });
    expect(report.outcomes[0]).toEqual(skip(word(1), "insufficient-gas", { detail: "the gas left does not cover the gas limit of the message" }));
    expect(report.outcomes[1]).toMatchObject({ status: "delivered", messageId: word(2), gasUsed: ITEM_GAS });
    expect(chain.log.filter((entry) => entry.kind === "send")).toHaveLength(1);
  });

  it("sizes the gas limit from the simulation of the batch when that is above the sum of the items, with the buffer of 30 percent", async () => {
    const { chain, dependencies, ledger } = setup();
    chain.gas = 2_000_000n;
    await sendBatch(dependencies, ledger, { readies: [readyItem(1)], update: null });
    expect(chain.sentTerms).toEqual([{ gas: 2_600_000n, maxFeePerGas: 20n, maxPriorityFeePerGas: 0n }]);
    // The ledger reserves the worst case of exactly these terms.
    expect(ledger.calls[0]).toEqual({ method: "reserveDelivery", wei: 2_600_000n * 20n });
  });

  it("sizes the gas limit from the sum of the items and the update when that is above the simulation of the batch", async () => {
    const { chain, dependencies, ledger } = setup();
    await sendBatch(dependencies, ledger, { readies: [readyItem(1)], update: updateOffer() });
    // The batch simulates at 300,000. The item (300,000) and the update (300,000) need 600,000, and 30 percent more.
    expect(chain.sentTerms).toEqual([{ gas: 780_000n, maxFeePerGas: 20n, maxPriorityFeePerGas: 0n }]);
  });
});

describe("the gas of the update", () => {
  it("assumes the fallback gas when the update cannot be simulated alone, and splits the transaction by that weight", async () => {
    const { chain, dependencies, ledger } = setup();
    chain.simulateOverride = (request) => (request.to === LIGHT_CLIENT ? { ok: false, reason: "the update reverts alone" } : undefined);
    chain.gasUsed = ITEM_GAS + UPDATE_GAS_FALLBACK;
    const report = await sendBatch(dependencies, ledger, { readies: [readyItem(1)], update: updateOffer() });
    expect(report.update).toEqual({ kind: "mined", applied: true, transactionHash: MINED, gasUsed: UPDATE_GAS_FALLBACK, gasCostWei: UPDATE_GAS_FALLBACK * 10n });
    expect(report.outcomes[0]).toMatchObject({ status: "delivered", gasUsed: ITEM_GAS, gasCostWei: ITEM_COST_WEI });
    // An applied update is no loss.
    expect(ledger.calls.filter((call) => call.method === "recordLoss")).toEqual([]);
  });
});

describe("the receipt of a batch", () => {
  it("fails every item of a reverted transaction, books the layout cost with the cost of the transaction, and drops the update", async () => {
    const { chain, dependencies, ledger } = setup();
    chain.receiptSuccess = false;
    const report = await sendBatch(dependencies, ledger, { readies: [readyItem(1, { prerequisiteCostWei: 500n }), readyItem(2)], update: updateOffer() });
    expect(report).toEqual({
      outcomes: [
        { status: "failed", messageId: word(1), reason: "transaction-reverted", transactionHash: MINED, prerequisiteCostWei: 500n },
        { status: "failed", messageId: word(2), reason: "transaction-reverted", transactionHash: MINED },
      ],
      update: { kind: "dropped", reason: "update-failed", detail: `the transaction ${MINED} reverted` },
    });
    // The transaction cost 300,000 gas at 10 wei.
    expect(ledger.calls.filter((call) => call.method === "recordLoss")).toEqual([{ method: "recordLoss", wei: 3_000_000n + 500n }]);
  });

  it("fails an item that the bridge did not execute, books its layout cost and its share, and says nothing of an event of another kind", async () => {
    const { chain, dependencies, ledger, events } = setup();
    chain.gasUsed = 2n * ITEM_GAS;
    chain.receiptResult = (position) => (position === 0 ? EXECUTED : FAILED_IN_BRIDGE);
    // The bridge writes an event for the second message, but not the one of execution.
    const requested: ReceiptLog = {
      address: BRIDGE,
      topics: encodeEventTopics({ abi: messageBridgeAbi, eventName: "UserRequestForAffirmation", args: { messageId: word(2) } }) as Hex[],
      data: encodeAbiParameters([{ type: "bytes" }], ["0x1234"]),
    };
    rewriteReceiptLogs(chain, (logs) => [requested, ...logs]);
    const report = await sendBatch(dependencies, ledger, { readies: [readyItem(1), readyItem(2, { prerequisiteCostWei: 700n })], update: null });
    expect(report.outcomes[0]).toMatchObject({ status: "delivered", messageId: word(1), gasUsed: ITEM_GAS });
    expect(report.outcomes[1]).toEqual({ status: "failed", messageId: word(2), reason: "batch-result-missing", transactionHash: MINED, prerequisiteCostWei: 700n });
    // The layout cost of the item, then the half of the cost of the transaction (6,000,000 wei) that belongs to it.
    expect(ledger.calls.filter((call) => call.method === "recordLoss")).toEqual([
      { method: "recordLoss", wei: 700n },
      { method: "recordLoss", wei: 3_000_000n },
    ]);
    expect(events().filter((event) => event.event === "delivery_batch_loss")).toMatchObject([{ level: "warn", transactionHash: MINED, lossWei: "3000000" }]);
  });

  it("reports no fee tokens for an executed item whose release of tokens the receipt does not show", async () => {
    const { chain, dependencies, ledger } = setup();
    rewriteReceiptLogs(chain, (logs) => logs.filter((log) => log.address === BRIDGE));
    const report = await sendBatch(dependencies, ledger, { readies: [readyItem(1)], update: null });
    expect(report.outcomes).toEqual([
      {
        status: "delivered",
        messageId: word(1),
        path: "delivery-router",
        transactionHash: MINED,
        gasUsed: ITEM_GAS,
        gasCostWei: ITEM_COST_WEI,
        prerequisiteCostWei: 0n,
        feeExpectedWei: FEE_WEI,
        feeReceivedTokens: null,
      },
    ]);
  });

  const wrongHeadLogs: Array<[string, (logs: readonly ReceiptLog[]) => readonly ReceiptLog[]]> = [
    ["a log of the light client that is no event of it", (logs) => logs.map((log) => (log.address === LIGHT_CLIENT ? { address: LIGHT_CLIENT, topics: [word(0x99)], data: "0x" } : log))],
    ["a head that is not the slot of the update", (logs) => logs.map((log) => (log.address === LIGHT_CLIENT ? headUpdatedLog(999n) : log))],
  ];
  it.each(wrongHeadLogs)("counts the update as not applied when the receipt shows %s, and books its share as a loss", async (_name, rewrite) => {
    const { chain, dependencies, ledger } = setup();
    chain.gasUsed = 2n * ITEM_GAS;
    rewriteReceiptLogs(chain, rewrite);
    const report = await sendBatch(dependencies, ledger, { readies: [readyItem(1)], update: updateOffer() });
    expect(report.update).toEqual({ kind: "mined", applied: false, transactionHash: MINED, gasUsed: ITEM_GAS, gasCostWei: ITEM_COST_WEI });
    expect(ledger.calls.filter((call) => call.method === "recordLoss")).toEqual([{ method: "recordLoss", wei: ITEM_COST_WEI }]);
  });
});

describe("the settling rounds", () => {
  it("skips an item that is still in flux after the last round, and keeps the update pending", async () => {
    const { chain, dependencies, ledger } = setup();
    // Each round one more item of five fails alone: the batch never settles within the rounds.
    chain.batchResult = (position, count) => (position === count - 1 && count > 2 ? SKIPPED_INSUFFICIENT_GAS : EXECUTED);
    const report = await sendBatch(dependencies, ledger, { readies: [readyItem(1), readyItem(2), readyItem(3), readyItem(4), readyItem(5)], update: null });
    expect(MAXIMUM_SETTLING_ROUNDS).toBe(3);
    expect(report.outcomes.map((outcome) => (outcome.status === "skipped" ? outcome.reason : outcome.status))).toEqual([
      "batch-did-not-settle",
      "batch-did-not-settle",
      "insufficient-gas",
      "insufficient-gas",
      "insufficient-gas",
    ]);
    expect(chain.log.filter((entry) => entry.kind === "send")).toEqual([]);
  });
});

describe("delivery of a single item", () => {
  it("returns the skip of the preparation when the message offers no fee, and sends nothing", async () => {
    const { chain, dependencies, ledger } = setup();
    const item = feedItem({ id: 1, token: WRAPPED_NATIVE });
    const withIndexer: DeliveryDependencies = { ...dependencies, indexer: fakeIndexer([item], {}) };
    const outcome = await deliverItem(withIndexer, item, ledger);
    expect(outcome).toEqual(skip(word(1), "no-fee-offer", { detail: "not-a-token-message" }));
    expect(chain.log).toEqual([]);
  });
});
