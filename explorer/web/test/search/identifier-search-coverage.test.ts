import { describe, expect, it, vi } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import type { IndexerClient } from "../../src/data/indexer-client";
import { createFixtureIndexerClient } from "../../src/data/fixture-indexer-client";
import { searchIdentifiers } from "../../src/search/identifier-search";
import { classifyQuery } from "../../src/search/search-model";
import { buildFixtureFeed, FIXTURE_NOW } from "@terminal/data/fixtures";

const feed = buildFixtureFeed(FIXTURE_NOW);
const delivered = feed.find((item) => item.kind === "token" && item.status === "delivered" && item.direction === "first-to-second")!;
const message = feed.find((item) => item.kind === "message")!;
const indexer = createFixtureIndexerClient();
const run = (query: string, client: IndexerClient = indexer) => searchIdentifiers(classifyQuery(query), { indexer: client, pair: FIXTURE_PAIR });

describe("searchIdentifiers", () => {
  it("gives an address result with no read of the indexer", async () => {
    const client: IndexerClient = { message: vi.fn(), findMessageByTransaction: vi.fn(), transactionCost: vi.fn() };
    const outcome = await run("0x52908400098527886E0F7030069857D2E4169EE7", client);
    expect(outcome.results.map((result) => [result.kind, result.title])).toEqual([["address", "0x52908400098527886E0F7030069857D2E4169EE7"]]);
    expect(outcome.problem).toBeNull();
    expect(client.message).not.toHaveBeenCalled();
    expect(client.findMessageByTransaction).not.toHaveBeenCalled();
  });

  it("gives nothing and no problem for words and for an empty query", async () => {
    expect(await run("usdc")).toEqual({ results: [], problem: null });
    expect(await run("   ")).toEqual({ results: [], problem: null });
  });

  it("finds a transfer by message identifier and says it was found by identifier", async () => {
    const outcome = await run(delivered.id);
    expect(outcome.problem).toBeNull();
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]).toMatchObject({ kind: "transfer", jump: { type: "route", route: { name: "message", messageId: delivered.id } } });
    expect(outcome.results[0]!.subtitle).toBe(`Transfer · delivered · ${FIXTURE_PAIR.first.name} to ${FIXTURE_PAIR.second.name} · found by identifier`);
  });

  it("calls a message that carries no tokens a message", async () => {
    const outcome = await run(message.id);
    expect(outcome.results[0]!.subtitle.startsWith(`Message · ${message.status} · `)).toBe(true);
  });

  it("replaces the underscores of the status with spaces", async () => {
    const failed = feed.find((item) => item.kind === "token" && item.status === "release_failed")!;
    expect((await run(failed.id)).results[0]!.subtitle.startsWith("Transfer · release failed · ")).toBe(true);
  });

  it("finds a transfer by transaction hash after the identifier lookup found nothing", async () => {
    const outcome = await run(delivered.destinationTransactionHash!);
    expect(outcome.results[0]).toMatchObject({ kind: "transfer", id: `transfer:${delivered.id}` });
    expect(outcome.results[0]!.subtitle).toMatch(/ · found by transaction$/);
  });

  it("says the indexer knows nothing when neither lookup finds a message", async () => {
    expect(await run(`0x${"ee".repeat(32)}`)).toEqual({ results: [], problem: "The indexer knows no message with this identifier or transaction hash." });
  });

  it("says so when the transaction lookup names a message that the indexer cannot give", async () => {
    const client: IndexerClient = { message: async () => null, findMessageByTransaction: async () => delivered.id, transactionCost: async () => null };
    expect((await run(delivered.sourceTransactionHash, client)).problem).toBe("The indexer knows no message with this identifier or transaction hash.");
  });

  it("reports a failure with the message of an Error, and with text for any other thrown value", async () => {
    const failing = (thrown: unknown): IndexerClient => ({ message: async () => { throw thrown; }, findMessageByTransaction: async () => null, transactionCost: async () => null });
    expect(await run(delivered.id, failing(new Error("boom")))).toEqual({ results: [], problem: "The indexer lookup failed: boom" });
    expect(await run(delivered.id, failing("plain text"))).toEqual({ results: [], problem: "The indexer lookup failed: plain text" });
  });
});
