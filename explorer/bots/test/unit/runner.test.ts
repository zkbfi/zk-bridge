import { decodeFunctionData, keccak256, toFunctionSelector, type Hex } from "viem";
import { beaconLightClientAbi, deliveryRouterAbi, messageBridgeAbi, multicall3Abi, requiredDeliveryGas } from "@zk-bridge/shared";
import { describe, expect, it } from "vitest";
import type { Simulation } from "../../src/chain/transactions.ts";
import type { FeedItem } from "../../src/indexer/client.ts";
import type { StateStore } from "../../src/runtime/state-file.ts";
import { BATCH_ITEM_OVERHEAD_GAS, deliverItem, MAXIMUM_SETTLING_ROUNDS } from "../../src/runner/batch.ts";
import { createPrerequisiteLedger } from "../../src/runner/prerequisite-ledger.ts";
import type { DeliverySettings } from "../../src/runner/delivery.ts";
import type { Logger } from "../../src/logging/logger.ts";
import { createRunner } from "../../src/runner/runner.ts";
import { createSerialQueue } from "../../src/runner/serial-queue.ts";
import { INITIAL_RUNNER_STATE, type RunnerState } from "../../src/runner/state.ts";
import {
  BRIDGE,
  DELIVERY_ROUTER,
  LIGHT_CLIENT,
  EXECUTED,
  FAILED_IN_BRIDGE,
  MULTICALL,
  UPDATE_FAILED,
  OTHER_TOKEN,
  REWARD_ADDRESS,
  RUNNER,
  SKIPPED_ALREADY_DELIVERED,
  SKIPPED_ANCHOR_NOT_STORED,
  SKIPPED_HEAD_ADVANCED,
  SKIPPED_INSUFFICIENT_GAS,
  WRAPPED_NATIVE,
  address,
  emptyExecuteMessage,
  evidenceFor,
  fakeChain,
  fakeIndexer,
  fakeLightClient,
  fakeProver,
  feeOfferData,
  feedItem,
  memoryLogger,
  memoryOutcomes,
  proofPayload,
  transferLog,
  word,
  TEST_PROOF_CHECK_GAS,
  FEED_REQUIRED_GAS,
} from "../support/builders.ts";

const selectorOf = (name: string) => toFunctionSelector(deliveryRouterAbi.find((entry) => entry.type === "function" && entry.name === name) as never);
/** The single entry. The batch simulation measures the gas of each item there. */
const EXECUTE_SINGLE = selectorOf("executeMessage");
/** The batch entry. Every delivery through the delivery router sends this call. */
const EXECUTE_BATCH = toFunctionSelector(multicall3Abi.find((entry) => entry.type === "function" && entry.name === "aggregate3") as never);
const UPDATE = toFunctionSelector(beaconLightClientAbi.find((entry) => entry.type === "function" && entry.name === "update") as never);

/** A fixed fee: bit 0 of `settings`, with the fee in `limit`. */
const fixedFee = (fee: bigint) => ({ recipient: address(0x12), settings: 1n, limit: fee, multiplier: 0n });

function memoryState(): StateStore<RunnerState> & { current: RunnerState } {
  const state = {
    current: INITIAL_RUNNER_STATE,
    async load() {
      return state.current;
    },
    async update(mutate: (current: RunnerState) => RunnerState) {
      state.current = mutate(state.current);
      return state.current;
    },
  };
  return state;
}

const REFUSAL_WINDOW_MILLISECONDS = 30 * 60 * 1000;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

/** A ledger over the state of a world, as the runner makes one for each sweep. */
function ledgerFor(w: { state: ReturnType<typeof memoryState>; delivery: { settings: DeliverySettings; logger: Logger } }, now: () => number = () => 1_000_000) {
  return createPrerequisiteLedger({
    capWei: w.delivery.settings.maximumPrerequisiteSpendPerSweepWei,
    limits: { dailySpendWei: w.delivery.settings.maximumPrerequisiteSpendPerDayWei, unrecoveredLossWei: w.delivery.settings.maximumUnrecoveredPrerequisiteLossWei },
    store: {
      async load() {
        const { prerequisiteSpend, deliverySpend, prerequisiteLosses } = await w.state.load();
        return { prerequisiteSpend, deliverySpend, prerequisiteLosses };
      },
      async update(mutate) {
        await w.state.update((state) => {
          const budget = { prerequisiteSpend: state.prerequisiteSpend, deliverySpend: state.deliverySpend, prerequisiteLosses: state.prerequisiteLosses };
          const next = mutate(budget);
          return next === budget ? state : { ...state, ...next };
        });
      },
    },
    now,
    logger: w.delivery.logger,
  });
}

interface WorldOptions {
  items?: FeedItem[];
  data?: Record<string, Hex>;
  maximumLossPercent?: number;
  deliverWithoutOffer?: boolean;
  valuations?: Record<string, bigint>;
  /** The gas a default item is assumed to need before a simulation. Default 300,000. */
  assumedGas?: bigint;
  maximumDeliveriesPerSweep?: number;
  prerequisiteGasFallback?: bigint;
  maximumPrerequisiteSpendPerSweepWei?: bigint;
  maximumPrerequisiteSpendPerDayWei?: bigint;
  maximumUnrecoveredPrerequisiteLossWei?: bigint;
  maximumBatchSize?: number;
  maximumBatchGas?: bigint;
  /** A state that an earlier runner wrote, to test a restart. */
  state?: ReturnType<typeof memoryState>;
  startTime?: number;
}

/** A runner on fakes: chain, indexer, prover, board payloads. Base fee 10 wei, 300,000 gas: a cost of 3,000,000 wei. */
function world(options: WorldOptions = {}) {
  const { logger, events } = memoryLogger();
  const chain = fakeChain();
  chain.feeTokens = 0n;
  // One item costs 300,000 gas in a batch: the execution at the single entry plus the overhead of the batch entry.
  chain.executionGas = 300_000n - BATCH_ITEM_OVERHEAD_GAS;
  const items = options.items ?? [];
  // A batch lists its items oldest first, and the feed lists the newest first.
  chain.messageIdOfPosition = (position) => ([...items].reverse()[position]?.messageId ?? word(position + 1)) as Hex;
  const indexer = fakeIndexer(items, options.data ?? {});
  const prover = fakeProver();
  const lightClient = fakeLightClient();
  const state = options.state ?? memoryState();
  const outcomes = memoryOutcomes();
  let clock = options.startTime ?? 1_000_000;
  const delivery = {
    direction: "first-to-second" as const,
    chain,
    prover,
    indexer,
    source: { findMessageLogIndex: async () => 0 },
    deliveryRouter: DELIVERY_ROUTER,
    multicall: MULTICALL,
    rewardAddress: REWARD_ADDRESS,
    wrappedNative: WRAPPED_NATIVE,
    tokenFactory: null,
    settings: {
      maximumLossPercent: options.maximumLossPercent ?? 20,
      deliverWithoutOffer: options.deliverWithoutOffer ?? false,
      tokenValuationsWei: options.valuations ?? {},
      proofCheckGas: options.assumedGas === undefined ? TEST_PROOF_CHECK_GAS : options.assumedGas - FEED_REQUIRED_GAS,
      maximumPrerequisiteRounds: 3,
      prerequisiteGasFallback: options.prerequisiteGasFallback ?? 300_000n,
      maximumPrerequisiteSpendPerSweepWei: options.maximumPrerequisiteSpendPerSweepWei ?? 10n ** 18n,
      maximumPrerequisiteSpendPerDayWei: options.maximumPrerequisiteSpendPerDayWei ?? 10n ** 18n,
      maximumUnrecoveredPrerequisiteLossWei: options.maximumUnrecoveredPrerequisiteLossWei ?? 10n ** 18n,
      maximumBatchSize: options.maximumBatchSize ?? 5,
      maximumBatchGas: options.maximumBatchGas ?? 6_000_000n,
    },
    logger,
  };
  const runner = createRunner({
    pairName: "eth-pls",
    direction: "first-to-second",
    sourceChainId: 1,
    destinationChainId: 369,
    lightClientAddress: LIGHT_CLIENT,
    lightClient,
    delivery,
    state,
    outcomes,
    queue: createSerialQueue(),
    now: () => clock,
    maximumDeliveriesPerSweep: options.maximumDeliveriesPerSweep ?? 10,
    prerequisiteLossRefusalMilliseconds: REFUSAL_WINDOW_MILLISECONDS,
    logger,
  });
  return { runner, chain, prover, lightClient, state, outcomes, events, indexer, delivery, advance: (milliseconds: number) => (clock += milliseconds) };
}

