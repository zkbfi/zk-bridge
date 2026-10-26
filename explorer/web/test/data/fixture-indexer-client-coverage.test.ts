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
      fallbackUsed: false,
      claimableOutstanding: false,
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

  it("marks a failed call as delivered with a failed result, a fallback row, and a claimable row", async () => {
    expect((await client.message(itemWith((candidate) => candidate.status === "failed_call").id))!.deliverySucceeded).toBe(false);
    expect((await client.message(itemWith((candidate) => candidate.status === "fallback_used").id))!.fallbackUsed).toBe(true);
    expect((await client.message(itemWith((candidate) => candidate.status === "claimable").id))!.claimableOutstanding).toBe(true);
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
