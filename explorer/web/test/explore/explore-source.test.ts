import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { createIndexerExploreSource, parseBeaconClocks, parseDelivered, parseProofs } from "../../src/explore/explore-source";
import { recordedRequester, RECORDED_HEAD_UPDATES } from "./recorded";

const source = createIndexerExploreSource(() => "https://indexer.zkb.fi/", recordedRequester);

describe("the Explore source over the indexer (recorded answers)", () => {
  it("reads the proofs, numbered per chain from the oldest", async () => {
    const [proof] = await source.proofs();
    expect(proof).toMatchObject({
      number: 1,
      chainId: 11155111,
      slot: 11194368n,
      executionBlockNumber: 25767883n,
      transactionHash: "0x4663c8c20fc80a37f8e93102602d2fb969e93d1973c49011edff6915ab4828db",
      gasUsed: 604091n,
      costWei: 60409100000000n,
      poster: "0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc",
    });
  });

  it("numbers several proofs per chain, newest listed first", () => {
    const second = { ...RECORDED_HEAD_UPDATES.items[0]!, slot: 11194400, timestamp: 1793300900, transactionHash: `0x${"ab".repeat(32)}` };
    const other = { ...RECORDED_HEAD_UPDATES.items[0]!, chainId: 943, timestamp: 1793300850 };
    const rows = parseProofs({ items: [RECORDED_HEAD_UPDATES.items[0], second, other] });
    expect(rows.map((row) => [row.chainId, row.number])).toEqual([
      [11155111, 2],
      [943, 1],
      [11155111, 1],
    ]);
  });

  it("finds an update by its number through the paged list, with its neighbours, however old it is", async () => {
    const urls: string[] = [];
    const base = RECORDED_HEAD_UPDATES.items[0]!;
    const rows = [1_000, 1_001, 1_002].map((number) => ({ ...base, number, slot: 5_000 + number }));
    const found = createIndexerExploreSource(() => "https://i.test", async (url) => {
      urls.push(url);
      return { items: rows, total: 3_000, limit: 3, offset: 1_000, asOf: 1 };
    });
    const result = await found.proofByNumber(11155111, 1_001);
    expect(urls).toEqual(["https://i.test/api/browse/proofs?chainId=11155111&sort=oldest&offset=999&limit=3"]);
    expect([result?.previous?.number, result?.proof.number, result?.next?.number]).toEqual([1_000, 1_001, 1_002]);
    expect(await found.proofByNumber(11155111, 5_000)).toBeNull();
    expect(await found.proofByNumber(11155111, 0)).toBeNull();
    urls.length = 0;
    expect((await found.proofByNumber(11155111, 1_000))?.previous).toBeNull();
    expect(urls[0]).toContain("offset=998");
  });

  it("starts the window at the first update for number 1 and 2", async () => {
    const urls: string[] = [];
    const empty = createIndexerExploreSource(() => "https://i.test", async (url) => (urls.push(url), { items: [], total: 0, limit: 3, offset: 0, asOf: 1 }));
    await empty.proofByNumber(943, 1);
    await empty.proofByNumber(943, 2);
    expect(urls.map((url) => new URL(url).searchParams.get("offset"))).toEqual(["0", "0"]);
  });

  it("looks an update up by its slot or its posting transaction in the whole history", async () => {
    const urls: string[] = [];
    const found = createIndexerExploreSource(() => "https://i.test/", async (url) => (urls.push(url), { items: [{ ...RECORDED_HEAD_UPDATES.items[0]!, number: 42 }], total: 1, limit: 50, offset: 0, asOf: 1 }));
    const hash = `0x${"ab".repeat(32)}` as const;
    expect((await found.findProofs({ slot: 11194368n }))[0]?.number).toBe(42);
    await found.findProofs({ transactionHash: hash, chainId: 943 });
    expect(urls).toEqual([
      "https://i.test/api/browse/proofs?limit=50&sort=newest&slot=11194368",
      `https://i.test/api/browse/proofs?limit=50&sort=newest&transactionHash=${hash}&chainId=943`,
    ]);
  });

  it("reads the gates, the light-client costs, the history and the counts", async () => {
    expect(await source.gates()).toEqual([
      { chainId: 11155111, gate: getAddress("0x1782a38a37ce9fb9f53b0585b23b833847007e20"), enforcing: true, sealed: false, depositsOpen: false, confirmations: 0, lastConfirmedTimestamp: null },
      { chainId: 943, gate: getAddress("0x0e8586fb952f8a299e31c8b8fbe093dde8e1be93"), enforcing: false, sealed: false, depositsOpen: false, confirmations: 0, lastConfirmedTimestamp: null },
    ]);
    expect(await source.lightClientCosts()).toEqual([{ chainId: 11155111, updates: 1, gasUsed: 604091n, costWei: 60409100000000n }]);
    expect((await source.history(50))[0]).toMatchObject({ kind: "head-update", slot: 11194368n, messageId: null });
    expect(await source.counts()).toEqual({ escrowed: 0, undelivered: 0, releases: 0 });
  });

  it("refuses a malformed answer and asks for an indexer when none is set", async () => {
    expect(() => parseProofs({ items: [{ chainId: "x" }] })).toThrow(/chainId/);
    await expect(createIndexerExploreSource(() => null, recordedRequester).proofs()).rejects.toThrow(/Settings/);
  });
});