describe("proof intake and the update", () => {
  it("posts update when the head is behind a verified proof that starts at the head", async () => {
    const w = world();
    const handling = await w.runner.handleProofPayload(proofPayload({ startSlot: 100n, newSlot: 164n }));
    expect(handling.handled).toBe("update-posted");
    // Simulated first, then sent, and both to the light client with the update selector.
    expect(w.chain.log.map((entry) => entry.kind)).toEqual(["simulate", "send"]);
    expect(w.chain.log.every((entry) => entry.request.to === LIGHT_CLIENT && entry.request.data.startsWith(UPDATE))).toBe(true);
    expect(w.chain.unsimulatedSends()).toEqual([]);
    expect(w.outcomes.records[0]).toMatchObject({ kind: "update", status: "posted", newSlot: 164n });
  });

  it("refuses a proof that does not verify, and sends nothing", async () => {
    const w = world();
    w.prover.verify = async () => {
      throw new Error("the Groth16 proof does not verify");
    };
    const handling = await w.runner.handleProofPayload(proofPayload());
    expect(handling).toMatchObject({ handled: "refused", reason: "proof-does-not-verify" });
    expect(w.chain.log).toEqual([]);
  });

  it("refuses a proof whose start is not the stored head, before it spends time on the proof", async () => {
    const w = world();
    const wrongSlot = await w.runner.handleProofPayload(proofPayload({ startSlot: 96n, newSlot: 164n }));
    expect(wrongSlot).toMatchObject({ handled: "refused", reason: "start-slot-differs-from-head" });
    // Same slot, another root: the head root of the fake is word(101), the proof was built for word(101) at slot 100 only.
    w.lightClient.state = { ...w.lightClient.state, headRoot: word(0xaa) };
    const wrongRoot = await w.runner.handleProofPayload(proofPayload({ startSlot: 100n, newSlot: 165n }));
    expect(wrongRoot).toMatchObject({ handled: "refused", reason: "start-root-differs-from-head" });
    expect(w.chain.log).toEqual([]);
    expect((w.prover as { verifications: number }).verifications).toBe(0);
  });

  it("refuses another program key, another pair or direction, a proof that is already stored, and text that is no proof", async () => {
    const w = world();
    expect(await w.runner.handleProofPayload(proofPayload({ programKey: word(0x43) }))).toMatchObject({ reason: "program-key-mismatch" });
    expect(await w.runner.handleProofPayload(proofPayload({ direction: "second-to-first" }))).toMatchObject({ reason: "wrong-direction" });
    w.lightClient.state = { ...w.lightClient.state, headSlot: 164n };
    expect(await w.runner.handleProofPayload(proofPayload({ startSlot: 100n, newSlot: 164n }))).toMatchObject({ reason: "already-stored" });
    expect(await w.runner.handleProofPayload("0x0102" as Hex)).toMatchObject({ reason: "undecodable" });
    expect(w.chain.log).toEqual([]);
  });

  it("does not send when the simulation reverts, because another runner posted first", async () => {
    const w = world();
    w.chain.simulateOverride = () => ({ ok: false, reason: "PreviousHeadSlotMismatch" });
    const handling = await w.runner.handleProofPayload(proofPayload());
    expect(handling).toMatchObject({ handled: "update-skipped", reason: "simulation-reverted" });
    expect(w.chain.log.map((entry) => entry.kind)).toEqual(["simulate"]);
  });

  it("looks at a republished message once", async () => {
    const w = world();
    const payload = proofPayload();
    await w.runner.handleProofPayload(payload);
    expect(await w.runner.handleProofPayload(payload)).toEqual({ handled: "duplicate" });
    expect((w.prover as { verifications: number }).verifications).toBe(1);
  });
});

