import { describe, expect, it } from "vitest";
import { createFallbackController, type ChainReader, type HistoryEvent, type HistoryFilters, type HistoryScan, type JsonFetcher } from "@zk-bridge/shared";
import {
  dateOfSeconds,
  defaultHistoryDependencies,
  EMPTY_HISTORY_FILTERS,
  formatHistoryQuery,
  historyFiltersFromQuery,
  pageOfScannedEvents,
  readHistory,
  shareScans,
  unkeptScan,
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

  it("leaves head updates out under a message filter, as the indexer does, and keeps them otherwise", () => {
    expect(pageOfScannedEvents(pair, all, withFilters({ statuses: ["delivered"] })).items).toEqual([sendOnFirst, deliveryOnSecond, sendOnSecond, deliveryOnFirst]);
    for (const overrides of [{ kind: "token" as const }, { token: `0x${"11".repeat(20)}` as const }, { address: `0x${"22".repeat(20)}` as const }]) {
      expect(pageOfScannedEvents(pair, all, withFilters(overrides)).items).not.toContain(head);
    }
    expect(pageOfScannedEvents(pair, all, withFilters({ chain: 369 })).items).toContain(head);
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
    scanOf: unkeptScan,
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
    expect(reading).toEqual({ page: { items: [], nextCursor: null, partial: false }, source: "indexer", unappliedFilters: [], readBack: [] });
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

  it("stops before the request and after it when the signal aborts", async () => {
    const early = new AbortController();
    early.abort(new Error("page left"));
    const fetchJson: JsonFetcher = async () => ({ status: 200, body: { items: [], nextCursor: null, partial: false } });
    await expect(readHistory({ connection: connectionWith({}), filters: EMPTY_HISTORY_FILTERS, dependencies: dependencies(fetchJson), signal: early.signal })).rejects.toThrow("page left");
    const late = new AbortController();
    const abortsDuring: JsonFetcher = async () => {
      late.abort(new Error("filters changed"));
      return { status: 200, body: { items: [], nextCursor: null, partial: false } };
    };
    await expect(readHistory({ connection: connectionWith({}), filters: EMPTY_HISTORY_FILTERS, dependencies: dependencies(abortsDuring), signal: late.signal })).rejects.toThrow("filters changed");
  });

  const endpoints = { 1: { value: "https://one.example.org", source: "user" as const }, 369: { value: "https://two.example.org", source: "user" as const } };

  it("asks for the scan under a key that holds the pair, the endpoints and the block limit, and no filter", async () => {
    const keys: string[] = [];
    const scan = { items: [], partial: true as const, coverage: [{ chainId: 1, scannedFromBlock: 500n, reachedStart: false }, { chainId: 369, scannedFromBlock: 100n, reachedStart: true }] };
    const scanOf: HistoryDependencies["scanOf"] = async (request) => {
      keys.push(request.key);
      return scan;
    };
    const read = (filters: HistoryFilters, maximumBlocks?: bigint) =>
      readHistory({ connection: rpcConnection(endpoints), filters, dependencies: dependencies(async () => ({ status: 200, body: null }), { scanOf }), ...(maximumBlocks === undefined ? {} : { maximumBlocks }) });
    const first = await read(EMPTY_HISTORY_FILTERS);
    await read(withFilters({ chain: 1, limit: 5, cursor: { timestamp: 1n, kind: "sent", key: hash("01") } }));
    await read(EMPTY_HISTORY_FILTERS, 7n);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys[0]).toContain("https://one.example.org");
    expect(first.readBack).toEqual([{ chainId: 1, block: 500n }]);
  });

  it("gives the scan the readers of the endpoints and the signal that it was given", async () => {
    const controller = new AbortController();
    const made: string[] = [];
    const reader = {
      getChainId: async () => 1,
      getBlock: async () => {
        throw new Error("stop here");
      },
    } as unknown as ChainReader;
    const reading = readHistory({
      connection: rpcConnection(endpoints),
      filters: EMPTY_HISTORY_FILTERS,
      signal: controller.signal,
      dependencies: dependencies(async () => ({ status: 200, body: null }), {
        createReader: (input) => {
          made.push(`${input.chainId} ${input.url}`);
          return reader;
        },
      }),
    });
    await expect(reading).rejects.toThrow("stop here");
    expect(made).toEqual(["1 https://one.example.org", "369 https://two.example.org"]);
  });

  it("scans without a signal when the caller gives none", async () => {
    const reader = {
      getChainId: async () => 1,
      getBlock: async () => {
        throw new Error("stop here");
      },
    } as unknown as ChainReader;
    const reading = readHistory({
      connection: rpcConnection(endpoints),
      filters: EMPTY_HISTORY_FILTERS,
      dependencies: dependencies(async () => ({ status: 200, body: null }), { createReader: () => reader }),
    });
    await expect(reading).rejects.toThrow("stop here");
  });

  it("builds the dependencies of a live page from the platform", () => {
    const loadPair = async () => null;
    const live = defaultHistoryDependencies(loadPair);
    expect(live.loadPair).toBe(loadPair);
    expect(typeof live.fetchJson).toBe("function");
    expect(typeof live.createReader).toBe("function");
    expect(live.scanOf).toBe(unkeptScan);
  });
});

