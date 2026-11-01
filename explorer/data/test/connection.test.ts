import { afterEach, describe, expect, it, vi } from "vitest";
import { createExplorerConnection, fetchJsonResponse, resolveConnection, type JsonFetcher } from "../src/index.js";
import { createFakeChain } from "./support/fake-chain.js";
import { testPair } from "./support/fixtures.js";
import { buildScenario } from "./support/scenario.js";

const KEY = "FAKEKEY1234567890";
const INDEXER = `https://indexer.example.org/${KEY}`;
const pair = testPair();
const scenario = buildScenario(pair);
const NOW_SECONDS = Number(scenario.timestampOf(1, 300n));

const resolved = (settings: { indexer?: string | null; rpc?: boolean } = {}) =>
  resolveConnection({
    chainIds: [1, 369],
    user: { indexerUrl: settings.indexer === undefined ? INDEXER : settings.indexer },
    environment: {},
    registry: { rpcUrls: settings.rpc === false ? {} : { 1: `https://rpc1.example.org/v3/${KEY}`, 369: `https://rpc369.example.org/${KEY}` } },
  });

const setup = (options: { indexer?: string | null; rpc?: boolean; fetchJson?: JsonFetcher; createReaderFails?: boolean } = {}) => {
  let clock = NOW_SECONDS * 1000;
  const chains = { 1: createFakeChain(scenario, 1), 369: createFakeChain(scenario, 369) };
  const fetchJson = vi.fn<JsonFetcher>(options.fetchJson ?? (async () => ({ status: 200, body: { marker: "indexer" } })));
  const connection = createExplorerConnection({
    pair,
    resolved: resolved(options),
    fetchJson,
    createReader: ({ chainId }) => chains[chainId as 1 | 369],
    now: () => clock,
    rpc: { nowSeconds: () => NOW_SECONDS },
  });
  return { connection, fetchJson, chains, advance: (milliseconds: number) => void (clock += milliseconds) };
};

const headsAnswer = (lagSeconds: number | null) => async (): Promise<{ status: number; body: unknown }> => ({
  status: 200,
  body: {
    heads: [
      { chainId: 1, ownChainTipTimestamp: lagSeconds === null ? null : NOW_SECONDS - lagSeconds },
      { chainId: 369, ownChainTipTimestamp: lagSeconds === null ? null : NOW_SECONDS - lagSeconds },
    ],
  },
});

afterEach(() => vi.unstubAllGlobals());

describe("with a healthy indexer", () => {
  it("reads from the indexer and says so", async () => {
    const { connection, fetchJson } = setup();
    expect(await connection.getJson(`${connection.baseUrl}/api/summary`)).toEqual({ marker: "indexer" });
    expect(fetchJson).toHaveBeenCalledWith(`${INDEXER}/api/summary`);
    expect(connection.status()).toEqual({ kind: "indexer", reason: null, label: "indexer" });
    expect(connection.baseUrl).toBe(INDEXER);
  });

  it("returns a 404 answer from request as a value, because an unknown message is an answer", async () => {
    const { connection } = setup({ fetchJson: async () => ({ status: 404, body: { error: "unknown message" } }) });
    expect(await connection.request(`${connection.baseUrl}/api/messages/0x00`)).toEqual({ status: 404, body: { error: "unknown message" } });
    expect(connection.status().kind).toBe("indexer");
  });

  it("makes getJson throw for a 404, with the error text of the answer and no URL", async () => {
    const { connection } = setup({ fetchJson: async () => ({ status: 404, body: { error: `unknown message ${INDEXER}` } }) });
    const failure = await connection.getJson(`${connection.baseUrl}/api/messages/0x00?x=1`).catch((error: Error) => error);
    expect((failure as Error).message).toBe("The answer for /api/messages/0x00 is 404: unknown message [redacted].");
    expect((failure as Error).message).not.toContain(KEY);
  });

  it("makes getJson throw for a 404 that has no error text", async () => {
    const { connection } = setup({ fetchJson: async () => ({ status: 404, body: null }) });
    await expect(connection.getJson(`${connection.baseUrl}/api/x`)).rejects.toThrow("The answer for /api/x is 404.");
  });

  it("runs any read with the same rule", async () => {
    const { connection } = setup();
    expect(await connection.run({ viaIndexer: async () => "from the indexer", viaRpc: async () => "from RPC" })).toBe("from the indexer");
  });
});

