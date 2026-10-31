import { describe, expect, it } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { parseProofs } from "../../src/explore/explore-source";
import { recognise, searchExplore, type SearchData } from "../../src/explore/search";
import { RECORDED_HEAD_UPDATES } from "./recorded";

const TX = "0x4663c8c20fc80a37f8e93102602d2fb969e93d1973c49011edff6915ab4828db";
const data: SearchData = {
  pair: FIXTURE_PAIR,
  proofs: parseProofs(RECORDED_HEAD_UPDATES),
  tokens: [{ address: "0x0000000000000000000000000000000000001001", symbol: "USDC", decimals: 6, side: "first", counterpart: null }],
  feed: [],
};

describe("what the search band recognises", () => {
  it.each([
    [TX, "hash", "Transaction or message hash"],
    ["0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc", "address", "Address"],
    ["0x4663c8c2", "partial", "Partial hash or address"],
    ["11194368", "number", "Slot, block or proof number"],
    ["bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", "cid", "Release CID"],
    ["usdc", "symbol", "Token symbol"],
    ["", "empty", ""],
    ["hello world!", "unknown", "Nothing recognised"],
  ])("%s → %s", (text, kind, label) => {
    expect(recognise(text)).toEqual({ kind, label });
  });
});

describe("the search over Explore's data", () => {
  it("finds the proof and the transaction behind a partial hash, with the match marked", () => {
    const groups = searchExplore("0x4663c8c2", data);
    expect(groups.map((group) => group.title)).toEqual(["Transactions", "Proofs"]);
    expect(groups[0]!.items[0]).toMatchObject({ href: `#/explore/tx/11155111/${TX}`, match: "0x4663c8c2" });
    expect(groups[1]!.items[0]).toMatchObject({ title: "Proof #1", href: "#/explore/proof/11155111/1" });
  });

  it("finds the proof by its slot or execution block, and offers the slot and the blocks on both chains", () => {
    const bySlot = searchExplore("11194368", data);
    expect(bySlot.find((group) => group.title === "Proofs")!.items).toHaveLength(1);
    expect(bySlot.find((group) => group.title === "Slots")!.items[0]!.href).toBe("#/explore/slot/11194368");
    expect(bySlot.find((group) => group.title === "Blocks")!.items.map((item) => item.href)).toEqual([`#/explore/block/${FIXTURE_PAIR.first.chainId}/11194368`, `#/explore/block/${FIXTURE_PAIR.second.chainId}/11194368`]);
    expect(searchExplore("25767883", data).find((group) => group.title === "Proofs")!.items).toHaveLength(1);
  });

  it("finds tokens by symbol, with the native coins", () => {
    const groups = searchExplore("us", data);
    expect(groups[0]).toMatchObject({ title: "Tokens", items: [{ title: "USDC", match: "US" }] });
    expect(searchExplore("eth", data)[0]!.items.map((item) => item.title)).toContain("ETH");
  });

  it("takes a full address to its page, and a full hash to the transaction on each chain when nothing indexed matches", () => {
    expect(searchExplore("0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc", data)[0]!.items[0]!.href).toBe("#/explore/address/0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc");
    const other = `0x${"12".repeat(32)}`;
    expect(searchExplore(other, data)[0]!.items.map((item) => item.href)).toEqual([`#/explore/tx/${FIXTURE_PAIR.first.chainId}/${other}`, `#/explore/tx/${FIXTURE_PAIR.second.chainId}/${other}`]);
  });

  it("finds contracts of the deployment by address", () => {
    const mediator = FIXTURE_PAIR.first.contracts.tokenMediator;
    const groups = searchExplore(mediator, data);
    expect(groups.find((group) => group.title === "Contracts")!.items[0]).toMatchObject({ title: "ERC-20 mediator", href: `#/explore/contract/${FIXTURE_PAIR.first.chainId}/${mediator}` });
  });
});