describe("an abort during the indexer read", () => {
  const urls = { 1: { value: "https://one.example.org", source: "user" as const }, 369: { value: "https://two.example.org", source: "user" as const } };

  it("gives the signal to the fetch, leaves the connection status alone and starts no scan of the chains", async () => {
    const controller = createFallbackController({ indexerConfigured: true, probe: async () => ({ ok: true }) });
    const connection: HistoryConnection = {
      baseUrl: "https://indexer.example.org",
      resolved: { indexerUrl: null, backendUrl: null, msgboardIndexerUrl: null, archiveUrl: null, msgboardUrl: null, rpcUrls: urls },
      run: (operations) => controller.run(operations),
    };
    const leaving = new AbortController();
    const seenSignals: (AbortSignal | undefined)[] = [];
    const fetchJson: JsonFetcher = async (_url, signal) => {
      seenSignals.push(signal);
      leaving.abort(new Error("page left"));
      return signal?.aborted === true ? Promise.reject(signal.reason) : { status: 200, body: null };
    };
    let scans = 0;
    const scanOf: HistoryDependencies["scanOf"] = async () => {
      scans += 1;
      throw new Error("must not scan");
    };
    const read = readHistory({
      connection,
      filters: EMPTY_HISTORY_FILTERS,
      signal: leaving.signal,
      dependencies: { fetchJson, createReader: () => ({}) as ChainReader, loadPair: async () => pair, scanOf },
    });
    await expect(read).rejects.toThrow("page left");
    expect(seenSignals).toEqual([leaving.signal]);
    expect(controller.status().kind).toBe("indexer");
    expect(scans).toBe(0);
  });
});

describe("shareScans", () => {
  const scan: HistoryScan = { items: [], partial: true, coverage: [] };

  /** A keeper that runs `load` once per key and keeps the promise, as a cache of running reads does. */
  const keeper = () => {
    const kept = new Map<string, Promise<HistoryScan>>();
    let loads = 0;
    return {
      loads: () => loads,
      keep: (key: string, load: () => Promise<HistoryScan>) => {
        const known = kept.get(key);
        if (known !== undefined) return known;
        loads += 1;
        const started = load();
        kept.set(key, started);
        return started;
      },
    };
  };

  /** A scan that waits for the test and stops when its own signal aborts. */
  const gatedLoad = () => {
    const seen: { signal: AbortSignal | undefined } = { signal: undefined };
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const load = (signal: AbortSignal | undefined): Promise<HistoryScan> => {
      seen.signal = signal;
      return new Promise((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        void gate.then(() => resolve(scan));
      });
    };
    return { load, seen, open: () => open() };
  };

  it("lets a new read join a running scan after the first read left, and gives it the result", async () => {
    const { keep, loads } = keeper();
    const scanOf = shareScans(keep);
    const { load, seen, open } = gatedLoad();
    const first = new AbortController();
    const firstRead = scanOf({ key: "k", load, signal: first.signal });
    const firstOutcome = expect(firstRead).rejects.toThrow("filters changed");
    const second = new AbortController();
    const secondRead = scanOf({ key: "k", load, signal: second.signal });
    first.abort(new Error("filters changed"));
    await firstOutcome;
    expect(seen.signal?.aborted).toBe(false);
    open();
    await expect(secondRead).resolves.toBe(scan);
    expect(loads()).toBe(1);
  });

  it("aborts the scan when the last read that wants it leaves", async () => {
    const { keep } = keeper();
    const scanOf = shareScans(keep);
    const { load, seen } = gatedLoad();
    const only = new AbortController();
    const read = scanOf({ key: "k", load, signal: only.signal });
    const outcome = expect(read).rejects.toThrow("page left");
    only.abort(new Error("page left"));
    await outcome;
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(seen.signal?.aborted).toBe(true);
    expect(seen.signal?.reason).toEqual(new Error("page left"));
  });

  it("keeps the scan when a new read joins within the grace time after the last one left", async () => {
    const { keep } = keeper();
    const scanOf = shareScans(keep);
    const { load, seen, open } = gatedLoad();
    const first = new AbortController();
    const outcome = expect(scanOf({ key: "k", load, signal: first.signal })).rejects.toThrow("filters changed");
    first.abort(new Error("filters changed"));
    await outcome;
    const joining = scanOf({ key: "k", load, signal: undefined });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(seen.signal?.aborted).toBe(false);
    open();
    await expect(joining).resolves.toBe(scan);
  });

  it("rejects at once for a read whose signal has already aborted", async () => {
    const { keep } = keeper();
    const scanOf = shareScans(keep);
    const { load } = gatedLoad();
    const gone = new AbortController();
    gone.abort(new Error("already gone"));
    await expect(scanOf({ key: "k", load, signal: gone.signal })).rejects.toThrow("already gone");
  });

  it("passes the failure of the scan to the read that waits, and the next read starts a new scan", async () => {
    const scanOf = shareScans((_key, load) => load());
    const broken = (): Promise<HistoryScan> => Promise.reject(new Error("node down"));
    await expect(scanOf({ key: "k", load: broken, signal: undefined })).rejects.toThrow("node down");
    const { load, open } = gatedLoad();
    open();
    await expect(scanOf({ key: "k", load, signal: undefined })).resolves.toBe(scan);
  });

  it("does not need a signal from the read", async () => {
    const { keep } = keeper();
    const { load, open } = gatedLoad();
    open();
    await expect(shareScans(keep)({ key: "k", load, signal: undefined })).resolves.toBe(scan);
  });
});
