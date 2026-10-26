import { encodeFunctionData, type Hex } from "viem";
import { messageBridgeAbi } from "@zk-bridge/shared";
import { describe, expect, it } from "vitest";
import type { FeedItem } from "../../src/indexer/client.ts";
import { prepareItem, type DeliveryDependencies } from "../../src/runner/delivery.ts";
import { createPrerequisiteLedger } from "../../src/runner/prerequisite-ledger.ts";
import type { PrerequisiteBudgetState } from "../../src/runner/state.ts";
import { BRIDGE, MULTICALL, REWARD_ADDRESS, WRAPPED_NATIVE, address, emptyExecuteMessage, evidenceFor, fakeChain, fakeIndexer, fakeProver, feeOfferData, feedItem, memoryLogger, word } from "../support/builders.ts";

const NOW = 1_000_000;
/** Base fee 10 wei and 300,000 gas of the fake chain: one call costs 3,000,000 wei. */
const CALL_COST_WEI = 3_000_000n;
const layoutCall = { function: "addBlockHashLayout", reason: "no row", to: BRIDGE, data: "0xdeadbeef" as Hex };
const FAILED_RECEIPT_HASH = word(0xee);

interface SetupOptions {
  readonly item?: FeedItem;
  readonly deliverWithoutOffer?: boolean;
  readonly maximumPrerequisiteRounds?: number;
  /** The index of the message in the source transaction: null when the source reader finds none. */
  readonly logIndex?: number | null;
}

/** One item with a fee offer that pays twice its cost, on a fake chain, with a ledger over an in-memory budget. */
function setup(options: SetupOptions = {}) {
  const { logger, events } = memoryLogger();
  const chain = fakeChain();
  chain.feeTokens = CALL_COST_WEI * 2n;
  const item = options.item ?? feedItem({ id: 1, token: WRAPPED_NATIVE });
  const offerData = feeOfferData({ director: { recipient: address(0x12), settings: 1n, limit: 10n, multiplier: 0n }, value: 1000n, token: WRAPPED_NATIVE });
  const prover = fakeProver();
  const dependencies: DeliveryDependencies = {
    direction: "first-to-second",
    chain,
    prover,
    indexer: fakeIndexer([item], { [item.messageId]: options.deliverWithoutOffer === true ? "0x" : offerData }),
    source: { findMessageLogIndex: async () => (options.logIndex === undefined ? 0 : options.logIndex) },
    feeRouter: address(0x77),
    multicall: MULTICALL,
    rewardAddress: REWARD_ADDRESS,
    wrappedNative: WRAPPED_NATIVE,
    settings: {
      minimumMarginWei: 0n,
      deliverWithoutOffer: options.deliverWithoutOffer ?? false,
      tokenValuationsWei: {},
      executionGasFallback: 300_000n,
      maximumPrerequisiteRounds: options.maximumPrerequisiteRounds ?? 3,
      prerequisiteGasFallback: 300_000n,
      maximumPrerequisiteSpendPerSweepWei: 10n ** 18n,
      maximumPrerequisiteSpendPerDayWei: 10n ** 18n,
      maximumUnrecoveredPrerequisiteLossWei: 10n ** 18n,
      maximumBatchSize: 5,
      maximumBatchGas: 6_000_000n,
    },
    logger,
  };
  const budget: { current: PrerequisiteBudgetState } = { current: { prerequisiteSpend: [], deliverySpend: [], prerequisiteLosses: [] } };
  const ledger = createPrerequisiteLedger({
    capWei: 10n ** 18n,
    limits: { dailySpendWei: 10n ** 18n, unrecoveredLossWei: 10n ** 18n },
    store: {
      async load() {
        return budget.current;
      },
      async update(mutate) {
        budget.current = mutate(budget.current);
      },
    },
    now: () => NOW,
    logger,
  });
  /** Evidence that lists the layout call on its first build, and none afterwards. */
  const listLayoutCallOnce = () => {
    let builds = 0;
    prover.evidence = async () => evidenceFor({ prerequisites: (builds += 1) === 1 ? [layoutCall] : [] });
  };
  return { dependencies, chain, prover, ledger, budget, events, item, prepare: () => prepareItem(dependencies, item, ledger), listLayoutCallOnce };
}

const outcomeOf = async (prepare: () => ReturnType<typeof prepareItem>) => {
  const preparation = await prepare();
  if (preparation.kind !== "outcome") throw new Error("the item was expected to end with an outcome");
  return preparation.outcome;
};

