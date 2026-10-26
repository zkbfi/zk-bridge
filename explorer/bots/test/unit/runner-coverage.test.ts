import { encodeFunctionData, type Hex } from "viem";
import { beaconLightClientAbi } from "@zk-bridge/shared";
import { describe, expect, it } from "vitest";
import type { FeedItem } from "../../src/indexer/client.ts";
import type { StateStore } from "../../src/runtime/state-file.ts";
import { BATCH_ITEM_OVERHEAD_GAS } from "../../src/runner/batch.ts";
import { createRunner, PAYLOAD_MEMORY_MILLISECONDS, RETRY_AFTER_MILLISECONDS } from "../../src/runner/runner.ts";
import { createSerialQueue } from "../../src/runner/serial-queue.ts";
import { INITIAL_RUNNER_STATE, type RunnerState } from "../../src/runner/state.ts";
import {
  DELIVERY_ROUTER,
  LIGHT_CLIENT,
  MULTICALL,
  REWARD_ADDRESS,
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
  proofMessage,
  proofPayload,
  word,
} from "../support/builders.ts";

/** One call costs 300,000 gas at a base fee of 10 wei. */
const COST = 3_000_000n;
const REFUSAL_WINDOW_MILLISECONDS = 30 * 60 * 1000;
const START_TIME = 1_000_000;

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

interface WorldOptions {
  readonly ids?: readonly number[];
  readonly maximumBatchSize?: number;
  readonly items?: readonly FeedItem[];
}

/** A runner on fakes. The items pay twice their cost, and the feed lists the newest first. */
function world(options: WorldOptions = {}) {
  const { logger, events } = memoryLogger();
  const chain = fakeChain();
  chain.feeTokens = COST * 2n;
  chain.executionGas = 300_000n - BATCH_ITEM_OVERHEAD_GAS;
  const items = options.items ?? (options.ids ?? []).map((id) => feedItem({ id, token: WRAPPED_NATIVE }));
  chain.messageIdOfPosition = (position) => (([...items].reverse()[position]?.messageId ?? word(position + 1)) as Hex);
  const offer = feeOfferData({ director: { recipient: address(0x12), settings: 1n, limit: 10n, multiplier: 0n }, value: 1000n, token: WRAPPED_NATIVE });
  const indexer = fakeIndexer(items, Object.fromEntries(items.map((item) => [item.messageId, offer])));
  const prover = fakeProver();
  // The proofs differ by the slot of the anchor header, which is the identifier of the item.
  prover.evidence = async (request: { transactionHash: Hex }) => evidenceFor({ executeData: emptyExecuteMessage(BigInt(Number.parseInt(request.transactionHash.slice(2, 4), 16) - 0xa0)) });
  const lightClient = fakeLightClient();
  const state = memoryState();
  const outcomes = memoryOutcomes();
  let clock = START_TIME;
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
    settings: {
      minimumMarginWei: 0n,
      deliverWithoutOffer: false,
      tokenValuationsWei: {},
      executionGasFallback: 300_000n,
      maximumPrerequisiteRounds: 3,
      prerequisiteGasFallback: 300_000n,
      maximumPrerequisiteSpendPerSweepWei: 10n ** 18n,
      maximumPrerequisiteSpendPerDayWei: 10n ** 18n,
      maximumUnrecoveredPrerequisiteLossWei: 10n ** 18n,
      maximumBatchSize: options.maximumBatchSize ?? 5,
      maximumBatchGas: 6_000_000n,
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
    maximumDeliveriesPerSweep: 10,
    prerequisiteLossRefusalMilliseconds: REFUSAL_WINDOW_MILLISECONDS,
    logger,
  });
  return { runner, chain, prover, lightClient, state, outcomes, events, indexer, advance: (milliseconds: number) => (clock += milliseconds) };
}

const updateCall = (newSlot: bigint) => {
  const message = proofMessage({ startSlot: 100n, newSlot });
  return encodeFunctionData({ abi: beaconLightClientAbi, functionName: "update", args: [message.proof, message.publicValues] });
};
const sendsTo = (w: ReturnType<typeof world>, target: string) => w.chain.log.filter((entry) => entry.kind === "send" && entry.request.to === target);

describe("the memory of proof payloads", () => {
  it("forgets a payload after five minutes, and looks at a republished one again", async () => {
    const w = world();
    const payload = "0x0102" as Hex;
    expect(await w.runner.handleProofPayload(payload)).toMatchObject({ handled: "refused", reason: "undecodable" });
    // At the exact limit the payload is still remembered.
    w.advance(PAYLOAD_MEMORY_MILLISECONDS);
    expect(await w.runner.handleProofPayload(payload)).toEqual({ handled: "duplicate" });
    w.advance(1);
    expect(await w.runner.handleProofPayload(payload)).toMatchObject({ handled: "refused", reason: "undecodable" });
  });
});

