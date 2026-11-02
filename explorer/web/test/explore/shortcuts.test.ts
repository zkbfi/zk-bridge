import { describe, expect, it } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import type { FeedItem, LightClientHead, TokenInfo } from "@terminal/model/types";
import type { ProofRow } from "../../src/explore/explore-source";
import { exploreShortcuts } from "../../src/explore/shortcuts";

const now = 1_000_000;
const first = FIXTURE_PAIR.first;
const second = FIXTURE_PAIR.second;
const feedItem = (overrides: Partial<FeedItem>): FeedItem => ({
  id: `0x${"11".repeat(32)}`,
  kind: "token",
  direction: "first-to-second",
  status: "delivered",
  sender: "0x0000000000000000000000000000000000000001",
  recipient: "0x0000000000000000000000000000000000000002",
  token: { address: "0x00000000000000000000000000000000000000aa", symbol: "tUSD", decimals: 6, side: "first", counterpart: null },
  amount: 8_220_000n,
  sentAt: now - 14 * 3600,
  deliveredAt: null,
  sourceTransactionHash: `0x${"22".repeat(32)}`,
  destinationTransactionHash: null,
  ...overrides,
});
const proof = (overrides: Partial<ProofRow>): ProofRow =>
  ({ number: 9, chainId: second.chainId, slot: 100n, headerRoot: "0x", executionBlockHash: "0x", executionBlockNumber: 1n, transactionHash: `0x${"33".repeat(32)}`, blockNumber: 1n, timestamp: now - 3 * 3600, gasUsed: 1n, effectiveGasPrice: 1n, costWei: 1n, poster: "0x0000000000000000000000000000000000000003", ...overrides }) as ProofRow;
const token = (symbol: string, side: "first" | "second"): TokenInfo => ({ address: `0x${symbol.length.toString(16).padStart(40, "0")}`, symbol, decimals: 6, side, counterpart: null });
const heads: LightClientHead[] = [
  { side: "first", storedHeadSlot: 11194368n, finalizedSlot: 1n, lagSlots: 9568n, secondsPerSlot: 10, lastUpdateAt: now },
  { side: "second", storedHeadSlot: null, finalizedSlot: 1n, lagSlots: null, secondsPerSlot: 12, lastUpdateAt: null },
];
const empty = { pair: FIXTURE_PAIR, now, feed: [], proofs: [], tokens: [], heads: [] };

describe("Explore's search shortcuts", () => {
  it("offers nothing when nothing is loaded", () => {
    expect(exploreShortcuts(empty)).toEqual([]);
  });

  it("names the newest transfer with its amount, symbol and age", () => {
    const older = feedItem({ id: `0x${"44".repeat(32)}`, sentAt: now - 99_999, amount: 1_000_000n });
    const [latest] = exploreShortcuts({ ...empty, feed: [older, feedItem({})] });
    expect(latest).toMatchObject({ group: "Latest transfer", title: "8.22 tUSD", sub: "14 h ago" });
    expect(latest!.href).toBe(`#/explore/tx/${first.chainId}/${`0x${"22".repeat(32)}`}`);
  });

  it("calls a transfer without a token or amount a message", () => {
    const [latest] = exploreShortcuts({ ...empty, feed: [feedItem({ token: null, amount: null, direction: "second-to-first" })] });
    expect(latest).toMatchObject({ title: "Message", sub: "14 h ago" });
    expect(latest!.href).toContain(`/tx/${second.chainId}/`);
  });

  it("gives the newest proof per direction, routed from the chain it checks to the chain that holds it", () => {
    const items = exploreShortcuts({ ...empty, proofs: [proof({ number: 8, timestamp: now - 20_000 }), proof({ number: 9 }), proof({ number: 7, timestamp: now - 30_000 }), proof({ number: 4, chainId: first.chainId, timestamp: now - 600 })] });
    expect(items.map((item) => [item.group, item.title, item.sub])).toEqual([
      ["Latest proof", "Proof #9", `${first.name} → ${second.name} · 3 h ago`],
      ["Latest proof", "Proof #4", `${second.name} → ${first.name} · 10 min ago`],
    ]);
    expect(items[0]!.href).toBe(`#/explore/proof/${second.chainId}/9`);
  });

  it("lists the light clients that have verified a slot, with the slot and the time of the last update", () => {
    // Owner: "give them hard numbers" and say what happens: the age of the last update, not "behind" (a reason).
    const items = exploreShortcuts({ ...empty, heads: [{ ...heads[0]!, lastUpdateAt: now - 5 * 3600 }, heads[1]!] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ group: "Light clients", title: `${first.name} checks ${second.name}`, sub: "slot 11,194,368 · last update 5 h ago", href: "#/explore/slot/11194368" });
    expect(exploreShortcuts({ ...empty, heads: [{ ...heads[0]!, lastUpdateAt: null }] })[0]!.sub).toBe("slot 11,194,368 · never updated");
  });

  it("lists the tokens per chain with their number, skipping a chain without any", () => {
    const items = exploreShortcuts({ ...empty, tokens: [token("tUSD", "first"), token("tETH", "first")] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ group: "Tokens", title: first.name, sub: "tUSD, tETH · 2 listed", href: "#/explore/browse/tokens" });
    const both = exploreShortcuts({ ...empty, tokens: [token("tUSD", "first"), token("tUSD", "second")] });
    expect(both.map((item) => item.title)).toEqual([first.name, second.name]);
  });

  it("gives every shortcut its own id", () => {
    const all = exploreShortcuts({ ...empty, feed: [feedItem({})], proofs: [proof({})], heads, tokens: [token("tUSD", "first")] });
    expect(new Set(all.map((item) => item.id)).size).toBe(all.length);
  });
});
