import { describe, expect, it, vi } from "vitest";
import { FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import type { IndexerClient } from "../../src/data/indexer-client";
import { createFixtureIndexerClient } from "../../src/data/fixture-indexer-client";
import { isCrossReferenced, paletteSources, searchCrossReferenced } from "../../src/search/identifier-search";
import { buildFixtureFeed, FIXTURE_NOW } from "@terminal/data/fixtures";

const feed = buildFixtureFeed(FIXTURE_NOW);
const delivered = feed.find((item) => item.kind === "token" && item.status === "delivered" && item.direction === "first-to-second")!;
const message = feed.find((item) => item.kind === "message")!;
const indexer = createFixtureIndexerClient();
const run = (query: string, client: IndexerClient = indexer) => searchCrossReferenced(query, { indexer: client, pair: FIXTURE_PAIR, tokens: FIXTURE_TOKENS });

const kinds = async (query: string, client?: IndexerClient) => (await run(query, client)).results.map((result) => result.kind);

describe("isCrossReferenced", () => {
  it("is true for a hash, an address, a number, a prefix, a CID and a name, and false for words and nothing", () => {
    for (const query of [delivered.id, "0x52908400098527886E0F7030069857D2E4169EE7", "123", "0xabcdef", `bafy${"a".repeat(30)}`, "vitalik.eth"]) expect(isCrossReferenced(query), query).toBe(true);
    for (const query of ["usdc", "wrapped ether", "  ", "what? no!"]) expect(isCrossReferenced(query), query).toBe(false);
  });
});

describe("searchCrossReferenced", () => {
  it("gives an address result and reads no message", async () => {
    const client: IndexerClient = { message: vi.fn(), findMessageByTransaction: vi.fn(), transactionCost: vi.fn() };
    const outcome = await run("0x52908400098527886E0F7030069857D2E4169EE7", client);
    expect(outcome.results.map((result) => [result.kind, result.title])).toEqual([["address", "0x52908400098527886e0f7030069857d2e4169ee7"]]);
    expect(outcome.problem).toBeNull();
    expect(client.message).not.toHaveBeenCalled();
    expect(client.findMessageByTransaction).not.toHaveBeenCalled();
  });

  it("names a bridged token by its address, with its links", async () => {
    const token = FIXTURE_TOKENS[0]!;
    const outcome = await run(token.address);
    expect(outcome.results[0]).toMatchObject({ kind: "token", title: token.symbol });
    expect(outcome.results[0]?.links?.map((link) => link.surface)).toEqual(expect.arrayContaining(["dapp", "indexer", "explorer"]));
  });

  it("finds a token by its symbol, and nothing for an empty query", async () => {
    const symbol = FIXTURE_TOKENS[0]!.symbol;
    const outcome = await run(symbol.toLowerCase());
    expect(outcome.problem).toBeNull();
    expect(outcome.results.every((result) => result.kind === "token")).toBe(true);
    expect(outcome.results.map((result) => result.title)).toContain(symbol);
    expect(await run("   ")).toEqual({ results: [], problem: null });
  });

  it("finds a transfer by message identifier, says so, and links it to every surface", async () => {
    const outcome = await run(delivered.id);
    expect(outcome.problem).toBeNull();
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]).toMatchObject({ kind: "transfer", id: `transfer:${delivered.id}`, jump: { type: "route", route: { name: "message", messageId: delivered.id } } });
    expect(outcome.results[0]!.subtitle.startsWith(`Transfer of `)).toBe(true);
    expect(outcome.results[0]!.subtitle.endsWith(`${FIXTURE_PAIR.first.name} to ${FIXTURE_PAIR.second.name} · found by identifier`)).toBe(true);
    expect(outcome.results[0]!.links!.map((link) => link.surface)).toEqual(["dapp", "indexer", "status", "backend"]);
  });

  it("calls a message that carries no tokens a message", async () => {
    const outcome = await run(message.id);
    expect(outcome.results[0]!.subtitle.startsWith(`Message · ${message.status} · `)).toBe(true);
  });

  it("replaces the underscores of the status with spaces", async () => {
    const failed = feed.find((item) => item.kind === "token" && item.status === "release_failed")!;
    expect((await run(failed.id)).results[0]!.subtitle).toContain(" · release failed · ");
  });

  it("finds a transfer by transaction hash after the identifier lookup found nothing, with the transaction itself", async () => {
    const outcome = await run(delivered.destinationTransactionHash!);
    expect(outcome.results.map((result) => result.id)).toEqual([`transfer:${delivered.id}`, expect.stringMatching(/^transaction:/)]);
    expect(outcome.results[0]!.subtitle).toMatch(/ · found by transaction$/);
    expect(outcome.problem).toBeNull();
  });

  it("offers an unknown hash as a transaction on each chain, and says the indexer knows no message", async () => {
    const outcome = await run(`0x${"ee".repeat(32)}`);
    expect(outcome.results.map((result) => [result.kind, result.jump])).toEqual([
      ["transaction", { type: "route", route: { name: "explore", page: { kind: "tx", chainId: FIXTURE_PAIR.first.chainId, id: `0x${"ee".repeat(32)}` } } }],
      ["transaction", { type: "route", route: { name: "explore", page: { kind: "tx", chainId: FIXTURE_PAIR.second.chainId, id: `0x${"ee".repeat(32)}` } } }],
    ]);
    expect(outcome.problem).toBe("The indexer knows no message with this identifier or transaction hash.");
  });

  it("says so when the transaction lookup names a message that the indexer cannot give", async () => {
    const client: IndexerClient = { message: async () => null, findMessageByTransaction: async () => delivered.id, transactionCost: async () => null };
    expect((await run(delivered.sourceTransactionHash, client)).problem).toBe("The indexer knows no message with this identifier or transaction hash.");
  });

  it("reports a failure with the message of an Error, and with text for any other thrown value, and still offers the transactions", async () => {
    const failing = (thrown: unknown): IndexerClient => ({ message: async () => { throw thrown; }, findMessageByTransaction: async () => null, transactionCost: async () => null });
    const error = await run(delivered.id, failing(new Error("boom")));
    expect(error.problem).toBe("The indexer lookup failed: unavailable");
    expect(error.results.map((result) => result.kind)).toEqual(["transaction", "transaction"]);
    expect((await run(delivered.id, failing("plain text"))).problem).toBe("The indexer lookup failed: unavailable");
  });

  it("offers a slot, blocks and proofs for a number, each with its links", async () => {
    expect(await kinds("11194368")).toEqual(["proof", "proof", "slot", "block", "block"]);
    const slot = (await run("11194368")).results.find((result) => result.kind === "slot")!;
    expect(slot.jump).toEqual({ type: "route", route: { name: "explore", page: { kind: "slot", id: "11194368" } } });
    expect(slot.links!.some((link) => link.surface === "status")).toBe(true);
  });

  it("offers a release for a CID", async () => {
    expect(await kinds(`bafy${"a".repeat(30)}`)).toEqual(["release"]);
  });

  it("says that names are not searched", async () => {
    expect(await run("vitalik.eth")).toEqual({ results: [], problem: "Names such as ENS names are not searched. Try an address, a hash or a number." });
  });
});

describe("paletteSources", () => {
  it("reads a message and a transaction from the indexer and the tokens that the page loaded", async () => {
    const sources = paletteSources({ indexer, pair: FIXTURE_PAIR, tokens: FIXTURE_TOKENS });
    expect((await sources.indexer!.message(delivered.id))?.messageId).toBe(delivered.id);
    expect(await sources.indexer!.message(`0x${"ee".repeat(32)}`)).toBeNull();
    expect((await sources.indexer!.messageByTransaction(delivered.sourceTransactionHash))?.messageId).toBe(delivered.id);
    expect(await sources.indexer!.messageByTransaction(`0x${"ee".repeat(32)}`)).toBeNull();
    expect((await sources.indexer!.tokens!()).map((token) => token.symbol)).toEqual(FIXTURE_TOKENS.map((token) => token.symbol));
    expect(sources.chains.map((chain) => chain.chainId)).toEqual([FIXTURE_PAIR.first.chainId, FIXTURE_PAIR.second.chainId]);
  });
});
