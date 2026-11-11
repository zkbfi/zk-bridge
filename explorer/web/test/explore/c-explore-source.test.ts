import { afterEach, describe, expect, it, vi } from "vitest";
import { createIndexerExploreSource, parseBrowsedProofs, parseGates, parseHistory, parseLightClientCosts, parseProofs } from "../../src/explore/explore-source";
import { RECORDED_HEAD_UPDATES } from "./recorded";

const item = RECORDED_HEAD_UPDATES.items[0]!;

afterEach(() => vi.unstubAllGlobals());

describe("the indexer answers, read strictly", () => {
  it("refuses an answer that is not an object, not a list, or whose numbers and hex are malformed", () => {
    expect(() => parseProofs(null)).toThrow(/head updates is not an object/);
    expect(() => parseProofs([])).toThrow(/head updates is not an object/);
    expect(() => parseProofs({ items: {} })).toThrow(/head updates is not a list/);
    expect(() => parseProofs({ items: [{ ...item, timestamp: 1.5 }] })).toThrow(/timestamp is not a whole number/);
    expect(() => parseProofs({ items: [{ ...item, slot: "12x" }] })).toThrow(/slot is not a whole number/);
    expect(() => parseProofs({ items: [{ ...item, headerRoot: "zz" }] })).toThrow(/headerRoot is not hex/);
    expect(() => parseProofs({ items: [{ ...item, headerRoot: 5 }] })).toThrow(/headerRoot is not hex/);
  });

  it("takes a decimal string or a number for a big value, and lower-cases hex", () => {
    const [row] = parseProofs({ items: [{ ...item, slot: "123456789012345678901", gasUsed: 7, headerRoot: "0xAB" }] });
    expect(row).toMatchObject({ slot: 123456789012345678901n, gasUsed: 7n, headerRoot: "0xab" });
  });

  it("reads a browsed proof with its own number", () => {
    expect(parseBrowsedProofs({ items: [{ ...item, number: 9 }] })[0]!.number).toBe(9);
    expect(() => parseBrowsedProofs({ items: [{ ...item, number: "9" }] })).toThrow(/number is not a whole number/);
  });

  it("reads gates with their confirmations, and light-client costs", () => {
    const gate = { chainId: 1, gate: "0x1782a38a37ce9fb9f53b0585b23b833847007e20", enforcing: true, sealed: true, depositsOpen: true, confirmations: 3, lastConfirmedTimestamp: 77 };
    expect(parseGates({ sides: [gate] })[0]).toMatchObject({ enforcing: true, sealed: true, depositsOpen: true, confirmations: 3, lastConfirmedTimestamp: 77 });
    expect(parseGates({ sides: [{ ...gate, lastConfirmedTimestamp: undefined, confirmations: undefined }] })[0]).toMatchObject({ confirmations: 0, lastConfirmedTimestamp: null });
    expect(() => parseLightClientCosts({ perChain: [{ chainId: 1 }] })).toThrow(/updates/);
  });

  it("reads history items: the kind and status when they are text, the hashes and slot when present", () => {
    const hash = `0x${"ab".repeat(32)}`;
    const [full, bare] = parseHistory({
      items: [
        { kind: "message", chainId: 1, timestamp: 5, transactionHash: hash, messageId: hash, slot: "9", status: "covered" },
        { kind: 3, chainId: 1, timestamp: 5, status: 4 },
      ],
    });
    expect(full).toEqual({ kind: "message", chainId: 1, timestamp: 5, transactionHash: hash, messageId: hash, slot: 9n, status: "covered" });
    expect(bare).toEqual({ kind: "unknown", chainId: 1, timestamp: 5, transactionHash: null, messageId: null, slot: null, status: null });
  });
});

describe("the source's requests", () => {
  it("filters the updates by slot, transaction and chain, and counts the escrow, undelivered and release lists", async () => {
    const urls: string[] = [];
    const source = createIndexerExploreSource(() => "https://i.test", async (url) => {
      urls.push(url);
      if (url.endsWith("/api/escrow")) return { escrow: [1, 2] };
      if (url.endsWith("/api/undelivered")) return { items: [1] };
      if (url.endsWith("/api/release-events")) return { events: [1, 2, 3] };
      return { items: [{ ...item, number: 1 }] };
    });
    await source.findProofs({ chainId: 943 });
    await source.findProofs({});
    expect(urls).toEqual(["https://i.test/api/browse/proofs?limit=50&sort=newest&chainId=943", "https://i.test/api/browse/proofs?limit=50&sort=newest"]);
    expect(await source.counts()).toEqual({ escrowed: 2, undelivered: 1, releases: 3 });
  });

  it("gives the newest update no next neighbour", async () => {
    const rows = [4, 5].map((number) => ({ ...item, number }));
    const source = createIndexerExploreSource(() => "https://i.test", async () => ({ items: rows, total: 5, limit: 3, offset: 3, asOf: 1 }));
    const result = await source.proofByNumber(11155111, 5);
    expect([result?.previous?.number, result?.proof.number, result?.next]).toEqual([4, 5, null]);
  });

  it("reads the delivered counts and the beacon clocks from their routes", async () => {
    const urls: string[] = [];
    const source = createIndexerExploreSource(() => "https://i.test", async (url) => {
      urls.push(url);
      return url.endsWith("/api/heads") ? { heads: [] } : { directions: [] };
    });
    expect(await source.delivered()).toEqual([]);
    expect(await source.beaconClocks()).toEqual([]);
    expect(urls).toEqual(["https://i.test/api/delivered", "https://i.test/api/heads"]);
  });

  it("without a request function, fetches the indexer and names the path when it answers with an error", async () => {
    const fetchMock = vi.fn(async (url: string) => (url.endsWith("/api/gate") ? new Response("no", { status: 502 }) : new Response(JSON.stringify({ perChain: [] }), { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    const source = createIndexerExploreSource(() => "https://i.test/");
    expect(await source.lightClientCosts()).toEqual([]);
    await expect(source.gates()).rejects.toThrow("The indexer answered 502 for /api/gate.");
    expect(fetchMock.mock.calls[0]![0]).toBe("https://i.test/api/light-client-costs");
  });
});