describe("the preparation of an item: guards at the edge of external data", () => {
  it("refuses evidence whose call data is no executeMessage call", async () => {
    const w = setup();
    w.prover.evidence = async () => evidenceFor({ executeData: encodeFunctionData({ abi: messageBridgeAbi, functionName: "failedMessageDataHash", args: [word(1)] }) });
    await expect(w.prepare()).rejects.toThrow("the evidence calls failedMessageDataHash, not executeMessage");
    expect(w.chain.log.some((entry) => entry.kind === "send")).toBe(false);
  });

  it("cannot price the fee of an item that the indexer lists without a transfer, and asks the chain nothing", async () => {
    const w = setup({ item: { ...feedItem({ id: 1, token: WRAPPED_NATIVE }), transfer: null } });
    expect(await outcomeOf(w.prepare)).toEqual({ status: "skipped", messageId: word(1), reason: "no-price-for-fee-token" });
    expect(w.chain.log.filter((entry) => entry.kind === "call")).toEqual([]);
    expect(w.prover.evidenceRuns).toBe(0);
  });

  it("skips an item that the indexer lists without a send, before it builds evidence", async () => {
    const w = setup({ item: { ...feedItem({ id: 1, token: WRAPPED_NATIVE }), sent: null } });
    expect(await outcomeOf(w.prepare)).toEqual({ status: "skipped", messageId: word(1), reason: "source-log-not-found", detail: "the indexer has no send" });
    expect(w.prover.evidenceRuns).toBe(0);
  });

  it("skips an item whose message the source transaction does not hold, before it builds evidence", async () => {
    const w = setup({ logIndex: null });
    expect(await outcomeOf(w.prepare)).toEqual({ status: "skipped", messageId: word(1), reason: "source-log-not-found" });
    expect(w.prover.evidenceRuns).toBe(0);
  });

  it("reports the text of a failure of the prover that is no error object", async () => {
    const w = setup();
    w.prover.evidence = async () => {
      throw "the prover binary was killed";
    };
    expect(await outcomeOf(w.prepare)).toEqual({ status: "skipped", messageId: word(1), reason: "evidence-failed", detail: "the prover binary was killed" });
  });
});

describe("the layout calls of an item", () => {
  it("stops before the send when the second simulation of a call reverts, and charges nothing", async () => {
    const w = setup();
    w.prover.evidence = async () => evidenceFor({ prerequisites: [layoutCall] });
    let simulations = 0;
    w.chain.simulateOverride = (request) => (request.data === layoutCall.data && (simulations += 1) === 2 ? { ok: false, reason: "RowExists" } : undefined);
    expect(await outcomeOf(w.prepare)).toEqual({ status: "skipped", messageId: word(1), reason: "prerequisite-reverted", detail: "addBlockHashLayout: RowExists" });
    expect(w.chain.log.some((entry) => entry.kind === "send")).toBe(false);
    expect(w.budget.current.prerequisiteLosses).toEqual([]);
  });

  it("records the wei as a loss when a layout call is mined and fails", async () => {
    const w = setup();
    w.prover.evidence = async () => evidenceFor({ prerequisites: [layoutCall] });
    w.chain.receiptSuccess = false;
    expect(await outcomeOf(w.prepare)).toEqual({
      status: "skipped",
      messageId: word(1),
      reason: "prerequisite-failed",
      detail: `addBlockHashLayout in ${FAILED_RECEIPT_HASH}`,
      prerequisiteCostWei: CALL_COST_WEI,
    });
    expect(w.budget.current.prerequisiteLosses).toEqual([{ atMilliseconds: NOW, wei: CALL_COST_WEI.toString() }]);
    expect(w.events().find((event) => event.event === "prerequisite_loss")).toMatchObject({ messageId: word(1), lossWei: CALL_COST_WEI.toString(), reason: "prerequisite-failed" });
  });

  it("stops with a loss when another runner delivered the item while the layout call was mined", async () => {
    const w = setup();
    let builds = 0;
    w.prover.evidence = async () => (builds += 1) === 1 ? evidenceFor({ prerequisites: [layoutCall] }) : evidenceFor({ alreadyDelivered: true });
    expect(await outcomeOf(w.prepare)).toEqual({ status: "skipped", messageId: word(1), reason: "already-delivered", prerequisiteCostWei: CALL_COST_WEI });
    expect(w.events().find((event) => event.event === "prerequisite_sent")).toMatchObject({ messageId: word(1), function: "addBlockHashLayout", transactionHash: FAILED_RECEIPT_HASH });
    expect(w.budget.current.prerequisiteLosses).toEqual([{ atMilliseconds: NOW, wei: CALL_COST_WEI.toString() }]);
  });

  it("is ready when the last allowed round satisfies the evidence, and carries the cost of the call", async () => {
    const w = setup({ maximumPrerequisiteRounds: 1 });
    w.listLayoutCallOnce();
    const preparation = await w.prepare();
    expect(preparation).toMatchObject({ kind: "ready", ready: { messageId: word(1), assumedGas: 300_000n, prerequisiteCostWei: CALL_COST_WEI } });
    expect(w.chain.log.filter((entry) => entry.kind === "send")).toHaveLength(1);
  });

  it("skips with the count of the calls that remain when the allowed rounds end first, and records the loss", async () => {
    const w = setup({ maximumPrerequisiteRounds: 1 });
    w.prover.evidence = async () => evidenceFor({ prerequisites: [layoutCall] });
    expect(await outcomeOf(w.prepare)).toEqual({
      status: "skipped",
      messageId: word(1),
      reason: "prerequisites-not-satisfied",
      detail: "1 calls remain",
      prerequisiteCostWei: CALL_COST_WEI,
    });
    expect(w.budget.current.prerequisiteLosses).toEqual([{ atMilliseconds: NOW, wei: CALL_COST_WEI.toString() }]);
  });
});

