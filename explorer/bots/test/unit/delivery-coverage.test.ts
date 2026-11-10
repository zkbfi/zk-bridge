import { encodeFunctionData, type Hex } from "viem";
import { testPricing } from "../support/pricing.ts";
import { messageBridgeAbi, tokenFactoryAbi } from "@zk-bridge/shared";
import { describe, expect, it } from "vitest";
import type { FeedItem } from "../../src/indexer/client.ts";
import { prepareItem, type DeliveryDependencies } from "../../src/runner/delivery.ts";
import { createPrerequisiteLedger } from "../../src/runner/prerequisite-ledger.ts";
import type { PrerequisiteBudgetState } from "../../src/runner/state.ts";
import { BRIDGE, MULTICALL, REWARD_ADDRESS, WRAPPED_NATIVE, address, emptyExecuteMessage, evidenceFor, fakeChain, fakeIndexer, fakeProver, feedProver, feeOfferData, feedItem, memoryLogger, word, TEST_DELIVERY_GAS_FALLBACK } from "../support/builders.ts";

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
  /** The token factory of the destination chain. Default: unknown. */
  readonly tokenFactory?: `0x${string}` | null;
}

/** One item with a fee offer that pays twice its cost, on a fake chain, with a ledger over an in-memory budget. */
function setup(options: SetupOptions = {}) {
  const { logger, events } = memoryLogger();
  const chain = fakeChain();
  chain.feeTokens = CALL_COST_WEI * 2n;
  const item = options.item ?? feedItem({ id: 1, token: WRAPPED_NATIVE });
  const offerData = feeOfferData({ director: { recipient: address(0x12), settings: 1n, limit: 10n, multiplier: 0n, callGas: 0n }, value: 1000n, token: WRAPPED_NATIVE });
  const prover = fakeProver();
  const dependencies: DeliveryDependencies = {
    direction: "first-to-second",
    sourceChainId: 1,
    chain,
    prover: feedProver(prover, [item], { [item.messageId]: options.deliverWithoutOffer === true ? "0x" : offerData }),
    indexer: fakeIndexer([item], { [item.messageId]: options.deliverWithoutOffer === true ? "0x" : offerData }),
    source: { findMessageLogIndex: async () => (options.logIndex === undefined ? 0 : options.logIndex) },
    deliveryRouter: address(0x77),
    multicall: MULTICALL,
    rewardAddress: REWARD_ADDRESS,
    wrappedNative: WRAPPED_NATIVE,
    pricing: testPricing({}, WRAPPED_NATIVE),
    bridge: BRIDGE,
    tokenFactory: options.tokenFactory ?? null,
    settings: {
      maximumLossPercent: 20,
      deliverWithoutOffer: options.deliverWithoutOffer ?? false,
      deliveryGasFallback: TEST_DELIVERY_GAS_FALLBACK,
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

  it("skips an item whose message data in the indexer differs from the message that the prover read, and spends nothing", async () => {
    const w = setup();
    w.dependencies = { ...w.dependencies, prover: w.prover };
    w.prover.evidence = async () => ({ ...evidenceFor(), message: { ...evidenceFor().message } });
    expect(await outcomeOf(() => prepareItem(w.dependencies, w.item, w.ledger))).toMatchObject({ status: "skipped", reason: "indexer-disagrees-with-evidence" });
    expect(w.chain.log.some((entry) => entry.kind === "send" || entry.kind === "simulate")).toBe(false);
  });

  it("skips an item that the indexer lists in another direction than the configured one, and asks nothing", async () => {
    for (const direction of [{ sourceChainId: 943, destinationChainId: 369 }, { sourceChainId: 1, destinationChainId: 1 }]) {
      const w = setup({ item: { ...feedItem({ id: 1, token: WRAPPED_NATIVE }), direction } });
      expect(await outcomeOf(w.prepare)).toMatchObject({ status: "skipped", reason: "wrong-direction" });
      expect(w.chain.log).toEqual([]);
      expect(w.prover.evidenceRuns).toBe(0);
    }
  });

  it("skips evidence that names another message than the item, and spends nothing", async () => {
    const w = setup();
    w.dependencies = { ...w.dependencies, prover: w.prover };
    w.prover.evidence = async () => ({ ...evidenceFor(), message: { ...evidenceFor().message, messageId: word(2) } });
    expect(await outcomeOf(() => prepareItem(w.dependencies, w.item, w.ledger))).toMatchObject({ status: "skipped", reason: "evidence-for-another-message" });
    expect(w.chain.log.some((entry) => entry.kind === "send" || entry.kind === "simulate")).toBe(false);
  });

  /** The setup with the message data of the indexer and the prover replaced. */
  const withMessage = (w: ReturnType<typeof setup>, messageData: Hex) => {
    const data = { [w.item.messageId]: messageData };
    w.dependencies = { ...w.dependencies, indexer: fakeIndexer([w.item], data), prover: feedProver(w.prover, [w.item], data) };
    return () => prepareItem(w.dependencies, w.item, w.ledger);
  };
  const COPY_FACTORY = address(0x67);
  const HOME_TOKEN = address(0x55);
  const director = { recipient: address(0x12), settings: 1n, limit: 10n, multiplier: 0n, callGas: 0n };

  it("skips an item whose destination token is not the token that the message releases, and asks the chain nothing", async () => {
    const w = setup();
    const prepare = withMessage(w, feeOfferData({ director, value: 1000n, token: address(0x44) }));
    expect(await outcomeOf(prepare)).toMatchObject({ status: "skipped", reason: "indexer-disagrees-with-evidence" });
    expect(w.chain.log).toEqual([]);
  });

  it("asks the token factory for the copy that a bridged message releases", async () => {
    const w = setup({ tokenFactory: COPY_FACTORY });
    w.chain.predictedCopy = WRAPPED_NATIVE;
    const prepare = withMessage(w, feeOfferData({ director, value: 1000n, token: HOME_TOKEN, handler: "bridged" }));
    expect((await prepare()).kind).toBe("ready");
    const asked = w.chain.log.find((entry) => entry.kind === "call" && entry.request.to === COPY_FACTORY);
    expect(asked?.request.data).toBe(encodeFunctionData({ abi: tokenFactoryAbi, functionName: "predictAddress", args: [1n, HOME_TOKEN] }));
  });

  it("cannot price the tip of a bridged message when the deployment names no token factory", async () => {
    const w = setup();
    const prepare = withMessage(w, feeOfferData({ director, value: 1000n, token: HOME_TOKEN, handler: "bridged" }));
    expect(await outcomeOf(prepare)).toEqual({ status: "skipped", messageId: word(1), reason: "no-price-for-fee-token" });
  });

  it("cannot price a tip in a token that does not answer its decimals, such as a copy that is not deployed yet: the automatic maximum judges it", async () => {
    const w = setup({ item: feedItem({ id: 1 }) });
    const data = { [w.item.messageId]: feeOfferData({ director: { recipient: address(0x12), settings: 1n, limit: 10n, multiplier: 0n, callGas: 0n }, value: 1000n, token: address(0x66) }) };
    const pricing = testPricing({ [address(0x66).toLowerCase()]: 10n ** 18n }, WRAPPED_NATIVE);
    w.dependencies = { ...w.dependencies, indexer: fakeIndexer([w.item], data), prover: feedProver(w.prover, [w.item], data), pricing };
    w.chain.tokenDecimals = null;
    // 9 of 1000 is under 1%: no price, so it does not pay. The price source is not asked without decimals.
    w.chain.feeTokens = 9n;
    expect(await outcomeOf(() => prepareItem(w.dependencies, w.item, w.ledger))).toMatchObject({ status: "skipped", messageId: word(1), reason: "unpriced-tip-below-maximum" });
    expect(pricing.asked).toEqual([]);
    // 10 of 1000 is the automatic maximum: it pays, and the item goes on.
    w.chain.feeTokens = 10n;
    expect((await prepareItem(w.dependencies, w.item, w.ledger)).kind).toBe("ready");
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
    expect(preparation).toMatchObject({ kind: "ready", ready: { messageId: word(1), assumedGas: 320_000n, prerequisiteCostWei: CALL_COST_WEI } });
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

describe("the destination token of a first transfer", () => {
  const FACTORY = address(0x66);
  const SOURCE_TOKEN = address(0x55);
  /** The feed item of a send that locks a native token: no copy exists yet, so the indexer names no destination token. */
  const firstTransfer = (overrides: { sourceIsNative?: boolean | null } = {}): FeedItem => {
    const listed = feedItem({ id: 1 });
    return { ...listed, transfer: { ...listed.transfer!, destinationToken: null, sourceIsNative: overrides.sourceIsNative === undefined ? true : overrides.sourceIsNative } };
  };

  it("gives the copy of a native token whose symbol starts with Z the prefix on top of its own letters", async () => {
    const listed = firstTransfer();
    const item: FeedItem = { ...listed, transfer: { ...listed.transfer!, sourceToken: { ...listed.transfer!.sourceToken, symbol: "ZRX" } } };
    const w = setup({ item, tokenFactory: FACTORY });
    w.chain.predictedCopy = WRAPPED_NATIVE;
    const preparation = await w.prepare();
    if (preparation.kind !== "ready") throw new Error("the item was expected to be ready for a batch");
    expect(preparation.ready.item.transfer?.destinationToken?.symbol).toBe("zZRX");
  });

  it("asks the token factory of the destination chain for the copy and prices the tip in it", async () => {
    // The factory predicts the copy. The fee check needs it: the router quotes the tip in the destination token.
    const w = setup({ item: firstTransfer(), tokenFactory: FACTORY });
    w.chain.predictedCopy = WRAPPED_NATIVE;
    const preparation = await w.prepare();
    if (preparation.kind !== "ready") throw new Error("the item was expected to be ready for a batch");
    expect(preparation.ready.item.transfer?.destinationToken).toEqual({ chainId: 369, address: WRAPPED_NATIVE, symbol: "zSRC", decimals: 18 });
    const asked = w.chain.log.find((entry) => entry.kind === "call" && entry.request.to === FACTORY);
    expect(asked?.request.data).toBe(encodeFunctionData({ abi: tokenFactoryAbi, functionName: "predictAddress", args: [1n, SOURCE_TOKEN] }));
  });

  it("gives the copy the decimals of the token that it copies", async () => {
    const listed = firstTransfer();
    const w = setup({ item: { ...listed, transfer: { ...listed.transfer!, sourceToken: { ...listed.transfer!.sourceToken, decimals: 6 } } }, tokenFactory: FACTORY });
    w.chain.predictedCopy = WRAPPED_NATIVE;
    const preparation = await w.prepare();
    if (preparation.kind !== "ready") throw new Error("the item was expected to be ready for a batch");
    expect(preparation.ready.item.transfer?.destinationToken?.decimals).toBe(6);
  });

  it("prices the tip in a copy that is not deployed yet with the decimals of the token that it copies", async () => {
    // The first transfer deploys the copy, so the copy cannot answer decimals() before the delivery. The factory gives it
    // the decimals of its home token, so the runner takes those.
    const listed = firstTransfer();
    const w = setup({ item: { ...listed, transfer: { ...listed.transfer!, sourceToken: { ...listed.transfer!.sourceToken, decimals: 6 } } }, tokenFactory: FACTORY });
    const copy = address(0x77);
    w.chain.predictedCopy = copy;
    w.chain.tokenDecimals = null;
    const data = { [w.item.messageId]: feeOfferData({ director: { recipient: address(0x12), settings: 1n, limit: 10n, multiplier: 0n, callGas: 0n }, value: 1000n, token: SOURCE_TOKEN, handler: "bridged" }) };
    w.dependencies = {
      ...w.dependencies,
      indexer: fakeIndexer([w.item], data),
      prover: feedProver(w.prover, [w.item], data),
      pricing: testPricing({ [copy.toLowerCase()]: 10n ** 30n }, WRAPPED_NATIVE),
    };
    const preparation = await prepareItem(w.dependencies, w.item, w.ledger);
    if (preparation.kind !== "ready") throw new Error(`the item was expected to be ready for a batch: ${JSON.stringify(preparation)}`);
    expect(preparation.ready.item.transfer?.destinationToken).toMatchObject({ address: copy, decimals: 6 });
  });

  it("cannot price the tip when the deployment names no token factory", async () => {
    const w = setup({ item: firstTransfer() });
    expect(await outcomeOf(w.prepare)).toEqual({ status: "skipped", messageId: word(1), reason: "no-price-for-fee-token" });
    expect(w.chain.log.filter((entry) => entry.kind === "call")).toEqual([]);
  });

  it("does not ask the factory about a send that burns a copy, because the indexer names its native token", async () => {
    const w = setup({ item: firstTransfer({ sourceIsNative: false }), tokenFactory: FACTORY });
    expect(await outcomeOf(w.prepare)).toEqual({ status: "skipped", messageId: word(1), reason: "no-price-for-fee-token" });
    expect(w.chain.log.filter((entry) => entry.kind === "call")).toEqual([]);
  });

  it("does not guess when the indexer says nothing about the source token", async () => {
    const w = setup({ item: firstTransfer({ sourceIsNative: null }), tokenFactory: FACTORY });
    expect(await outcomeOf(w.prepare)).toEqual({ status: "skipped", messageId: word(1), reason: "no-price-for-fee-token" });
  });
});

describe("alternative layout calls", () => {
  // The prover lists every call that could add the row until a row covers the slot. The call at the older stored header
  // adds a row that may not cover the source slot, and then it stays on the list. The live prover did exactly that.
  const first = { ...layoutCall, data: "0xaaaa0001" as Hex };
  const second = { ...layoutCall, data: "0xbbbb0002" as Hex };

  it("sends the second alternative after the first one left the slot uncovered, and does not send the first again", async () => {
    const w = setup({ maximumPrerequisiteRounds: 4 });
    w.chain.feeTokens = CALL_COST_WEI * 5n;
    const sentData = () => w.chain.log.filter((entry) => entry.kind === "send").map((entry) => entry.request.data);
    // The slot is covered only after both calls are mined.
    w.prover.evidence = async () => evidenceFor({ prerequisites: sentData().length >= 2 ? [] : [first, second] });
    const preparation = await w.prepare();
    expect(preparation).toMatchObject({ kind: "ready", ready: { prerequisiteCostWei: CALL_COST_WEI * 2n } });
    expect(sentData()).toEqual(["0xaaaa0001", "0xbbbb0002"]);
  });

  it("stops with a loss when every listed call was sent and the list stays", async () => {
    const w = setup({ maximumPrerequisiteRounds: 4 });
    w.chain.feeTokens = CALL_COST_WEI * 5n;
    w.prover.evidence = async () => evidenceFor({ prerequisites: [first, second] });
    expect(await outcomeOf(w.prepare)).toEqual({
      status: "skipped",
      messageId: word(1),
      reason: "prerequisites-not-satisfied",
      detail: "2 calls remain and each was sent already",
      prerequisiteCostWei: CALL_COST_WEI * 2n,
    });
    expect(w.chain.log.filter((entry) => entry.kind === "send")).toHaveLength(2);
  });
});
