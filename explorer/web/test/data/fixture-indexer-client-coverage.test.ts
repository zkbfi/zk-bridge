import { describe, expect, it } from "vitest";
import { buildFixtureFeed, FIXTURE_NOW, FIXTURE_PAIR } from "@terminal/data/fixtures";
import type { FeedItem } from "@terminal/model/types";
import { createFixtureIndexerClient } from "../../src/data/fixture-indexer-client";

const feed = buildFixtureFeed(FIXTURE_NOW);
const itemWith = (predicate: (item: FeedItem) => boolean): FeedItem => feed.find(predicate)!;
const client = createFixtureIndexerClient();

describe("the fixture indexer client", () => {
  it("gives null for an unknown message and finds a known one in any letter case", async () => {
    expect(await client.message(`0x${"ee".repeat(32)}`)).toBeNull();
    const item = feed[3]!;
    expect((await client.message(item.id.toUpperCase().replace("0X", "0x") as typeof item.id))?.id).toBe(item.id);
  });

  it("maps a first to second token row to the pair's chains and tokens", async () => {
    const item = itemWith((candidate) => candidate.direction === "first-to-second" && candidate.kind === "token" && candidate.status === "delivered");
    const detail = (await client.message(item.id))!;
    expect(detail).toMatchObject({
      sourceChainId: FIXTURE_PAIR.first.chainId,
      destinationChainId: FIXTURE_PAIR.second.chainId,
      deliverySucceeded: true,
      executedBy: item.recipient,
      releaseFailed: false,
      coveredByHeadSlot: 14_100_000,
      coveredAt: item.sentAt + 700,
      deliveredAt: item.deliveredAt,
      destinationTransactionHash: item.destinationTransactionHash,
    });
    expect(detail.transfer).toMatchObject({
      sourceToken: { symbol: item.token!.symbol, address: item.token!.address, chainId: FIXTURE_PAIR.first.chainId },
      destinationToken: { address: item.token!.counterpart, chainId: FIXTURE_PAIR.second.chainId },
      value: item.amount,
      deliveredValue: item.amount,
      recipient: item.recipient,
    });
  });

  it("swaps the chains for a second to first row", async () => {
    const item = itemWith((candidate) => candidate.direction === "second-to-first");
    const detail = (await client.message(item.id))!;
    expect(detail.sourceChainId).toBe(FIXTURE_PAIR.second.chainId);
    expect(detail.destinationChainId).toBe(FIXTURE_PAIR.first.chainId);
  });

  it("describes a sent row as not yet covered, not delivered, and has no delivery result", async () => {
    const detail = (await client.message(itemWith((candidate) => candidate.status === "sent").id))!;
    expect(detail).toMatchObject({ coveredByHeadSlot: null, coveredAt: null, deliveredAt: null, deliverySucceeded: null, executedBy: null });
    if (detail.transfer !== null) expect(detail.transfer.deliveredValue).toBeNull();
  });

  it("treats a waiting for finality row as not yet covered", async () => {
    const detail = (await client.message(itemWith((candidate) => candidate.status === "waiting_for_finality").id))!;
    expect(detail.coveredByHeadSlot).toBeNull();
  });

  it("marks a failed call as delivered with a failed result, and a failed release row", async () => {
    expect((await client.message(itemWith((candidate) => candidate.status === "failed_call").id))!.deliverySucceeded).toBe(false);
    expect((await client.message(itemWith((candidate) => candidate.status === "release_failed").id))!.releaseFailed).toBe(true);
  });

  it("gives no transfer for a plain message", async () => {
    const detail = (await client.message(itemWith((candidate) => candidate.kind === "message").id))!;
    expect(detail.transfer).toBeNull();
  });

  it("finds a message by source or destination hash in any letter case, and gives null otherwise", async () => {
    const item = itemWith((candidate) => candidate.destinationTransactionHash !== null);
    expect(await client.findMessageByTransaction(item.sourceTransactionHash)).toBe(item.id);
    expect(await client.findMessageByTransaction(item.destinationTransactionHash!.toUpperCase().replace("0X", "0x") as typeof item.id)).toBe(item.id);
    expect(await client.findMessageByTransaction(`0x${"ee".repeat(32)}`)).toBeNull();
  });

  it("describes another pair when one is given", async () => {
    const other = { ...FIXTURE_PAIR, first: { ...FIXTURE_PAIR.first, chainId: 777 } };
    const item = itemWith((candidate) => candidate.direction === "first-to-second");
    expect((await createFixtureIndexerClient({ pair: other }).message(item.id))!.sourceChainId).toBe(777);
  });
});

describe("the fixture's sample costs", () => {
  it("price the send and the delivery at the sample coins, and a covered message's proof as shared by three", async () => {
    const item = itemWith((candidate) => candidate.direction === "first-to-second" && candidate.kind === "token" && candidate.status === "delivered");
    const costs = (await client.message(item.id))!.costs!;
    // 120,000 gas × 7 gwei = 0.00084 ETH at $3,000.
    expect(costs.sent).toMatchObject({ chainId: 1, hash: item.sourceTransactionHash, costWei: "840000000000000", costUsd: "2520000000000000000", nativeUsd: { source: "pulsex-weth-copy", priceBlock: "0" } });
    expect(costs.delivered).toMatchObject({ chainId: 369, hash: item.destinationTransactionHash, nativeUsd: { source: "pulsex-pls-usd" } });
    expect(costs.proof?.coveredMessages).toBe(3);
  });

  it("have no delivery or proof before they happen", async () => {
    const item = itemWith((candidate) => candidate.status === "sent");
    expect((await client.message(item.id))!.costs).toMatchObject({ delivered: null, proof: null });
  });

  it("have no dollars on a chain without a sample price", async () => {
    const other = { ...FIXTURE_PAIR, first: { ...FIXTURE_PAIR.first, chainId: 11155111 } };
    const item = itemWith((candidate) => candidate.direction === "first-to-second" && candidate.status === "delivered");
    expect((await createFixtureIndexerClient({ pair: other }).message(item.id))!.costs!.sent).toMatchObject({ chainId: 11155111, costUsd: null, nativeUsd: null });
  });

  it("serve a send's or a delivery's cost by chain and hash, and nothing for other transactions", async () => {
    const item = itemWith((candidate) => candidate.direction === "first-to-second" && candidate.status === "delivered");
    expect((await client.transactionCost(1, item.sourceTransactionHash))?.hash).toBe(item.sourceTransactionHash);
    expect((await client.transactionCost(369, item.destinationTransactionHash!))?.hash).toBe(item.destinationTransactionHash);
    expect(await client.transactionCost(369, item.sourceTransactionHash)).toBeNull();
    expect(await client.transactionCost(1, `0x${"ee".repeat(32)}`)).toBeNull();
    const undelivered = itemWith((candidate) => candidate.status === "sent");
    expect((await client.transactionCost(undelivered.direction === "first-to-second" ? 1 : 369, undelivered.sourceTransactionHash))?.hash).toBe(undelivered.sourceTransactionHash);
  });
});