describe("when the indexer fails", () => {
  it("falls back to the chains when the indexer is unreachable, and the answer has the shape of the indexer", async () => {
    const { connection } = setup({ fetchJson: async () => Promise.reject(new TypeError("fetch failed")) });
    const feed = (await connection.getJson(`${connection.baseUrl}/api/feed?limit=50`)) as { items: unknown[]; coverage: { source: string } };
    expect(feed.items).toHaveLength(11);
    expect(feed.coverage.source).toBe("rpc");
    expect(connection.status().label).toBe("RPC fallback: indexer unreachable");
  });

  it("falls back when the indexer answers with a server error, and names the error", async () => {
    const { connection } = setup({ fetchJson: async () => ({ status: 502, body: null }) });
    await connection.getJson(`${connection.baseUrl}/api/tokens`);
    expect(connection.status().label).toBe("RPC fallback: indexer error: The indexer answered 502 for /api/tokens.");
  });

  it("keeps the key of the indexer URL out of the reason", async () => {
    const { connection } = setup({ fetchJson: async () => Promise.reject(new Error(`bad gateway at ${INDEXER}/api/feed`)) });
    await connection.getJson(`${connection.baseUrl}/api/tokens`);
    expect(connection.status().label).not.toContain(KEY);
    expect(connection.status().label).toContain("RPC fallback: indexer error:");
  });

  it("tells the user to set an RPC URL when the indexer fails and no RPC URL exists", async () => {
    const { connection } = setup({ rpc: false, fetchJson: async () => Promise.reject(new TypeError("fetch failed")) });
    await expect(connection.getJson(`${connection.baseUrl}/api/feed`)).rejects.toThrow("No RPC URL is set for ethereum.");
  });

  it("notifies a listener when the source changes", async () => {
    const { connection } = setup({ fetchJson: async () => Promise.reject(new TypeError("fetch failed")) });
    const labels: string[] = [];
    connection.subscribe((status) => labels.push(status.label));
    await connection.getJson(`${connection.baseUrl}/api/tokens`);
    expect(labels).toEqual(["RPC fallback: indexer unreachable"]);
  });
});

