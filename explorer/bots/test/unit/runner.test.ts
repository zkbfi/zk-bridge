import { decodeFunctionData, toFunctionSelector, type Hex } from "viem";
import { beaconLightClientAbi, feeRouterAbi, messageBridgeAbi } from "@zk-bridge/shared";
import { describe, expect, it } from "vitest";
import type { Simulation } from "../../src/chain/transactions.ts";
import type { FeedItem } from "../../src/indexer/client.ts";
import type { StateStore } from "../../src/runtime/state-file.ts";
import { deliverItem } from "../../src/runner/delivery.ts";
import { createPrerequisiteLedger } from "../../src/runner/prerequisite-ledger.ts";
import type { DeliverySettings } from "../../src/runner/delivery.ts";
import type { Logger } from "../../src/logging/logger.ts";
import { createRunner } from "../../src/runner/runner.ts";
import { createSerialQueue } from "../../src/runner/serial-queue.ts";
import { INITIAL_RUNNER_STATE, type RunnerState } from "../../src/runner/state.ts";
import {
  BRIDGE,
  FEE_ROUTER,
  LIGHT_CLIENT,
  OTHER_TOKEN,
  RUNNER,
  WRAPPED_NATIVE,
  address,
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
  word,
} from "../support/builders.ts";

const EXECUTE_WITH_RUNNER = toFunctionSelector(feeRouterAbi.find((entry) => entry.type === "function" && entry.name === "executeMessageWithRunner") as never);
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
        const { prerequisiteSpend, prerequisiteLosses } = await w.state.load();
        return { prerequisiteSpend, prerequisiteLosses };
      },
      async update(mutate) {
        await w.state.update((state) => {
          const budget = { prerequisiteSpend: state.prerequisiteSpend, prerequisiteLosses: state.prerequisiteLosses };
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
  margin?: bigint;
  deliverWithoutOffer?: boolean;
  valuations?: Record<string, bigint>;
  executionGasFallback?: bigint;
  maximumDeliveriesPerSweep?: number;
  prerequisiteGasFallback?: bigint;
  maximumPrerequisiteSpendPerSweepWei?: bigint;
  maximumPrerequisiteSpendPerDayWei?: bigint;
  maximumUnrecoveredPrerequisiteLossWei?: bigint;
  /** A state that an earlier runner wrote, to test a restart. */
  state?: ReturnType<typeof memoryState>;
  startTime?: number;
}

/** A runner on fakes: chain, indexer, prover, board payloads. Base fee 10 wei, 300,000 gas: a cost of 3,000,000 wei. */
function world(options: WorldOptions = {}) {
  const { logger, events } = memoryLogger();
  const chain = fakeChain();
  chain.feeTokens = 0n;
  const items = options.items ?? [];
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
    feeRouter: FEE_ROUTER,
    wrappedNative: WRAPPED_NATIVE,
    settings: {
      minimumMarginWei: options.margin ?? 0n,
      deliverWithoutOffer: options.deliverWithoutOffer ?? false,
      tokenValuationsWei: options.valuations ?? {},
      executionGasFallback: options.executionGasFallback ?? 300_000n,
      maximumPrerequisiteRounds: 3,
      prerequisiteGasFallback: options.prerequisiteGasFallback ?? 300_000n,
      maximumPrerequisiteSpendPerSweepWei: options.maximumPrerequisiteSpendPerSweepWei ?? 10n ** 18n,
      maximumPrerequisiteSpendPerDayWei: options.maximumPrerequisiteSpendPerDayWei ?? 10n ** 18n,
      maximumUnrecoveredPrerequisiteLossWei: options.maximumUnrecoveredPrerequisiteLossWei ?? 10n ** 18n,
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

  it("delivers when the fee covers the cost, through the fee router, naming the runner", async () => {
    const w = world({ items: [offerItem()], data: offerData() });
    w.chain.feeTokens = COST + 1n;
    const summary = await w.runner.sweep();
    expect(summary).toMatchObject({ delivered: 1, skipped: 0 });
    const send = w.chain.log.find((entry) => entry.kind === "send");
    expect(send?.request.to).toBe(FEE_ROUTER);
    const decoded = decodeFunctionData({ abi: feeRouterAbi, data: send?.request.data as Hex });
    expect(decoded.functionName).toBe("executeMessageWithRunner");
    expect(decoded.args?.[0]).toBe(RUNNER);
    expect(w.chain.unsimulatedSends()).toEqual([]);
    expect(w.outcomes.records[0]).toMatchObject({ kind: "delivery", status: "delivered", path: "fee-router", feeExpectedWei: COST + 1n });
  });

  it("delivers at the exact boundary: fee equals cost plus margin", async () => {
    const w = world({ items: [offerItem()], data: offerData(), margin: 500n });
    w.chain.feeTokens = COST + 500n;
    expect((await w.runner.sweep()).delivered).toBe(1);
  });

  it("skips when the fee is one wei short of cost plus margin, and builds no evidence", async () => {
    const w = world({ items: [offerItem()], data: offerData(), margin: 500n });
    w.chain.feeTokens = COST + 499n;
    const summary = await w.runner.sweep();
    expect(summary).toMatchObject({ delivered: 0, skipped: 1 });
    expect(w.outcomes.records[0]).toMatchObject({ status: "skipped", reason: "fee-below-cost-plus-margin", feeWei: COST + 499n, costWei: COST });
    expect((w.prover as { evidenceRuns: number }).evidenceRuns).toBe(0);
    expect(w.chain.log.some((entry) => entry.kind === "send")).toBe(false);
  });

  it("checks the fee again at the simulated gas, and skips when the real cost is higher than the assumed cost", async () => {
    const w = world({ items: [offerItem()], data: offerData(), executionGasFallback: 100_000n });
    w.chain.feeTokens = 2_000_000n; // pays for 100,000 gas at 10 wei, not for 300,000
    w.chain.gas = 300_000n;
    const summary = await w.runner.sweep();
    expect(summary).toMatchObject({ delivered: 0, skipped: 1 });
    expect(w.outcomes.records[0]).toMatchObject({ reason: "fee-below-cost-plus-margin", costWei: COST });
    expect((w.prover as { evidenceRuns: number }).evidenceRuns).toBe(1);
    expect(w.chain.log.some((entry) => entry.kind === "send")).toBe(false);
  });

  it("skips and sends nothing when the delivery simulation reverts", async () => {
    const w = world({ items: [offerItem()], data: offerData() });
    w.chain.feeTokens = COST * 2n;
    w.chain.simulateOverride = (request): Simulation | undefined =>
      request.data.startsWith(EXECUTE_WITH_RUNNER) ? { ok: false, reason: "AlreadyDelivered" } : undefined;
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
    expect(strict.outcomes.records[0]).toMatchObject({ reason: "no-fee-offer", detail: "recipient-is-not-the-fee-router" });
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
    expect(order).toEqual(["simulate:0xdeadbeef", "simulate:0xdeadbeef", "send:0xdeadbeef", `simulate:${EXECUTE_WITH_RUNNER}`, `send:${EXECUTE_WITH_RUNNER}`]);
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
      request.data.startsWith(EXECUTE_WITH_RUNNER) ? { ok: true, gas } : undefined;

    it("refuses an item before any layout call when the fee passes the first check but not layout calls plus execution", async () => {
      const w = world({ items: [offerFor(1)], data: dataFor([1]) });
      // The first check prices 300,000 gas at 10 wei: 3,000,000. The fee covers that, and not the 6,000,000 of layout call plus execution.
      w.chain.feeTokens = COST + 1n;
      listLayoutOnce(w, [layoutCall]);
      const summary = await w.runner.sweep();
      expect(summary).toMatchObject({ delivered: 0, skipped: 1 });
      expect(w.outcomes.records[0]).toMatchObject({ status: "skipped", reason: "fee-below-cost-plus-margin", costWei: 2n * COST });
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
      expect(w.outcomes.records[0]).toMatchObject({ reason: "fee-below-cost-plus-margin", costWei: 16_000_000n });
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
      expect(w.outcomes.records[0]).toMatchObject({ status: "skipped", reason: "fee-below-cost-plus-margin", prerequisiteCostWei: COST });
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
        await w.runner.sweep();
        expect(sends()).toBe(3);
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
        // The newest item is last in line. Item 3 needs no layout call and is delivered, item 2 spends the budget, item 1 is paused.
        expect(reasons).toEqual(["delivered", "delivered", "prerequisite-budget-exhausted"]);
        expect(w.events().filter((event) => event.event === "prerequisite_spending_paused")).toHaveLength(1);
        expect(w.chain.log.filter(isLayoutSend)).toHaveLength(1);
      });

      it("pauses layout calls once the unrecovered loss reaches the threshold", async () => {
        const ids = [1, 2];
        const w = world({ items: ids.map(offerFor), data: dataFor(ids), maximumUnrecoveredPrerequisiteLossWei: COST });
        w.chain.feeTokens = 10_000_000n;
        listLayoutOnce(w, [layoutCall]);
        // The final check fails after the layout call is paid: a loss of exactly the threshold.
        w.chain.simulateOverride = executionGasSimulatedAt(10_000_000n);
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