describe("the delivery of an item that has no fee offer", () => {
  it("sends layout calls without a fee check, then delivers straight to the bridge and reports their cost", async () => {
    const w = setup({ deliverWithoutOffer: true });
    w.listLayoutCallOnce();
    expect(await outcomeOf(w.prepare)).toEqual({
      status: "delivered",
      messageId: word(1),
      path: "bridge",
      transactionHash: FAILED_RECEIPT_HASH,
      gasUsed: 300_000n,
      gasCostWei: CALL_COST_WEI,
      prerequisiteCostWei: CALL_COST_WEI,
      feeExpectedWei: null,
      feeReceivedTokens: null,
    });
    expect(w.chain.log.filter((entry) => entry.kind === "send").map((entry) => [entry.request.to, entry.request.data])).toEqual([
      [BRIDGE, "0xdeadbeef"],
      [BRIDGE, emptyExecuteMessage()],
    ]);
    expect(w.chain.log.filter((entry) => entry.kind === "call")).toEqual([]);
    expect(w.events().find((event) => event.event === "delivery_sent")).toMatchObject({ messageId: word(1), path: "bridge", gasUsed: "300000" });
  });

  it("skips and sends nothing when the simulation of the delivery reverts", async () => {
    const w = setup({ deliverWithoutOffer: true });
    w.chain.simulateOverride = () => ({ ok: false, reason: "AnchorNotStored" });
    expect(await outcomeOf(w.prepare)).toEqual({ status: "skipped", messageId: word(1), reason: "simulation-reverted", detail: "AnchorNotStored" });
    expect(w.chain.log.some((entry) => entry.kind === "send")).toBe(false);
  });

  it("charges the layout calls as a loss when the simulation of the delivery then reverts", async () => {
    const w = setup({ deliverWithoutOffer: true });
    w.listLayoutCallOnce();
    w.chain.simulateOverride = (request) => (request.data === emptyExecuteMessage() ? { ok: false, reason: "AnchorNotStored" } : undefined);
    expect(await outcomeOf(w.prepare)).toEqual({
      status: "skipped",
      messageId: word(1),
      reason: "simulation-reverted",
      detail: "AnchorNotStored",
      prerequisiteCostWei: CALL_COST_WEI,
    });
    expect(w.budget.current.prerequisiteLosses).toEqual([{ atMilliseconds: NOW, wei: CALL_COST_WEI.toString() }]);
  });

  const revertTheDelivery = (w: ReturnType<typeof setup>) => {
    const send = w.chain.send.bind(w.chain);
    w.chain.send = async (request) => {
      const receipt = await send(request);
      return request.data === emptyExecuteMessage() ? { ...receipt, success: false } : receipt;
    };
  };

  it("reports a failure with no cost when the delivery is mined and reverts, and no layout call preceded it", async () => {
    const w = setup({ deliverWithoutOffer: true });
    revertTheDelivery(w);
    expect(await outcomeOf(w.prepare)).toEqual({ status: "failed", messageId: word(1), reason: "transaction-reverted", transactionHash: FAILED_RECEIPT_HASH });
    expect(w.budget.current.prerequisiteLosses).toEqual([]);
  });

  it("reports the cost of the layout calls, and records it as a loss, when the delivery is mined and reverts", async () => {
    const w = setup({ deliverWithoutOffer: true });
    w.listLayoutCallOnce();
    revertTheDelivery(w);
    expect(await outcomeOf(w.prepare)).toEqual({
      status: "failed",
      messageId: word(1),
      reason: "transaction-reverted",
      transactionHash: FAILED_RECEIPT_HASH,
      prerequisiteCostWei: CALL_COST_WEI,
    });
    expect(w.budget.current.prerequisiteLosses).toEqual([{ atMilliseconds: NOW, wei: CALL_COST_WEI.toString() }]);
  });
});
