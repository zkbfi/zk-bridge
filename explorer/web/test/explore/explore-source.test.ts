import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { createIndexerExploreSource, parseProofs } from "../../src/explore/explore-source";
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
