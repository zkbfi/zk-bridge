import { describe, expect, it } from "vitest";
import type { ChainReader, HistoryEvent, HistoryFilters, JsonFetcher } from "@zk-bridge/shared";
import {
  dateOfSeconds,
  defaultHistoryDependencies,
  EMPTY_HISTORY_FILTERS,
  filtersTheChainsCannotApply,
  formatHistoryQuery,
  historyFiltersFromQuery,
  leavesOutHeadUpdates,
  pageOfScannedEvents,
  readHistory,
  secondsOfDate,
  type HistoryConnection,
  type HistoryDependencies,
} from "../../src/views/history-model";
import { sharedPairForTests } from "../support/live";

const pair = sharedPairForTests();
const hash = (byte: string): `0x${string}` => `0x${byte.repeat(32)}`;
const event = (overrides: Partial<HistoryEvent>): HistoryEvent => ({
  kind: "sent",
  chainId: 1,
  timestamp: 100n,
  transactionHash: hash("a1"),
  messageId: hash("01"),
  slot: null,
  status: null,
  ...overrides,
});
const withFilters = (overrides: Partial<HistoryFilters>): HistoryFilters => ({ ...EMPTY_HISTORY_FILTERS, ...overrides });

describe("the query text of the filters", () => {
  it("writes nothing for no filter and reads the same filters back for every filter", () => {
    expect(formatHistoryQuery(EMPTY_HISTORY_FILTERS)).toBe("");
    const filters = withFilters({
      chain: 1,
      eventKind: "delivered",
      direction: { sourceChainId: 369, destinationChainId: 1 },
      kind: "message",
      statuses: ["failed_call"],
      token: `0x${"11".repeat(20)}`,
      address: `0x${"22".repeat(20)}`,
      from: 1n,
      to: 2n,
      limit: 10,
      cursor: { timestamp: 3n, kind: "head-update", key: "369-40" },
    });
    expect(historyFiltersFromQuery(formatHistoryQuery(filters))).toEqual(filters);
  });

  it("opens with no filter when the query is one the indexer would refuse", () => {
    expect(historyFiltersFromQuery("limit=0")).toEqual(EMPTY_HISTORY_FILTERS);
  });
});

describe("the head updates and the filters", () => {
  it.each([{ kind: "token" as const }, { statuses: ["sent" as const] }, { token: `0x${"11".repeat(20)}` as const }, { address: `0x${"22".repeat(20)}` as const }])(
    "knows that %j leaves head updates out, as the indexer does",
    (overrides) => {
      expect(leavesOutHeadUpdates(withFilters(overrides))).toBe(true);
    },
  );

  it("keeps head updates for the direction, chain, event and time filters", () => {
    const filters = withFilters({ chain: 1, eventKind: "sent", direction: { sourceChainId: 1, destinationChainId: 369 }, from: 1n, to: 2n });
    expect(leavesOutHeadUpdates(filters)).toBe(false);
    expect(filtersTheChainsCannotApply(filters)).toEqual([]);
  });

  it("names each filter that the chains cannot apply", () => {
    const filters = withFilters({ kind: "token", statuses: ["sent"], token: `0x${"11".repeat(20)}`, address: `0x${"22".repeat(20)}` });
    expect(filtersTheChainsCannotApply(filters)).toEqual(["message kind", "status", "token", "address"]);
  });
});

describe("a page cut from the events of the chains", () => {
  const sendOnFirst = event({ kind: "sent", chainId: 1, timestamp: 500n, messageId: hash("05") });
  const deliveryOnSecond = event({ kind: "delivered", chainId: 369, timestamp: 400n, messageId: hash("04") });
  const sendOnSecond = event({ kind: "sent", chainId: 369, timestamp: 300n, messageId: hash("03") });
  const deliveryOnFirst = event({ kind: "delivered", chainId: 1, timestamp: 200n, messageId: hash("02") });
  const head = event({ kind: "head-update", chainId: 369, timestamp: 100n, messageId: null, slot: 80n });
  const all = [sendOnFirst, deliveryOnSecond, sendOnSecond, deliveryOnFirst, head];

  it("marks the page partial and keeps every event for no filter", () => {
    expect(pageOfScannedEvents(pair, all, EMPTY_HISTORY_FILTERS)).toEqual({ items: all, nextCursor: null, partial: true });
  });

  it("keeps a direction by where a send leaves, where a delivery arrives and where the light client sits", () => {
    const forward = pageOfScannedEvents(pair, all, withFilters({ direction: { sourceChainId: 1, destinationChainId: 369 } }));
    expect(forward.items).toEqual([sendOnFirst, deliveryOnSecond, head]);
    const backward = pageOfScannedEvents(pair, all, withFilters({ direction: { sourceChainId: 369, destinationChainId: 1 } }));
    expect(backward.items).toEqual([sendOnSecond, deliveryOnFirst]);
  });

  it("filters by chain, event kind and time", () => {
    expect(pageOfScannedEvents(pair, all, withFilters({ chain: 1 })).items).toEqual([sendOnFirst, deliveryOnFirst]);
    expect(pageOfScannedEvents(pair, all, withFilters({ eventKind: "sent" })).items).toEqual([sendOnFirst, sendOnSecond]);
    expect(pageOfScannedEvents(pair, all, withFilters({ from: 200n, to: 400n })).items).toEqual([deliveryOnSecond, sendOnSecond, deliveryOnFirst]);
  });

  it("pages by the limit and continues exactly after the cursor", () => {
    const first = pageOfScannedEvents(pair, all, withFilters({ limit: 2 }));
    expect(first.items).toEqual([sendOnFirst, deliveryOnSecond]);
    expect(first.nextCursor).toBe(`400:delivered:${hash("04")}`);
    const cursor = { timestamp: 400n, kind: "delivered" as const, key: hash("04") };
    const second = pageOfScannedEvents(pair, all, withFilters({ limit: 2, cursor }));
    expect(second.items).toEqual([sendOnSecond, deliveryOnFirst]);
    const third = pageOfScannedEvents(pair, all, withFilters({ limit: 2, cursor: { timestamp: 200n, kind: "delivered", key: hash("02") } }));
    expect(third).toEqual({ items: [head], nextCursor: null, partial: true });
  });

  it("continues after a head update cursor by chain and slot, as numbers", () => {
    const heads = [
      event({ kind: "head-update", chainId: 369, timestamp: 50n, messageId: null, slot: 100n }),
      event({ kind: "head-update", chainId: 369, timestamp: 50n, messageId: null, slot: 9n }),
    ];
    const page = pageOfScannedEvents(pair, heads, withFilters({ cursor: { timestamp: 50n, kind: "head-update", key: "369-100" } }));
    expect(page.items).toEqual([heads[1]]);
  });

  it("gives an empty page and no cursor when nothing is left", () => {
    expect(pageOfScannedEvents(pair, [], EMPTY_HISTORY_FILTERS)).toEqual({ items: [], nextCursor: null, partial: true });
  });
});