describe("the in-flight orbits' reads", () => {
  it("reads the delivered counts per direction", () => {
    expect(parseDelivered({ now: 1, directions: [{ sourceChainId: 1, destinationChainId: 369, last24h: 3, last7d: 9, byToken: [] }] })).toEqual([{ sourceChainId: 1, last24h: 3, last7d: 9, timing: null }]);
    expect(() => parseDelivered({ directions: [{ sourceChainId: 1, last24h: "x" }] })).toThrow(/last24h/);
  });

  it("reads each direction's timing: sent → delivered and each step, for 24 hours and 7 days", () => {
    const window = (median: number | null) => ({
      count: median === null ? 0 : 4,
      sentToDelivered: { avg: median, median, p90: median === null ? null : median * 2 },
      steps: { sent: { median: 768, p90: 768 }, final: { median: 100, p90: 300 }, ready: { median: 20, p90: 60 } },
    });
    const [out, back] = parseDelivered({
      directions: [{ sourceChainId: 1, destinationChainId: 369, last24h: 4, last7d: 9, byToken: [] }],
      timing: [
        { sourceChainId: 1, last24h: window(900), last7d: window(1000) },
        { sourceChainId: 369, last24h: window(null), last7d: window(null) },
      ],
    });
    expect(out!.timing!.last24h).toEqual({
      count: 4,
      sentToDelivered: { avg: 900, median: 900, p90: 1800 },
      steps: [
        { avg: null, median: 768, p90: 768 },
        { avg: null, median: 100, p90: 300 },
        { avg: null, median: 20, p90: 60 },
      ],
    });
    // A direction with no deliveries in 7 days still gets its (empty) timing.
    expect(back).toMatchObject({ sourceChainId: 369, last24h: 0, last7d: 0, timing: { last24h: { count: 0 } } });
    expect(() => parseDelivered({ directions: [], timing: [{ sourceChainId: 1, last24h: { count: 1, sentToDelivered: { median: "x" }, steps: {} } }] })).toThrow(/median/);
  });

  it("reads each tracked chain's beacon clock from a stored head's slot and slot time", () => {
    const clocks = parseBeaconClocks({
      heads: [
        { chainId: 369, trackedChainId: 1, storedHeadSlot: 100, storedHeadSlotTimestamp: 1_606_825_223 },
        { chainId: 1, trackedChainId: 369, storedHeadSlot: null, storedHeadSlotTimestamp: null },
      ],
    });
    expect(clocks).toEqual([{ trackedChainId: 1, genesisTime: 1_606_824_023, secondsPerSlot: 12 }]);
  });
});