describe("delivery decisions", () => {
  const OFFER_ID = 1;
  const offerItem = (token = WRAPPED_NATIVE) => feedItem({ id: OFFER_ID, token });
  const offerData = (token = WRAPPED_NATIVE) => ({ [word(OFFER_ID)]: feeOfferData({ director: fixedFee(10n), value: 1000n, token }) });
  const COST = 3_000_000n;

  it("asks the router for the fee at the execution gas plus the gas of the user call, and at the execution gas without a call", async () => {
    const asked: bigint[] = [];
    const ask = async (call?: { target: `0x${string}`; data: `0x${string}` }) => {
      asked.length = 0;
      const data = { [word(OFFER_ID)]: feeOfferData({ director: fixedFee(10n), value: 1000n, token: WRAPPED_NATIVE, ...(call === undefined ? {} : { call }) }) };
      // The first check uses the fallback gas. The planned gas adds the send buffer of 30 percent: at 900,000 it leaves 270,000 for the call.
      const w = world({ items: [offerItem()], data, assumedGas: 900_000n });
      w.chain.feeTokensOf = ({ gasUsed }) => {
        asked.push(gasUsed);
        return 10n ** 18n;
      };
      await w.runner.sweep();
      return asked[0] as bigint;
    };
    const withoutCall = await ask();
    const withCall = await ask({ target: address(0x21), data: "0xabcdef01" });
    expect(withCall).toBeGreaterThan(withoutCall);
    // The allowance is the planned gas less the execution gas, less the overhead of 100,000 and the reserve of 10,000.
    expect(withCall - withoutCall).toBe(270_000n - 110_000n);
  });

  it("delivers when the fee covers the cost, through the delivery router, with the proof only", async () => {
    const w = world({ items: [offerItem()], data: offerData() });
    w.chain.feeTokens = COST + 1n;
    const summary = await w.runner.sweep();
    expect(summary).toMatchObject({ delivered: 1, skipped: 0 });
    const send = w.chain.log.find((entry) => entry.kind === "send");
    expect(send?.request.to).toBe(MULTICALL);
    const decoded = decodeFunctionData({ abi: multicall3Abi, data: send?.request.data as Hex });
    expect(decoded.functionName).toBe("aggregate3");
    // One call, to the delivery router, with failure allowed. The router pays the tip to its own reward address, so the call names none.
    const [call] = (decoded.args as readonly [readonly { target: string; allowFailure: boolean; callData: Hex }[]])[0];
    expect(call).toMatchObject({ target: DELIVERY_ROUTER, allowFailure: true });
    const inner = decodeFunctionData({ abi: deliveryRouterAbi, data: (call as { callData: Hex }).callData });
    expect(inner.functionName).toBe("executeMessage");
    expect(inner.args).toHaveLength(1);
    expect(w.chain.account).toBe(RUNNER);
    expect(w.chain.unsimulatedSends()).toEqual([]);
    expect(w.outcomes.records[0]).toMatchObject({ kind: "delivery", status: "delivered", path: "delivery-router", feeExpectedWei: COST + 1n });
  });

  it("delivers when the loss is just under the limit: a fee of 80 percent of the cost plus one wei", async () => {
    const w = world({ items: [offerItem()], data: offerData(), maximumLossPercent: 20 });
    w.chain.feeTokens = (COST * 80n) / 100n + 1n;
    expect((await w.runner.sweep()).delivered).toBe(1);
  });

  it("a left-out item stays deliverable: the runner sends nothing for it and logs loss-at-or-above-limit", async () => {
    const w = world({ items: [offerItem()], data: offerData(), maximumLossPercent: 20 });
    // A loss of exactly 20 percent is already too much.
    w.chain.feeTokens = (COST * 80n) / 100n;
    const summary = await w.runner.sweep();
    expect(summary).toMatchObject({ delivered: 0, skipped: 1 });
    expect(w.outcomes.records[0]).toMatchObject({ status: "skipped", reason: "loss-at-or-above-limit", feeWei: (COST * 80n) / 100n, costWei: COST });
    expect((w.prover as { evidenceRuns: number }).evidenceRuns).toBe(0);
    expect(w.chain.log.some((entry) => entry.kind === "send")).toBe(false);
    // The item is not marked as final, so the next sweep looks at it again.
    expect(w.state.current.finished).toEqual({});
  });

  it("a feed item with a null gasLimit is skipped with gas-limit-unknown, and nothing is guessed or sent", async () => {
    const w = world({ items: [feedItem({ id: OFFER_ID, token: WRAPPED_NATIVE, gasLimit: null })], data: offerData() });
    w.chain.feeTokens = COST * 10n;
    const summary = await w.runner.sweep();
    expect(summary).toMatchObject({ delivered: 0, skipped: 1 });
    expect(w.outcomes.records[0]).toMatchObject({ status: "skipped", reason: "gas-limit-unknown" });
    expect((w.prover as { evidenceRuns: number }).evidenceRuns).toBe(0);
    expect(w.chain.log).toEqual([]);
    // The indexer may learn the limit later, so the item is not final and not made to wait.
    expect(w.state.current.finished).toEqual({});
  });

  it("checks the fee again at the simulated gas, and skips when the real cost is higher than the assumed cost", async () => {
    const w = world({ items: [offerItem()], data: offerData(), assumedGas: 100_000n });
    w.chain.feeTokens = 2_000_000n; // pays for 100,000 gas at 10 wei, not for 300,000
    w.chain.gas = 300_000n;
    const summary = await w.runner.sweep();
    expect(summary).toMatchObject({ delivered: 0, skipped: 1 });
    expect(w.outcomes.records[0]).toMatchObject({ reason: "loss-at-or-above-limit", costWei: COST });
    expect((w.prover as { evidenceRuns: number }).evidenceRuns).toBe(1);
    expect(w.chain.log.some((entry) => entry.kind === "send")).toBe(false);
  });

  it("skips and sends nothing when the delivery simulation reverts", async () => {
    const w = world({ items: [offerItem()], data: offerData() });
    w.chain.feeTokens = COST * 2n;
    w.chain.simulateOverride = (request): Simulation | undefined =>
      request.data.startsWith(EXECUTE_SINGLE) ? { ok: false, reason: "AlreadyDelivered" } : undefined;
    const summary = await w.runner.sweep();
    expect(summary.skipped).toBe(1);
    expect(w.outcomes.records[0]).toMatchObject({ status: "skipped", reason: "simulation-reverted", detail: "AlreadyDelivered" });
    expect(w.chain.log.some((entry) => entry.kind === "send")).toBe(false);
  });

  it("skips an item with no fee offer, unless the configuration delivers such items, and then uses the bridge directly", async () => {
    const plain = feedItem({ id: 2 });
    const data = { [word(2)]: feeOfferData({ director: fixedFee(10n), value: 1000n, recipient: address(0x13) }) };
    const strict = world({ items: [plain], data });
    expect((await strict.runner.sweep()).skipped).toBe(1);
    expect(strict.outcomes.records[0]).toMatchObject({ reason: "no-fee-offer", detail: "recipient-is-not-the-delivery-router" });
    expect((strict.prover as { evidenceRuns: number }).evidenceRuns).toBe(0);

    const lenient = world({ items: [plain], data, deliverWithoutOffer: true });
    expect((await lenient.runner.sweep()).delivered).toBe(1);
    const send = lenient.chain.log.find((entry) => entry.kind === "send");
    expect(send?.request.to).toBe(BRIDGE);
    expect(decodeFunctionData({ abi: messageBridgeAbi, data: send?.request.data as Hex }).functionName).toBe("executeMessage");
    expect(lenient.chain.unsimulatedSends()).toEqual([]);
  });

  it("cannot compare a fee in a token that has no price, and prices it when the configuration gives one", async () => {
    const six = feedItem({ id: 1, token: OTHER_TOKEN, decimals: 6 });
    const data = offerData(OTHER_TOKEN);
    const unpriced = world({ items: [six], data });
    unpriced.chain.feeTokens = 2_000_000n;
    await unpriced.runner.sweep();
    expect(unpriced.outcomes.records[0]).toMatchObject({ reason: "no-price-for-fee-token" });

    // 2,000,000 base units of a 6 decimal token are 2 tokens. At 5e15 wei a token the fee is 1e16 wei: it pays.
    const priced = world({ items: [six], data, valuations: { [OTHER_TOKEN.toLowerCase()]: 5_000_000_000_000_000n } });
    priced.chain.feeTokens = 2_000_000n;
    expect((await priced.runner.sweep()).delivered).toBe(1);
    expect(priced.outcomes.records[0]).toMatchObject({ feeExpectedWei: 10_000_000_000_000_000n });
  });

  it("skips an item that the bridge shows as delivered, and never looks at it again", async () => {
    const w = world({ items: [offerItem()], data: offerData() });
    w.chain.feeTokens = COST * 2n;
    w.prover.evidence = async () => evidenceFor({ alreadyDelivered: true });
    await w.runner.sweep();
    expect(w.outcomes.records[0]).toMatchObject({ reason: "already-delivered" });
    expect(Object.keys(w.state.current.finished)).toEqual([word(OFFER_ID)]);
    const runs = (w.prover as { evidenceRuns: number }).evidenceRuns;
    await w.runner.sweep();
    expect((w.prover as { evidenceRuns: number }).evidenceRuns).toBe(runs);
  });

  it("sends the layout calls first, each after a simulation, then the delivery", async () => {
    const w = world({ items: [offerItem()], data: offerData() });
    w.chain.feeTokens = COST * 2n;
    const layoutCall = { function: "addBlockHashLayout", reason: "no row", to: BRIDGE, data: "0xdeadbeef" as Hex };
    let builds = 0;
    w.prover.evidence = async () => {
      builds += 1;
      return evidenceFor({ prerequisites: builds === 1 ? [layoutCall] : [] });
    };
    expect((await w.runner.sweep()).delivered).toBe(1);
    const order = w.chain.log.filter((entry) => entry.kind !== "call").map((entry) => `${entry.kind}:${entry.request.data.slice(0, 10)}`);
    // The first simulation estimates the cost before anything is sent. The second one guards the send itself.
    expect(order).toEqual(["simulate:0xdeadbeef", "simulate:0xdeadbeef", "send:0xdeadbeef", `simulate:${EXECUTE_BATCH}`, `simulate:${EXECUTE_SINGLE}`, `send:${EXECUTE_BATCH}`]);
    expect(w.chain.unsimulatedSends()).toEqual([]);
  });

  it("skips when a layout call reverts in simulation", async () => {
    const w = world({ items: [offerItem()], data: offerData() });
    w.chain.feeTokens = COST * 2n;
    w.prover.evidence = async () => evidenceFor({ prerequisites: [{ function: "addBlockHashLayout", reason: "no row", to: BRIDGE, data: "0xdeadbeef" }] });
    w.chain.simulateOverride = (request) => (request.data === "0xdeadbeef" ? { ok: false, reason: "RowExists" } : undefined);
    await w.runner.sweep();
    expect(w.outcomes.records[0]).toMatchObject({ reason: "prerequisite-reverted" });
    expect(w.chain.log.some((entry) => entry.kind === "send")).toBe(false);
  });

  it("delivers at most the configured number of items in one sweep", async () => {
    const items = [1, 2, 3].map((id) => feedItem({ id, token: WRAPPED_NATIVE }));
    const data = Object.fromEntries(items.map((item) => [item.messageId, feeOfferData({ director: fixedFee(10n), value: 1000n, token: WRAPPED_NATIVE })]));
    const w = world({ items, data, maximumDeliveriesPerSweep: 2 });
    w.chain.feeTokens = COST * 2n;
    expect((await w.runner.sweep()).delivered).toBe(2);
  });

  it("waits before it builds evidence again for an item whose evidence failed", async () => {
    const w = world({ items: [offerItem()], data: offerData() });
    w.chain.feeTokens = COST * 2n;
    w.prover.evidence = async () => {
      throw new Error("the source node does not serve eth_getRawTransactionByHash");
    };
    await w.runner.sweep();
    expect(w.outcomes.records[0]).toMatchObject({ reason: "evidence-failed" });
    await w.runner.sweep();
    expect(w.outcomes.records).toHaveLength(1);
    w.advance(6 * 60 * 1000);
    w.prover.evidence = async () => evidenceFor();
    expect((await w.runner.sweep()).delivered).toBe(1);
  });

  it("survives a restart: a delivered item is not delivered again", async () => {
    const w = world({ items: [offerItem()], data: offerData() });
    w.chain.feeTokens = COST * 2n;
    expect((await w.runner.sweep()).delivered).toBe(1);
    // A new runner over the same state file, as after a restart.
    const restarted = createRunner({
      pairName: "eth-pls",
      direction: "first-to-second",
      sourceChainId: 1,
      destinationChainId: 369,
      lightClientAddress: LIGHT_CLIENT,
      lightClient: w.lightClient,
      delivery: w.delivery,
      state: w.state,
      outcomes: w.outcomes,
      queue: createSerialQueue(),
      now: () => 1_000_000,
      maximumDeliveriesPerSweep: 10,
      prerequisiteLossRefusalMilliseconds: REFUSAL_WINDOW_MILLISECONDS,
      logger: memoryLogger().logger,
    });
    const sends = w.chain.log.filter((entry) => entry.kind === "send").length;
    expect(await restarted.sweep()).toMatchObject({ listed: 0, delivered: 0 });
    expect(w.chain.log.filter((entry) => entry.kind === "send")).toHaveLength(sends);
  });

  describe("the cost of layout calls", () => {
    const layoutCall = { function: "addBlockHashLayout", reason: "no row", to: BRIDGE, data: "0xdeadbeef" as Hex };
    const secondLayoutCall = { function: "addSlotLayout", reason: "no row", to: BRIDGE, data: "0xbeefbeef" as Hex };
    const isLayoutSend = (entry: { kind: string; request: { data: Hex } }) => entry.kind === "send" && entry.request.data.startsWith("0xdeadbeef");

    /** Evidence that lists the layout calls on the first build for a source transaction, and none after. */
    function listLayoutOnce(w: ReturnType<typeof world>, calls: ReadonlyArray<typeof layoutCall>) {
      const built = new Map<string, number>();
      const counter = { builds: 0 };
      w.prover.evidence = async (request: { transactionHash: Hex }) => {
        counter.builds += 1;
        const count = (built.get(request.transactionHash) ?? 0) + 1;
        built.set(request.transactionHash, count);
        return evidenceFor({ prerequisites: count === 1 ? [...calls] : [] });
      };
      return counter;
    }

    const offerFor = (id: number) => feedItem({ id, token: WRAPPED_NATIVE });
    const dataFor = (ids: readonly number[]) => Object.fromEntries(ids.map((id) => [word(id), feeOfferData({ director: fixedFee(10n), value: 1000n, token: WRAPPED_NATIVE })]));
    const executionGasSimulatedAt = (gas: bigint) => (request: { data: Hex }): Simulation | undefined =>
      request.data.startsWith(EXECUTE_SINGLE) ? { ok: true, gas } : undefined;

    it("refuses an item before any layout call when the fee passes the first check but not layout calls plus execution", async () => {
      const w = world({ items: [offerFor(1)], data: dataFor([1]) });
      // The first check prices 300,000 gas at 10 wei: 3,000,000. The fee covers that, and not the 6,000,000 of layout call plus execution.
      w.chain.feeTokens = COST + 1n;
      listLayoutOnce(w, [layoutCall]);
      const summary = await w.runner.sweep();
      expect(summary).toMatchObject({ delivered: 0, skipped: 1 });
      expect(w.outcomes.records[0]).toMatchObject({ status: "skipped", reason: "loss-at-or-above-limit", costWei: 2n * COST });
      expect(w.outcomes.records[0]).not.toHaveProperty("prerequisiteCostWei");
      expect(w.chain.log.some((entry) => entry.kind === "send")).toBe(false);
    });

    it("uses the fallback gas for a layout call that cannot be simulated before the call before it", async () => {
      const w = world({ items: [offerFor(1)], data: dataFor([1]), prerequisiteGasFallback: 1_000_000n });
      // The first call costs 300,000 gas, the second 1,000,000 by the fallback, the execution 300,000: 16,000,000 wei.
      w.chain.feeTokens = 10_000_000n;
      w.chain.simulateOverride = (request) => (request.data === secondLayoutCall.data ? { ok: false, reason: "RowMissing" } : undefined);
      listLayoutOnce(w, [layoutCall, secondLayoutCall]);
      await w.runner.sweep();
      expect(w.outcomes.records[0]).toMatchObject({ reason: "loss-at-or-above-limit", costWei: 16_000_000n });
      expect(w.chain.log.some((entry) => entry.kind === "send")).toBe(false);
    });

    it("delivers the honest case and records what the layout call cost", async () => {
      const w = world({ items: [offerFor(1)], data: dataFor([1]) });
      w.chain.feeTokens = 2n * COST;
      listLayoutOnce(w, [layoutCall]);
      expect((await w.runner.sweep()).delivered).toBe(1);
      expect(w.outcomes.records[0]).toMatchObject({ status: "delivered", prerequisiteCostWei: COST });
    });

    it("stops paying for layout calls when the sweep budget is spent, and refuses before it sends", async () => {
      const ids = [1, 2, 3];
      const w = world({ items: ids.map(offerFor), data: dataFor(ids), maximumPrerequisiteSpendPerSweepWei: 10_000_000n });
      w.chain.feeTokens = 100_000_000n;
      listLayoutOnce(w, [layoutCall]);
      const summary = await w.runner.sweep();
      // One layout call costs 3,000,000 and reserves its worst case of 7,800,000. The second reservation would take the
      // sweep to 3,000,000 + 7,800,000, over the cap of 10,000,000.
      expect(summary).toMatchObject({ delivered: 1, skipped: 2 });
      expect(w.chain.log.filter(isLayoutSend)).toHaveLength(1);
      expect(w.outcomes.records.filter((record) => record.status === "skipped").map((record) => record.reason)).toEqual(["prerequisite-budget-exhausted", "prerequisite-budget-exhausted"]);
    });

    it("counts an item that cost layout gas toward the delivery limit, even when its delivery was skipped", async () => {
      const ids = [1, 2, 3];
      const w = world({ items: ids.map(offerFor), data: dataFor(ids), maximumDeliveriesPerSweep: 1 });
      w.chain.feeTokens = 10_000_000n;
      listLayoutOnce(w, [layoutCall]);
      // The delivery simulation says 10,000,000 gas. The final check fails after the layout call is paid.
      w.chain.simulateOverride = executionGasSimulatedAt(10_000_000n);
      await w.runner.sweep();
      expect(w.chain.log.filter(isLayoutSend)).toHaveLength(1);
    });

    it("records the loss when the final check fails after layout calls, and does not try the item again in the window", async () => {
      const w = world({ items: [offerFor(1)], data: dataFor([1]) });
      w.chain.feeTokens = 10_000_000n;
      const counter = listLayoutOnce(w, [layoutCall]);
      w.chain.simulateOverride = executionGasSimulatedAt(10_000_000n);
      await w.runner.sweep();
      expect(w.outcomes.records[0]).toMatchObject({ status: "skipped", reason: "loss-at-or-above-limit", prerequisiteCostWei: COST });
      const loss = w.events().find((event) => event.event === "prerequisite_loss");
      expect(loss).toMatchObject({ messageId: word(1), lossWei: COST.toString() });
      const builds = counter.builds;
      await w.runner.sweep();
      w.advance(REFUSAL_WINDOW_MILLISECONDS - 1000);
      await w.runner.sweep();
      expect(counter.builds).toBe(builds);
      w.advance(2000);
      await w.runner.sweep();
      expect(counter.builds).toBe(builds + 1);
    });

    describe("spend accounting", () => {
      /** The worst case of one layout call at 300,000 gas: a limit of 390,000 gas at a maximum fee of 20 wei. */
      const RESERVED = 7_800_000n;
      const spentIn = (w: ReturnType<typeof world>) => w.state.current.prerequisiteSpend.map((entry) => BigInt(entry.wei));

      it("refuses a send whose worst case would exceed the cap after reservation, though the estimate fit", async () => {
        const w = world({ items: [offerFor(1)], data: dataFor([1]), maximumPrerequisiteSpendPerSweepWei: 8_000_000n });
        w.chain.feeTokens = 10n ** 12n;
        listLayoutOnce(w, [layoutCall]);
        // The estimate prices 7,800,000 at a base fee of 10. The base fee rises before the send, so the reservation is higher.
        let simulations = 0;
        w.chain.simulateOverride = (request) => {
          if (request.data === layoutCall.data && (simulations += 1) === 2) w.chain.quote = { baseFee: 100n, priorityFee: 0n };
          return undefined;
        };
        await w.runner.sweep();
        expect(w.outcomes.records[0]).toMatchObject({ status: "skipped", reason: "prerequisite-budget-exhausted" });
        expect(w.chain.log.some(isLayoutSend)).toBe(false);
        expect(spentIn(w)).toEqual([]);
      });

      it("sends the layout call at the limit and the fee that the reservation priced", async () => {
        const w = world({ items: [offerFor(1)], data: dataFor([1]) });
        w.chain.feeTokens = 2n * COST;
        listLayoutOnce(w, [layoutCall]);
        await w.runner.sweep();
        const [terms] = w.chain.sentTerms;
        expect(terms).toEqual({ gas: 390_000n, maxFeePerGas: 20n, maxPriorityFeePerGas: 0n });
        expect((terms?.gas ?? 0n) * (terms?.maxFeePerGas ?? 0n)).toBe(RESERVED);
      });

      it("refuses a layout call whose simulation now wants more gas than the approved estimate", async () => {
        const w = world({ items: [offerFor(1)], data: dataFor([1]) });
        w.chain.feeTokens = 10n ** 12n;
        listLayoutOnce(w, [layoutCall]);
        let simulations = 0;
        w.chain.simulateOverride = (request) => (request.data === layoutCall.data && (simulations += 1) === 2 ? { ok: true, gas: 300_001n } : undefined);
        await w.runner.sweep();
        expect(w.outcomes.records[0]).toMatchObject({ status: "skipped", reason: "prerequisite-gas-above-approval" });
        expect(w.chain.log.some(isLayoutSend)).toBe(false);
      });

      it("refuses a layout call that was not in the approved estimate, and counts the loss of the calls before it", async () => {
        const w = world({ items: [offerFor(1)], data: dataFor([1]) });
        w.chain.feeTokens = 10n ** 12n;
        let builds = 0;
        // The first build lists one call. After it is mined the evidence lists another one, which nobody approved.
        w.prover.evidence = async () => evidenceFor({ prerequisites: (builds += 1) === 1 ? [layoutCall] : [secondLayoutCall] });
        await w.runner.sweep();
        expect(w.outcomes.records[0]).toMatchObject({ status: "skipped", reason: "prerequisite-not-approved", prerequisiteCostWei: COST });
        expect(w.chain.log.filter((entry) => entry.kind === "send")).toHaveLength(1);
        expect(w.state.current.prerequisiteLosses.map((entry) => entry.wei)).toEqual([COST.toString()]);
      });

      it("charges the reservation before the send and corrects it to the actual cost at the receipt", async () => {
        const w = world({ items: [offerFor(1)], data: dataFor([1]) });
        w.chain.feeTokens = 2n * COST;
        listLayoutOnce(w, [layoutCall]);
        let chargedAtBroadcast: bigint[] = [];
        const send = w.chain.send.bind(w.chain);
        w.chain.send = async (request) => {
          if (request.data === layoutCall.data) chargedAtBroadcast = spentIn(w);
          return send(request);
        };
        await w.runner.sweep();
        expect(chargedAtBroadcast).toEqual([RESERVED]);
        expect(spentIn(w)).toEqual([COST]);
      });

      it("keeps the reservation charged when the send throws", async () => {
        const w = world({ items: [offerFor(1)], data: dataFor([1]) });
        w.chain.feeTokens = 2n * COST;
        listLayoutOnce(w, [layoutCall]);
        w.chain.sendFailure = new Error("connection lost after broadcast");
        expect(await w.runner.sweep()).toMatchObject({ failed: 1, delivered: 0 });
        expect(spentIn(w)).toEqual([RESERVED]);
      });

      it("counts an error after a layout call toward the sweep limit and the refusal window", async () => {
        const ids = [1, 2, 3];
        const w = world({ items: ids.map(offerFor), data: dataFor(ids), maximumDeliveriesPerSweep: 1 });
        w.chain.feeTokens = 2n * COST;
        const counter = listLayoutOnce(w, [layoutCall]);
        w.chain.sendFailure = new Error("connection lost after broadcast");
        await w.runner.sweep();
        // The error used the one attempt of the sweep, so no second item was tried.
        expect(w.chain.log.filter(isLayoutSend)).toHaveLength(1);
        const builds = counter.builds;
        const sends = () => w.chain.log.filter(isLayoutSend).length;
        // The oldest item waits out the window: the next sweep tries another one, never the first again.
        await w.runner.sweep();
        expect(sends()).toBe(2);
        expect(counter.builds).toBe(builds + 1);
        w.advance(REFUSAL_WINDOW_MILLISECONDS + 1000);
        // The oldest item is tried again. It needs no layout call now, and it is the one attempt of the sweep: its batch
        // is sent (and throws), and the sweep tries no third item.
        await w.runner.sweep();
        expect(sends()).toBe(2);
        expect(counter.builds).toBe(builds + 2);
        expect(w.chain.log.filter((entry) => entry.kind === "send" && entry.request.data.startsWith(EXECUTE_BATCH))).toHaveLength(1);
      });

      it("keeps the daily budget across a restart, blocks on it, and frees it when the window rolls", async () => {
        const first = world({ items: [offerFor(1)], data: dataFor([1]), maximumPrerequisiteSpendPerDayWei: 10_000_000n });
        first.chain.feeTokens = 2n * COST;
        listLayoutOnce(first, [layoutCall]);
        expect((await first.runner.sweep()).delivered).toBe(1);
        expect(spentIn(first)).toEqual([COST]);
        // A new runner with new memory over the same state file. The 3,000,000 spent plus a reservation of 7,800,000 passes 10,000,000.
        const restarted = world({ items: [offerFor(2)], data: dataFor([2]), maximumPrerequisiteSpendPerDayWei: 10_000_000n, state: first.state });
        restarted.chain.feeTokens = 2n * COST;
        listLayoutOnce(restarted, [layoutCall]);
        await restarted.runner.sweep();
        expect(restarted.outcomes.records[0]).toMatchObject({ status: "skipped", reason: "prerequisite-budget-exhausted" });
        expect(restarted.chain.log.some(isLayoutSend)).toBe(false);
        restarted.advance(DAY_MILLISECONDS + 1);
        expect((await restarted.runner.sweep()).delivered).toBe(1);
      });

      it("pauses layout calls once the daily budget is reached, warns, and still delivers an item that needs none", async () => {
        const w = world({ items: [offerFor(1), offerFor(2), offerFor(3)], data: dataFor([1, 2, 3]), maximumPrerequisiteSpendPerDayWei: 8_000_000n });
        w.chain.feeTokens = 10n ** 12n;
        // The first call reports 800,000 gas used: 8,000,000 wei, the whole budget.
        w.chain.gasUsed = 800_000n;
        const needsLayout = new Set([word(0xa1), word(0xa2)].map((hash) => hash.toLowerCase()));
        const built = new Map<string, number>();
        w.prover.evidence = async (request: { transactionHash: Hex }) => {
          const count = (built.get(request.transactionHash) ?? 0) + 1;
          built.set(request.transactionHash, count);
          const wanted = needsLayout.has(request.transactionHash.toLowerCase()) && count === 1;
          return evidenceFor({ prerequisites: wanted ? [layoutCall] : [] });
        };
        await w.runner.sweep();
        const reasons = w.outcomes.records.map((record) => (record.status === "skipped" ? record.reason : record.status));
        // The newest item is last in line. Item 3 needs no layout call, item 2 spends the budget, item 1 is paused. The
        // pause is recorded while the items are prepared, and the deliveries when the batch is mined.
        expect(reasons).toEqual(["prerequisite-budget-exhausted", "delivered", "delivered"]);
        expect(w.events().filter((event) => event.event === "prerequisite_spending_paused")).toHaveLength(1);
        expect(w.chain.log.filter(isLayoutSend)).toHaveLength(1);
      });

      it("pauses layout calls once the unrecovered loss reaches the threshold", async () => {
        const ids = [1, 2];
        // One attempt for each sweep: the batch judges the fee after all items of a sweep are prepared, so the loss of the
        // first item stops the layout calls of the next sweep, not of the same one.
        const w = world({ items: ids.map(offerFor), data: dataFor(ids), maximumUnrecoveredPrerequisiteLossWei: COST, maximumDeliveriesPerSweep: 1 });
        w.chain.feeTokens = 10_000_000n;
        listLayoutOnce(w, [layoutCall]);
        // The final check fails after the layout call is paid: a loss of exactly the threshold.
        w.chain.simulateOverride = executionGasSimulatedAt(10_000_000n);
        await w.runner.sweep();
        await w.runner.sweep();
        expect(w.state.current.prerequisiteLosses.map((entry) => entry.wei)).toEqual([COST.toString()]);
        expect(w.chain.log.filter(isLayoutSend)).toHaveLength(1);
        expect(w.outcomes.records.at(-1)).toMatchObject({ status: "skipped", reason: "prerequisite-budget-exhausted" });
        expect(String((w.outcomes.records.at(-1) as { detail?: string }).detail)).toContain("loss-threshold");
        expect(w.events().some((event) => event.event === "prerequisite_spending_paused")).toBe(true);
      });
    });
  });

  it("never sends a transaction that it did not simulate", async () => {
    const w = world({ items: [offerItem()], data: offerData() });
    w.chain.feeTokens = COST * 2n;
    await deliverItem(w.delivery, offerItem(), ledgerFor(w));
    expect(w.chain.unsimulatedSends()).toEqual([]);
    expect(w.chain.log.filter((entry) => entry.kind === "send")).toHaveLength(1);
  });
});