describe("the dates of the time filter", () => {
  it("reads the first and the last second of a day in UTC", () => {
    expect(secondsOfDate("2026-10-28", "start")).toBe(1_793_145_600n);
    expect(secondsOfDate("2026-10-28", "end")).toBe(1_793_231_999n);
  });

  it("gives null for an empty text or a day that does not exist", () => {
    expect(secondsOfDate("", "start")).toBeNull();
    expect(secondsOfDate("2026-13-45", "start")).toBeNull();
  });

  it("writes a time back as its date, and nothing for no time", () => {
    expect(dateOfSeconds(1_793_145_600n)).toBe("2026-10-28");
    expect(dateOfSeconds(null)).toBe("");
  });
});

describe("readHistory", () => {
  const connectionWith = (rpcUrls: HistoryConnection["resolved"]["rpcUrls"]): HistoryConnection => ({
    baseUrl: "https://indexer.example.org",
    resolved: { indexerUrl: null, backendUrl: null, msgboardIndexerUrl: null, archiveUrl: null, msgboardUrl: null, rpcUrls },
    run: async (operations) => operations.viaIndexer(),
  });
  const rpcConnection = (rpcUrls: HistoryConnection["resolved"]["rpcUrls"]): HistoryConnection => ({ ...connectionWith(rpcUrls), run: async (operations) => operations.viaRpc() });
  const dependencies = (fetchJson: JsonFetcher, overrides: Partial<HistoryDependencies> = {}): HistoryDependencies => ({
    fetchJson,
    createReader: () => ({}) as ChainReader,
    loadPair: async () => pair,
    ...overrides,
  });

  it("reads the indexer page, with the filters in the query", async () => {
    const urls: string[] = [];
    const fetchJson: JsonFetcher = async (url) => {
      urls.push(url);
      return { status: 200, body: { items: [], nextCursor: null, partial: false } };
    };
    const reading = await readHistory({ connection: connectionWith({}), filters: withFilters({ chain: 369 }), dependencies: dependencies(fetchJson) });
    expect(urls).toEqual(["https://indexer.example.org/api/history?chain=369"]);
    expect(reading).toEqual({ page: { items: [], nextCursor: null, partial: false }, source: "indexer", unappliedFilters: [] });
  });

  it("refuses an answer that is not 200 and an answer that is not a page", async () => {
    const refused = readHistory({ connection: connectionWith({}), filters: EMPTY_HISTORY_FILTERS, dependencies: dependencies(async () => ({ status: 500, body: null })) });
    await expect(refused).rejects.toThrow("The indexer answered 500 for /api/history.");
    const strange = readHistory({ connection: connectionWith({}), filters: EMPTY_HISTORY_FILTERS, dependencies: dependencies(async () => ({ status: 200, body: { items: "no" } })) });
    await expect(strange).rejects.toThrow("not a page of the history");
  });

  it("fails when the page has no deployment file or a chain has no endpoint", async () => {
    const urls = { 1: { value: "https://one.example.org", source: "user" as const }, 369: { value: "https://two.example.org", source: "user" as const } };
    const noPair = readHistory({ connection: rpcConnection(urls), filters: EMPTY_HISTORY_FILTERS, dependencies: dependencies(async () => ({ status: 200, body: null }), { loadPair: async () => null }) });
    await expect(noPair).rejects.toThrow("no deployment file");
    const noUrl = readHistory({ connection: rpcConnection({ 1: urls[1], 369: null }), filters: EMPTY_HISTORY_FILTERS, dependencies: dependencies(async () => ({ status: 200, body: null })) });
    await expect(noUrl).rejects.toThrow("No endpoint is set for pulsechain.");
  });

  it("builds the dependencies of a live page from the platform", () => {
    const loadPair = async () => null;
    const live = defaultHistoryDependencies(loadPair);
    expect(live.loadPair).toBe(loadPair);
    expect(typeof live.fetchJson).toBe("function");
    expect(typeof live.createReader).toBe("function");
  });
});