describe("without an indexer URL", () => {
  it("uses the chains from the start, takes the path from any URL, and never asks the indexer", async () => {
    const { connection, fetchJson } = setup({ indexer: null });
    expect(connection.baseUrl).toBe("http://indexer.not-set.invalid");
    expect(connection.status().label).toBe("RPC fallback: no indexer URL is set");
    const tokens = (await connection.getJson(`${connection.baseUrl}/api/tokens`)) as { tokens: unknown[] };
    expect(tokens.tokens).toHaveLength(2);
    const sameAnswer = (await connection.getJson("https://elsewhere.example/api/tokens")) as { tokens: unknown[] };
    expect(sameAnswer.tokens).toHaveLength(2);
    await connection.checkNow();
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it("returns a 404 and a 400 of the RPC source as values from request", async () => {
    const { connection } = setup({ indexer: null });
    expect((await connection.request(`${connection.baseUrl}/api/messages/0x${"9".repeat(64)}`)).status).toBe(404);
    expect((await connection.request(`${connection.baseUrl}/api/feed?limit=0`)).status).toBe(400);
    await expect(connection.getJson(`${connection.baseUrl}/api/feed?limit=0`)).rejects.toThrow("is 400: invalid limit: 0");
  });

  it("refuses a path that the RPC source does not serve", async () => {
    const { connection } = setup({ indexer: null });
    await expect(connection.getJson(`${connection.baseUrl}/api/escrow`)).rejects.toThrow("/api/escrow is not available from the RPC source.");
  });
});

describe("checking the indexer", () => {
  it("falls back when the indexer is behind the chain head by more than the limit, and says by how much", async () => {
    const { connection } = setup({ fetchJson: headsAnswer(900) });
    await connection.checkNow();
    expect(connection.status().label).toBe("RPC fallback: indexer 900 s behind the chain head");
  });

  it("stays on the indexer when the lag is within the limit", async () => {
    const { connection } = setup({ fetchJson: headsAnswer(120) });
    await connection.checkNow();
    expect(connection.status().kind).toBe("indexer");
  });

  it("goes back to the indexer when it caught up", async () => {
    let lag = 900;
    const { connection } = setup({ fetchJson: async () => headsAnswer(lag)() });
    await connection.checkNow();
    expect(connection.status().kind).toBe("rpc");
    lag = 5;
    await connection.checkNow();
    expect(connection.status().label).toBe("indexer");
  });

  it("calls an indexer with no block for a chain behind", async () => {
    const { connection } = setup({ fetchJson: headsAnswer(null) });
    await connection.checkNow();
    expect(connection.status().label).toBe("RPC fallback: indexer an unknown time behind the chain head");
  });

  it("falls back when the check gets a status that is not 200", async () => {
    const { connection } = setup({ fetchJson: async () => ({ status: 503, body: null }) });
    await connection.checkNow();
    expect(connection.status().label).toBe("RPC fallback: indexer answered 503");
  });

  it("treats an answer with no list of heads as an indexer that holds no block", async () => {
    const { connection } = setup({ fetchJson: async () => ({ status: 200, body: null }) });
    await connection.checkNow();
    expect(connection.status().reason?.code).toBe("behind");
  });

  it("compares with the clock of the chains when every chain has an RPC URL, and with the wall clock when one has none", async () => {
    const wallClockOnly = setup({ rpc: false, fetchJson: headsAnswer(100) });
    await wallClockOnly.connection.checkNow();
    expect(wallClockOnly.connection.status().kind).toBe("indexer");
    const failingChain = setup({ fetchJson: headsAnswer(100) });
    failingChain.chains[369].getBlock = async () => {
      throw new Error("rpc down");
    };
    await failingChain.connection.checkNow();
    expect(failingChain.connection.status().kind).toBe("indexer");
  });

  it("checks on its own when a read arrives after the interval", async () => {
    const { connection, advance, fetchJson } = setup({ fetchJson: headsAnswer(900) });
    advance(31_000);
    await connection.run({ viaIndexer: async () => "x", viaRpc: async () => "y" });
    await connection.checkNow();
    expect(fetchJson).toHaveBeenCalledWith(`${INDEXER}/api/heads`);
    expect(connection.status().kind).toBe("rpc");
  });
});

describe("secrets", () => {
  it("removes every URL that the connection holds, and every part of one, from a text", () => {
    const { connection } = setup();
    const text = `failed at ${INDEXER}/x and https://rpc1.example.org/v3/${KEY} and ${KEY}`;
    expect(connection.redact(text)).not.toContain(KEY);
  });

  it("removes the four endpoint URLs and their keys from a text", () => {
    const connection = createExplorerConnection({
      pair,
      resolved: resolveConnection({
        chainIds: [1, 369],
        user: {
          indexerUrl: INDEXER,
          backendUrl: "https://backend.example.org/BACKENDKEY99",
          msgboardIndexerUrl: "https://mi.example.org/MSGINDEXKEY99",
          archiveUrl: "https://archive.example.org/ARCHIVEKEY99",
          msgboardUrl: "https://node.example.org/NODEKEY99",
        },
        environment: {},
        registry: { rpcUrls: {} },
      }),
      fetchJson: async () => ({ status: 200, body: {} }),
    });
    const cleaned = connection.redact("a https://backend.example.org/BACKENDKEY99 b MSGINDEXKEY99 c ARCHIVEKEY99 d NODEKEY99");
    for (const key of ["BACKENDKEY99", "MSGINDEXKEY99", "ARCHIVEKEY99", "NODEKEY99"]) expect(cleaned).not.toContain(key);
  });

  it("removes the key from the message of an RPC failure", async () => {
    const { connection, chains } = setup({ indexer: null });
    chains[1].getLogs = async () => {
      throw new Error(`HTTP request failed. URL: https://rpc1.example.org/v3/${KEY}`);
    };
    const failure = await connection.getJson(`${connection.baseUrl}/api/feed`).catch((error: Error) => error);
    expect((failure as Error).message).not.toContain(KEY);
    expect((failure as Error).message).toContain("HTTP request failed");
  });
});

describe("the defaults", () => {
  it("uses fetch, the system clock and the viem reader when the caller gives none, and the intervals that the caller gives", async () => {
    const fetchMock = vi.fn(async () => new Response('{"marker":"default fetch"}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const connection = createExplorerConnection({ pair, resolved: resolved(), freshnessIntervalMilliseconds: 1, recoveryIntervalMilliseconds: 1 });
    expect(await connection.getJson(`${connection.baseUrl}/api/summary`)).toEqual({ marker: "default fetch" });
    expect(connection.status().kind).toBe("indexer");
  });
});

describe("fetchJsonResponse", () => {
  it("returns the status and the parsed body, and null for a body that is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url.endsWith("/json") ? new Response('{"a":1}', { status: 200 }) : new Response("<html>", { status: 502 }))),
    );
    expect(await fetchJsonResponse("http://x.test/json")).toEqual({ status: 200, body: { a: 1 } });
    expect(await fetchJsonResponse("http://x.test/page")).toEqual({ status: 502, body: null });
  });

  it("cancels the request when the signal of the caller aborts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })),
      ),
    );
    const leaving = new AbortController();
    const read = fetchJsonResponse("http://x.test/slow", leaving.signal);
    leaving.abort(new Error("page left"));
    await expect(read).rejects.toThrow("page left");
  });
});