describe("batch delivery", () => {
  const COST = 3_000_000n;

  /** Items whose proofs differ by the slot of the anchor header, which is the identifier of the item. */
  function batchWorld(ids: readonly number[], options: WorldOptions = {}) {
    const items = ids.map((id) => feedItem({ id, token: WRAPPED_NATIVE }));
    const data = Object.fromEntries(items.map((item) => [item.messageId, feeOfferData({ director: fixedFee(10n), value: 1000n, token: WRAPPED_NATIVE })]));
    const w = world({ items, data, ...options });
    w.chain.feeTokens = COST * 2n;
    w.prover.evidence = async (request: { transactionHash: Hex }) => evidenceFor({ executeData: emptyExecuteMessage(BigInt(Number.parseInt(request.transactionHash.slice(2, 4), 16) - 0xa0)) });
    return w;
  }

  const isBatchSend = (entry: { kind: string; request: { data: Hex } }) => entry.kind === "send" && entry.request.data.startsWith(EXECUTE_BATCH);
  const batchSends = (w: ReturnType<typeof world>) => w.chain.log.filter(isBatchSend);
  const decodedBatch = (data: Hex) => {
    const decoded = decodeFunctionData({ abi: multicall3Abi, data });
    if (decoded.functionName !== "aggregate3") throw new Error(`${decoded.functionName} is no batch`);
    const calls = decoded.args[0];
    expect(calls.every((call) => call.allowFailure)).toBe(true);
    const updateCall = calls.find((call) => call.target.toLowerCase() === LIGHT_CLIENT.toLowerCase());
    const itemCalls = calls.filter((call) => call.target.toLowerCase() === DELIVERY_ROUTER.toLowerCase()).map((call) => decodeFunctionData({ abi: deliveryRouterAbi, data: call.callData }));
    const proofs = itemCalls.map((inner) => (inner.functionName === "executeMessage" ? inner : null));
    // The update call comes first when there is one.
    if (updateCall !== undefined) expect(calls[0]).toBe(updateCall);
    const updateArgs = updateCall === undefined ? null : decodeFunctionData({ abi: beaconLightClientAbi, data: updateCall.callData });
    return {
      slots: proofs.map((inner) => Number(inner?.args[0].anchorHeader.slot)),
      updateProof: updateArgs !== null && updateArgs.functionName === "update" ? updateArgs.args[0] : "0x",
    };
  };
  /** The slots of the proofs of every batch that was sent, in order. */
  const sentSlots = (w: ReturnType<typeof world>) => batchSends(w).map((entry) => decodedBatch(entry.request.data).slots);
  const reasonsOf = (w: ReturnType<typeof world>) => w.outcomes.records.map((record) => (record.status === "skipped" ? record.reason : record.status));

  it("delivers several profitable items in ONE transaction to the batch entry, with the proofs in order, oldest first", async () => {
    const w = batchWorld([1, 2, 3]);
    w.chain.gasUsed = 900_000n;
    expect(await w.runner.sweep()).toMatchObject({ listed: 3, delivered: 3, skipped: 0, failed: 0 });
    expect(batchSends(w)).toHaveLength(1);
    expect(w.chain.log.filter((entry) => entry.kind === "send")).toHaveLength(1);
    const [send] = batchSends(w);
    expect(send?.request.to).toBe(MULTICALL);
    // The feed lists the newest first, so item 3 is the oldest and goes first.
    expect(decodedBatch(send?.request.data as Hex)).toEqual({ slots: [3, 2, 1], updateProof: "0x" });
    expect(w.chain.unsimulatedSends()).toEqual([]);
    // Every item names the one transaction, and carries its third of the gas and of the cost.
    expect(w.outcomes.records.map((record) => record.transactionHash)).toEqual([word(0xee), word(0xee), word(0xee)]);
    expect(w.outcomes.records).toSatisfy((records: Array<Record<string, unknown>>) => records.every((record) => record.gasUsed === 300_000n && record.gasCostWei === COST && record.path === "delivery-router"));
    expect(Object.keys(w.state.current.finished).sort()).toEqual([word(1), word(2), word(3)]);
  });

  it("simulates the batch and the single entry of each item before the send, and reads the batch again under the gas limit that the send uses", async () => {
    const w = batchWorld([1, 2]);
    await w.runner.sweep();
    const [terms] = w.chain.sentTerms;
    const calls = w.chain.log.filter((entry) => entry.kind === "call" && entry.request.data.startsWith(EXECUTE_BATCH));
    // The first read has no limit of its own. The second one runs with exactly the gas limit of the transaction.
    expect(calls.map((entry) => (entry.request as { gas?: bigint }).gas)).toEqual([undefined, terms?.gas]);
    const singles = w.chain.log.filter((entry) => entry.kind === "simulate" && entry.request.data.startsWith(EXECUTE_SINGLE));
    expect(singles).toHaveLength(2);
    // The gas of an item is measured at the router itself, not through Multicall3.
    expect(singles.every((entry) => entry.request.to === DELIVERY_ROUTER)).toBe(true);
    // Multicall3 lets a call fail, so the estimate of the batch cannot size the limit. The limit is the sum of the gas of
    // the items, 600,000, plus the buffer of 30 percent.
    expect(terms?.gas).toBe(780_000n);
  });

  it("drops an item that the simulation shows as delivered, records it as final, and still sends the rest", async () => {
    const w = batchWorld([1, 2, 3]);
    w.chain.batchResult = (position, count) => (count === 3 && position === 1 ? SKIPPED_ALREADY_DELIVERED : EXECUTED);
    expect(await w.runner.sweep()).toMatchObject({ delivered: 2, skipped: 1 });
    // Position 1 of [3, 2, 1] is item 2. The batch that was sent has the other two, simulated again as a set of two.
    expect(sentSlots(w)).toEqual([[3, 1]]);
    expect(w.outcomes.records.find((record) => record.messageId === word(2))).toMatchObject({ status: "skipped", reason: "already-delivered" });
    expect(w.state.current.finished[word(2)]).toBe("elsewhere");
    expect(w.state.current.finished[word(3)]).toBe(word(0xee));
    expect(w.chain.unsimulatedSends()).toEqual([]);
  });

  it("maps a call that would fail to a skip with the reason, and sends nothing for it", async () => {
    const w = batchWorld([1, 2, 3]);
    w.chain.batchResult = (position, count) => {
      if (count !== 3) return EXECUTED;
      return [SKIPPED_INSUFFICIENT_GAS, EXECUTED, FAILED_IN_BRIDGE][position] ?? EXECUTED;
    };
    // Position 0 and position 2 are dropped in the first round. The batch of the one that is left is simulated again.
    await w.runner.sweep();
    expect(sentSlots(w)).toEqual([[2]]);
    const byId = (id: number) => w.outcomes.records.find((record) => record.messageId === word(id));
    expect(byId(3)).toMatchObject({ status: "skipped", reason: "insufficient-gas" });
    expect(byId(1)).toMatchObject({ status: "skipped", reason: "simulation-reverted" });
    expect(String(byId(1)?.detail)).toContain("IndexMismatch");
    expect(String(byId(1)?.detail)).toContain(keccak256(FAILED_IN_BRIDGE.returnData));
    expect(byId(2)).toMatchObject({ status: "delivered" });
  });

  it("leaves an item out of the batch when its fee does not pay at the simulated gas, though it passed the first check", async () => {
    const w = batchWorld([1, 2, 3]);
    // The fee is fixed at 4,000,000 wei. It passes the first check at the assumed 300,000 gas (3,000,000 wei).
    w.chain.feeTokens = 4_000_000n;
    // Item 2 turns out to need 600,000 gas, and 620,000 with the overhead of Multicall3: 6,200,000 wei.
    w.chain.simulateOverride = (request) => {
      if (!request.data.startsWith(EXECUTE_SINGLE)) return undefined;
      const decoded = decodeFunctionData({ abi: deliveryRouterAbi, data: request.data });
      const slot = decoded.functionName === "executeMessage" ? Number(decoded.args[0].anchorHeader.slot) : 0;
      return { ok: true, gas: slot === 2 ? 600_000n : 280_000n };
    };
    expect(await w.runner.sweep()).toMatchObject({ delivered: 2, skipped: 1 });
    expect(sentSlots(w)).toEqual([[3, 1]]);
    expect(w.outcomes.records.find((record) => record.messageId === word(2))).toMatchObject({ status: "skipped", reason: "loss-at-or-above-limit", feeWei: 4_000_000n, costWei: 6_200_000n });
    // The item that did not pay is not final: the next sweep looks at it again.
    expect(w.state.current.finished[word(2)]).toBeUndefined();
  });

  it("splits a sweep into several batches by maximumBatchSize", async () => {
    const w = batchWorld([1, 2, 3, 4, 5], { maximumBatchSize: 2 });
    expect(await w.runner.sweep()).toMatchObject({ delivered: 5 });
    expect(sentSlots(w)).toEqual([[5, 4], [3, 2], [1]]);
  });

  it("splits a sweep into several batches by maximumBatchGas, and the sum of assumed gas in a batch never passes it", async () => {
    // Two items assume 600,000 gas, three would assume 900,000.
    const w = batchWorld([1, 2, 3], { maximumBatchGas: 650_000n });
    expect(await w.runner.sweep()).toMatchObject({ delivered: 3 });
    expect(sentSlots(w)).toEqual([[3, 2], [1]]);
    // The limit of a transaction is its simulated gas with the buffer. No setting cuts it.
    expect(w.chain.sentTerms.map((terms) => terms.gas)).toEqual([780_000n, 390_000n]);
  });

  describe("the gas limit of the transaction follows the gas limit of the message", () => {
    const BIG_FEE = 10n ** 12n;
    /** A batch world whose items carry the given message gas limits, oldest first by id. */
    function gasWorld(gasLimits: readonly number[], options: WorldOptions = {}) {
      const items = gasLimits.map((gasLimit, index) => feedItem({ id: index + 1, token: WRAPPED_NATIVE, gasLimit }));
      const data = Object.fromEntries(items.map((item) => [item.messageId, feeOfferData({ director: fixedFee(10n), value: 1000n, token: WRAPPED_NATIVE })]));
      const w = world({ items, data, ...options });
      w.chain.feeTokens = BIG_FEE;
      w.prover.evidence = async (request: { transactionHash: Hex }) => evidenceFor({ executeData: emptyExecuteMessage(BigInt(Number.parseInt(request.transactionHash.slice(2, 4), 16) - 0xa0)) });
      return w;
    }

    it("the transaction gas limit is at least the sum of required delivery gas of its items", async () => {
      const w = gasWorld([1_000_000, 2_000_000]);
      expect(await w.runner.sweep()).toMatchObject({ delivered: 2 });
      expect(sentSlots(w)).toHaveLength(1);
      const required = requiredDeliveryGas(1_000_000n) + requiredDeliveryGas(2_000_000n);
      // The simulated gas of each item is 280,000, so the buffered limit alone would be far below the need of the bridge.
      expect(w.chain.sentTerms[0]?.gas).toBe(required);
    });

    it("packs by the message limit, not by one assumed number: a large message leaves room for fewer companions", async () => {
      const w = gasWorld([1_000_000, 1_000_000, 4_000_000]);
      expect(await w.runner.sweep()).toMatchObject({ delivered: 3 });
      // 4,000,000 and 1,000,000 assume about 5.7 million together. A third item would pass 6,000,000.
      expect(sentSlots(w)).toEqual([[3, 2], [1]]);
    });

    it("sends a message above the batch maximum alone, with exactly the gas it needs and never truncated", async () => {
      const w = gasWorld([100_000, 7_000_000, 100_000]);
      expect(await w.runner.sweep()).toMatchObject({ delivered: 3 });
      // The two small items share a batch. The large one follows in a transaction of its own.
      expect(sentSlots(w)).toEqual([[3, 1], [2]]);
      expect(w.chain.sentTerms[1]?.gas).toBe(requiredDeliveryGas(7_000_000n));
      expect(w.chain.sentTerms[1]?.gas).toBeGreaterThan(6_000_000n);
    });

    it("skips a message above the batch maximum with message-gas-above-batch-maximum when the node refuses to run it", async () => {
      const w = gasWorld([7_000_000]);
      w.chain.simulateOverride = (request) => (request.data.startsWith(EXECUTE_BATCH) ? { ok: false, reason: "intrinsic gas too high" } : undefined);
      expect(await w.runner.sweep()).toMatchObject({ delivered: 0, skipped: 1 });
      expect(w.outcomes.records[0]).toMatchObject({ status: "skipped", reason: "message-gas-above-batch-maximum" });
      expect(String(w.outcomes.records[0]?.detail)).toContain("intrinsic gas too high");
      expect(w.chain.log.some((entry) => entry.kind === "send")).toBe(false);
    });

    it("skips a message above the batch maximum when the node refuses the read at its gas limit", async () => {
      const w = gasWorld([7_000_000]);
      const original = w.chain.call.bind(w.chain);
      // Only the read under the gas limit of the transaction names a gas limit.
      w.chain.call = async (request) => {
        if (request.gas !== undefined) throw new Error("gas limit above the block limit");
        return original(request);
      };
      await w.runner.sweep();
      expect(w.outcomes.records[0]).toMatchObject({ status: "skipped", reason: "message-gas-above-batch-maximum" });
    });
  });

  it("sends nothing and skips every item when the simulation of the batch reverts", async () => {
    const w = batchWorld([1, 2]);
    w.chain.simulateOverride = (request) => (request.data.startsWith(EXECUTE_BATCH) ? { ok: false, reason: "NotRunner" } : undefined);
    expect(await w.runner.sweep()).toMatchObject({ delivered: 0, skipped: 2 });
    expect(w.chain.log.some((entry) => entry.kind === "send")).toBe(false);
    expect(w.outcomes.records).toSatisfy((records: Array<Record<string, unknown>>) => records.every((record) => record.reason === "simulation-reverted" && record.detail === "NotRunner"));
  });

  it("stops after a bounded number of rounds, and skips the items that are still in flux instead of sending an unchecked batch", async () => {
    const w = batchWorld([1, 2, 3, 4]);
    // The router always skips the first item of whatever batch it gets, so each round drops one more item.
    w.chain.batchResult = (position) => (position === 0 ? SKIPPED_INSUFFICIENT_GAS : EXECUTED);
    await w.runner.sweep();
    expect(MAXIMUM_SETTLING_ROUNDS).toBe(3);
    expect(w.chain.log.some((entry) => entry.kind === "send")).toBe(false);
    expect(reasonsOf(w)).toEqual(["insufficient-gas", "insufficient-gas", "insufficient-gas", "batch-did-not-settle"]);
  });

  it("delivers an item without an offer straight to the bridge, and the items with an offer in a batch", async () => {
    const offered = feedItem({ id: 1, token: WRAPPED_NATIVE });
    const plain = feedItem({ id: 2 });
    const data = {
      [word(1)]: feeOfferData({ director: fixedFee(10n), value: 1000n, token: WRAPPED_NATIVE }),
      [word(2)]: feeOfferData({ director: fixedFee(10n), value: 1000n, recipient: address(0x13) }),
    };
    const w = world({ items: [offered, plain], data, deliverWithoutOffer: true });
    w.chain.feeTokens = COST * 2n;
    // Only the item with an offer is in the batch.
    w.chain.messageIdOfPosition = () => word(1);
    expect(await w.runner.sweep()).toMatchObject({ delivered: 2 });
    const sends = w.chain.log.filter((entry) => entry.kind === "send");
    expect(sends.map((entry) => entry.request.to).sort()).toEqual([BRIDGE, MULTICALL].sort());
    expect(batchSends(w)).toHaveLength(1);
    expect(w.outcomes.records.map((record) => record.path).sort()).toEqual(["bridge", "delivery-router"]);
  });

  describe("the outcome of each item after the receipt", () => {
    it("attributes the fee transfers to the reward address item by item, from the order of the events", async () => {
      const w = batchWorld([1, 2]);
      const token = WRAPPED_NATIVE;
      w.chain.receiptLogsOfItem = (position) => [transferLog(token, REWARD_ADDRESS, position === 0 ? 111n : 222n), transferLog(token, RUNNER, 999n), transferLog(OTHER_TOKEN, REWARD_ADDRESS, 555n)];
      await w.runner.sweep();
      const byId = (id: number) => w.outcomes.records.find((record) => record.messageId === word(id));
      // Item 2 is position 0 and item 1 is position 1. The signer's own transfers and other tokens do not count.
      expect(byId(2)?.feeReceivedTokens).toBe(111n);
      expect(byId(1)?.feeReceivedTokens).toBe(222n);
    });

    it("delivers what the bridge events call executed, fails the rest, and records the cost share of the rest as an unrecovered loss", async () => {
      const w = batchWorld([1, 2, 3]);
      w.chain.gasUsed = 900_000n; // 9,000,000 wei at 10 wei: a third, 3,000,000 wei, for each item.
      // The read-only simulation sees three executions. The mined batch differs: the state moved between the two.
      w.chain.receiptResult = (position) => [EXECUTED, SKIPPED_INSUFFICIENT_GAS, FAILED_IN_BRIDGE][position] ?? EXECUTED;
      expect(await w.runner.sweep()).toMatchObject({ delivered: 1, skipped: 0, failed: 2 });
      const byId = (id: number) => w.outcomes.records.find((record) => record.messageId === word(id));
      // Positions 0, 1, 2 are items 3, 2, 1. Multicall3 keeps no revert data in the receipt, so the reason is unknown.
      expect(byId(3)).toMatchObject({ status: "delivered", gasUsed: 300_000n, gasCostWei: COST });
      expect(byId(2)).toMatchObject({ status: "failed", reason: "batch-result-missing" });
      expect(byId(1)).toMatchObject({ status: "failed", reason: "batch-result-missing" });
      expect(w.state.current.prerequisiteLosses.map((entry) => entry.wei)).toEqual(["6000000"]);
      // Only the delivered item is final. The two others are tried again later.
      expect(Object.keys(w.state.current.finished)).toEqual([word(3)]);
    });

    it("fails every item when the whole transaction reverts, and records the whole cost as a loss", async () => {
      const w = batchWorld([1, 2, 3]);
      w.chain.receiptSuccess = false;
      w.chain.gasUsed = 900_000n;
      expect(await w.runner.sweep()).toMatchObject({ delivered: 0, failed: 3 });
      expect(w.outcomes.records).toHaveLength(3);
      expect(w.outcomes.records).toSatisfy((records: Array<Record<string, unknown>>) => records.every((record) => record.status === "failed" && record.reason === "transaction-reverted" && record.transactionHash === word(0xee)));
      expect(w.state.current.prerequisiteLosses.map((entry) => entry.wei)).toEqual(["9000000"]);
      expect(w.state.current.finished).toEqual({});
    });

    it("fails an item that the bridge does not report in a receipt that succeeded, because its state is unknown", async () => {
      const w = batchWorld([1, 2]);
      const send = w.chain.send.bind(w.chain);
      w.chain.send = async (request) => {
        const receipt = await send(request);
        // Only the release and the bridge event of position 0 reach the receipt.
        return { ...receipt, logs: receipt.logs.slice(0, 2) };
      };
      expect(await w.runner.sweep()).toMatchObject({ delivered: 1, failed: 1 });
      expect(w.outcomes.records.find((record) => record.messageId === word(1))).toMatchObject({ status: "failed", reason: "batch-result-missing" });
    });
  });

  describe("the light client update in the batch", () => {
    const PROOF = `0x${"ab".repeat(356)}`;
    const isUpdateSend = (entry: { kind: string; request: { to: string } }) => entry.kind === "send" && entry.request.to === LIGHT_CLIENT;
    const updateRecord = (w: ReturnType<typeof world>) => w.outcomes.records.find((record) => record.kind === "update");

    it("carries the update and the messages in ONE transaction, and posts no update of its own", async () => {
      const w = batchWorld([1, 2]);
      w.chain.gasUsed = 900_000n; // weights: 300,000 for each item and 300,000 for the update
      const handling = await w.runner.handleProofPayload(proofPayload({ startSlot: 100n, newSlot: 164n }));
      expect(handling).toEqual({ handled: "update-posted", transactionHash: word(0xee) });
      expect(w.chain.log.filter((entry) => entry.kind === "send")).toHaveLength(1);
      expect(w.chain.log.some(isUpdateSend)).toBe(false);
      const [send] = batchSends(w);
      expect(decodedBatch(send?.request.data as Hex)).toMatchObject({ slots: [2, 1], updateProof: PROOF });
      expect(updateRecord(w)).toMatchObject({ status: "posted", transactionHash: word(0xee), newSlot: 164n, gasUsed: 300_000n, gasCostWei: COST });
      expect(w.outcomes.records.filter((record) => record.status === "delivered")).toHaveLength(2);
      expect(w.chain.unsimulatedSends()).toEqual([]);
      // The update is the price of the batch and not a loss.
      expect(w.state.current.prerequisiteLosses).toEqual([]);
    });

    it("sends an empty update when no proof waits, which behaves as a batch without update", async () => {
      const w = batchWorld([1]);
      await w.runner.sweep();
      expect(sentSlots(w)).toEqual([[1]]);
      expect(decodedBatch(batchSends(w)[0]?.request.data as Hex).updateProof).toBe("0x");
      expect(updateRecord(w)).toBeUndefined();
    });

    it("leaves the update out when someone else posted it first: the head passed it before the batch was built", async () => {
      const w = batchWorld([1]);
      let reads = 0;
      // The first read is the check of the proof. The next one finds that the head moved on.
      w.lightClient.read = async () => ((reads += 1) === 1 ? w.lightClient.state : { ...w.lightClient.state, headSlot: 164n });
      const handling = await w.runner.handleProofPayload(proofPayload({ startSlot: 100n, newSlot: 164n }));
      expect(handling).toMatchObject({ handled: "update-skipped", reason: "already-stored" });
      expect(decodedBatch(batchSends(w)[0]?.request.data as Hex).updateProof).toBe("0x");
      expect(w.chain.log.some(isUpdateSend)).toBe(false);
      expect(w.outcomes.records.filter((record) => record.status === "delivered")).toHaveLength(1);
    });

    it("leaves the update out when the light client would refuse it as already advanced, and still delivers", async () => {
      const w = batchWorld([1]);
      w.chain.updateResult = SKIPPED_HEAD_ADVANCED;
      const handling = await w.runner.handleProofPayload(proofPayload());
      expect(handling).toMatchObject({ handled: "update-skipped", reason: "head-already-advanced" });
      // The batch that went out has no update, and no second transaction posts one.
      expect(decodedBatch(batchSends(w)[0]?.request.data as Hex).updateProof).toBe("0x");
      expect(w.chain.log.filter((entry) => entry.kind === "send")).toHaveLength(1);
      expect(updateRecord(w)).toMatchObject({ status: "skipped", reason: "head-already-advanced" });
    });

    it("leaves the update out when the light client would revert it, and does not offer it again", async () => {
      const w = batchWorld([1]);
      w.chain.updateResult = UPDATE_FAILED;
      expect(await w.runner.handleProofPayload(proofPayload())).toMatchObject({ handled: "update-skipped", reason: "update-failed" });
      expect(String(updateRecord(w)?.detail)).toContain("InvalidPublicValuesLength");
      expect(w.outcomes.records.filter((record) => record.status === "delivered")).toHaveLength(1);
    });

    it("leaves out items whose share of the update makes the loss too high, and posts the update alone", async () => {
      const w = batchWorld([1, 2]);
      // Each item pays 100,000 wei above its cost of 3,000,000. With half of the update (1,500,000) the cost is 4,500,000.
      w.chain.feeTokens = COST + 100_000n;
      const handling = await w.runner.handleProofPayload(proofPayload());
      expect(batchSends(w)).toHaveLength(0);
      expect(w.outcomes.records.filter((record) => record.status === "skipped" && record.reason === "loss-at-or-above-limit")).toHaveLength(2);
      expect(w.outcomes.records[0]).toMatchObject({ costWei: 4_500_000n });
      // The runner still posts the update, as it did before batches existed.
      expect(w.chain.log.filter(isUpdateSend)).toHaveLength(1);
      expect(handling).toMatchObject({ handled: "update-posted" });
      // Next sweep, with the update out of the way, the same items pay for themselves.
      expect(await w.runner.sweep()).toMatchObject({ delivered: 2 });
      expect(decodedBatch(batchSends(w)[0]?.request.data as Hex).updateProof).toBe("0x");
    });

    it("sends the batch with the update when the loss with the share of the update stays under 20 percent, and not at exactly 20", async () => {
      const w = batchWorld([1, 2]);
      // Cost with the share of the update: 4,500,000. A fee of 3,600,000 loses exactly 20 percent.
      w.chain.feeTokens = 3_600_001n;
      await w.runner.handleProofPayload(proofPayload());
      expect(batchSends(w)).toHaveLength(1);
      expect(decodedBatch(batchSends(w)[0]?.request.data as Hex).updateProof).toBe(PROOF);
      const exact = batchWorld([1, 2]);
      exact.chain.feeTokens = 3_600_000n;
      await exact.runner.handleProofPayload(proofPayload());
      expect(batchSends(exact).filter((entry) => decodedBatch(entry.request.data).updateProof !== "0x")).toHaveLength(0);
    });

    it("each item's cost includes its share of the update, split by gas", async () => {
      const w = batchWorld([1, 2]);
      w.chain.feeTokens = 4_100_000n;
      w.chain.updateGas = 400_000n;
      // Item 1 needs 80,000 gas (100,000 with the overhead of Multicall3). Item 2 needs 280,000 (300,000).
      w.chain.simulateOverride = (request) => {
        if (!request.data.startsWith(EXECUTE_SINGLE)) return undefined;
        const decoded = decodeFunctionData({ abi: deliveryRouterAbi, data: request.data });
        const slot = decoded.functionName === "executeMessage" ? Number(decoded.args[0].anchorHeader.slot) : 0;
        return { ok: true, gas: slot === 1 ? 80_000n : 280_000n };
      };
      await w.runner.handleProofPayload(proofPayload());
      // The update takes 400,000 gas, split 1 to 3. Item 1 carries 100,000 and item 2 carries 300,000, so its cost is
      // 600,000 gas, 6,000,000 wei, and its loss is over 20 percent. An even split would give it 500,000 gas.
      expect(w.outcomes.records.find((record) => record.messageId === word(2))).toMatchObject({ status: "skipped", reason: "loss-at-or-above-limit", costWei: 6_000_000n });
      // Item 1 alone then carries the whole update: 500,000 gas, 5,000,000 wei, a loss of 18 percent.
      expect(w.outcomes.records.find((record) => record.messageId === word(1))).toMatchObject({ status: "delivered" });
      expect(sentSlots(w)).toEqual([[1]]);
      expect(decodedBatch(batchSends(w)[0]?.request.data as Hex).updateProof).toBe(PROOF);
    });

    it("counts the share of the update as a loss when the mined batch did not apply it", async () => {
      const w = batchWorld([1]);
      w.chain.gasUsed = 600_000n; // 300,000 for the item and 300,000 for the update
      // The read-only call applies the update. The mined batch finds the head moved: the update is skipped.
      w.chain.receiptUpdateResult = SKIPPED_HEAD_ADVANCED;
      expect(await w.runner.handleProofPayload(proofPayload())).toMatchObject({ handled: "update-skipped" });
      expect(w.state.current.prerequisiteLosses.map((entry) => entry.wei)).toEqual([COST.toString()]);
    });

    it("keeps an item whose anchor is not stored eligible for the next sweep, without a waiting period", async () => {
      const w = batchWorld([1]);
      w.chain.batchResult = () => SKIPPED_ANCHOR_NOT_STORED;
      await w.runner.sweep();
      expect(w.outcomes.records[0]).toMatchObject({ status: "skipped", reason: "anchor-not-stored" });
      expect(w.state.current.finished).toEqual({});
      // The light client stored the header. The very next sweep delivers the item.
      w.chain.batchResult = () => EXECUTED;
      expect(await w.runner.sweep()).toMatchObject({ delivered: 1 });
    });
  });

  describe("the reservation of a batch", () => {
    it("charges the worst case of the whole transaction before the send, settles it to the actual cost at the receipt, and keeps it apart from the layout spend", async () => {
      // A daily budget of 1 wei would stop any layout call. A delivery is not limited by it, because the fee repays it.
      const w = batchWorld([1], { maximumPrerequisiteSpendPerDayWei: 1n });
      let chargedAtBroadcast: string[] = [];
      const send = w.chain.send.bind(w.chain);
      w.chain.send = async (request) => {
        chargedAtBroadcast = w.state.current.deliverySpend.map((entry) => entry.wei);
        return send(request);
      };
      expect(await w.runner.sweep()).toMatchObject({ delivered: 1 });
      // One item of 300,000 gas: with the buffer of 30 percent a limit of 390,000, at a maximum fee of twice the base fee of 10.
      expect(chargedAtBroadcast).toEqual(["7800000"]);
      expect(w.state.current.deliverySpend.map((entry) => entry.wei)).toEqual([COST.toString()]);
      expect(w.state.current.prerequisiteSpend).toEqual([]);
    });

    it("keeps the reservation charged when the send throws, and waits before it tries the items again", async () => {
      const w = batchWorld([1, 2]);
      w.chain.sendFailure = new Error("connection lost after broadcast");
      expect(await w.runner.sweep()).toMatchObject({ delivered: 0, failed: 2 });
      // Two items: a limit of 780,000 at 20 wei.
      expect(w.state.current.deliverySpend.map((entry) => entry.wei)).toEqual(["15600000"]);
      expect(w.state.current.finished).toEqual({});
      const sends = w.chain.log.filter(isBatchSend).length;
      await w.runner.sweep();
      expect(w.chain.log.filter(isBatchSend)).toHaveLength(sends);
    });

    it("counts the layout calls of the items of a batch that threw as a loss", async () => {
      const w = batchWorld([1]);
      const layoutCall = { function: "addBlockHashLayout", reason: "no row", to: BRIDGE, data: "0xdeadbeef" as Hex };
      let builds = 0;
      w.prover.evidence = async () => evidenceFor({ prerequisites: (builds += 1) === 1 ? [layoutCall] : [], executeData: emptyExecuteMessage(1n) });
      const send = w.chain.send.bind(w.chain);
      w.chain.send = async (request) => {
        if (request.data.startsWith(EXECUTE_BATCH)) throw new Error("connection lost after broadcast");
        return send(request);
      };
      await w.runner.sweep();
      expect(w.state.current.prerequisiteLosses.map((entry) => entry.wei)).toEqual([COST.toString()]);
    });
  });
});

describe("sweeps of one runner", () => {
  it("never overlap: a second sweep waits until the first ends", async () => {
    const w = world({ items: [feedItem({ id: 1, token: WRAPPED_NATIVE })], data: { [word(1)]: feeOfferData({ director: fixedFee(10n), value: 1000n, token: WRAPPED_NATIVE }) } });
    let running = 0;
    let overlapped = false;
    const listFeed = w.indexer.listFeed.bind(w.indexer);
    w.indexer.listFeed = async (query) => {
      running += 1;
      overlapped = overlapped || running > 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      running -= 1;
      return listFeed(query);
    };
    await Promise.all([w.runner.sweep(), w.runner.sweep(), w.runner.sweep()]);
    expect(overlapped).toBe(false);
  });
});