describe("two proofs that arrive together", () => {
  it("posts the higher one alone and tells the other that it was superseded, when the higher one came first", async () => {
    const w = world();
    const [higher, lower] = await Promise.all([
      w.runner.handleProofPayload(proofPayload({ startSlot: 100n, newSlot: 180n })),
      w.runner.handleProofPayload(proofPayload({ startSlot: 100n, newSlot: 164n })),
    ]);
    expect(higher).toEqual({ handled: "update-posted", transactionHash: word(0xee) });
    expect(lower).toEqual({ handled: "update-skipped", reason: "superseded", detail: "another update was posted or is waiting with a higher slot" });
    expect(w.chain.log.filter((entry) => entry.kind === "send").map((entry) => entry.request.data)).toEqual([updateCall(180n)]);
  });

  it("posts the higher one alone, when the lower one came first", async () => {
    const w = world();
    const [lower, higher] = await Promise.all([
      w.runner.handleProofPayload(proofPayload({ startSlot: 100n, newSlot: 164n })),
      w.runner.handleProofPayload(proofPayload({ startSlot: 100n, newSlot: 180n })),
    ]);
    expect(lower).toMatchObject({ handled: "update-skipped", reason: "superseded" });
    expect(higher).toEqual({ handled: "update-posted", transactionHash: word(0xee) });
    expect(w.chain.log.filter((entry) => entry.kind === "send").map((entry) => entry.request.data)).toEqual([updateCall(180n)]);
  });

  it("keeps a proof that arrives while a batch carries an older one, and posts it alone after the batch", async () => {
    const w = world({ ids: [1] });
    let released: Promise<unknown> | null = null;
    const send = w.chain.send.bind(w.chain);
    w.chain.send = async (request) => {
      // The first send is the batch. A higher proof arrives while it is in flight.
      if (released === null) {
        released = w.runner.handleProofPayload(proofPayload({ startSlot: 100n, newSlot: 200n }));
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return send(request);
    };
    const first = await w.runner.handleProofPayload(proofPayload({ startSlot: 100n, newSlot: 164n }));
    const second = await released;
    expect(first).toEqual({ handled: "update-posted", transactionHash: word(0xee) });
    expect(second).toEqual({ handled: "update-posted", transactionHash: word(0xee) });
    expect(sendsTo(w, LIGHT_CLIENT).map((entry) => entry.request.data)).toEqual([updateCall(200n)]);
    expect(w.outcomes.records.filter((record) => record.kind === "update").map((record) => [record.status, record.newSlot])).toEqual([
      ["posted", 164n],
      ["posted", 200n],
    ]);
  });
});

describe("the sweep", () => {
  it("reads the next page of the feed while a cursor is given, and delivers the oldest item first", async () => {
    const newest = feedItem({ id: 2, token: WRAPPED_NATIVE });
    const oldest = feedItem({ id: 1, token: WRAPPED_NATIVE });
    const w = world({ items: [newest, oldest] });
    const cursors: Array<string | undefined> = [];
    w.indexer.listFeed = async (query) => {
      cursors.push(query.cursor);
      return query.cursor === undefined ? { items: [newest], nextCursor: "page-2" } : { items: [oldest], nextCursor: null };
    };
    expect(await w.runner.sweep()).toEqual({ listed: 2, delivered: 2, skipped: 0, failed: 0 });
    expect(cursors).toEqual([undefined, "page-2"]);
    expect(w.outcomes.records.map((record) => record.messageId)).toEqual([word(1), word(2)]);
  });

  it("reads at most five pages of the feed, also when the indexer always names a next page", async () => {
    const w = world();
    let reads = 0;
    w.indexer.listFeed = async () => ({ items: [], nextCursor: `page-${(reads += 1) + 1}` });
    expect(await w.runner.sweep()).toEqual({ listed: 0, delivered: 0, skipped: 0, failed: 0 });
    expect(reads).toBe(5);
  });

  it("counts an item as failed when its preparation throws before any layout spend, and waits five minutes before the next try", async () => {
    const w = world({ ids: [1] });
    let reads = 0;
    w.indexer.getMessage = async () => {
      reads += 1;
      throw new Error("the indexer is down");
    };
    expect(await w.runner.sweep()).toEqual({ listed: 1, delivered: 0, skipped: 0, failed: 1 });
    expect(w.events().find((event) => event.event === "delivery_error")).toMatchObject({ messageId: word(1) });
    // No wei were spent, so no loss is recorded.
    expect(w.state.current.prerequisiteLosses).toEqual([]);
    expect(await w.runner.sweep()).toMatchObject({ listed: 1, failed: 0 });
    expect(reads).toBe(1);
    w.advance(RETRY_AFTER_MILLISECONDS + 1);
    expect(await w.runner.sweep()).toMatchObject({ failed: 1 });
    expect(reads).toBe(2);
  });

  it("offers the update to the first batch only when that batch declines it as unpaid, and the next batch goes without it", async () => {
    const w = world({ ids: [1, 2], maximumBatchSize: 1 });
    // Each item pays 100,000 wei above its cost. The update costs 3,000,000 wei, so a batch of one item cannot carry it.
    w.chain.feeTokens = COST + 100_000n;
    const handling = await w.runner.handleProofPayload(proofPayload({ startSlot: 100n, newSlot: 164n }));
    // Item 2 is the oldest and goes first: its batch declines the update. Item 1 then goes without an offer of the update.
    expect(w.outcomes.records.filter((record) => record.kind === "delivery").map((record) => [record.messageId, record.status, record.reason])).toEqual([
      [word(2), "skipped", "fee-below-cost-plus-margin"],
      [word(1), "delivered", undefined],
    ]);
    // The read of the proof check and one read for the offer of the first batch: the second batch asks for none.
    expect(w.lightClient.reads).toBe(2);
    expect(sendsTo(w, LIGHT_CLIENT).map((entry) => entry.request.data)).toEqual([updateCall(164n)]);
    expect(handling).toEqual({ handled: "update-posted", transactionHash: word(0xee) });
  });
});
