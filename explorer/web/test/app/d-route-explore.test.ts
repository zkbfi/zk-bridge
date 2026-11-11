import { describe, expect, it } from "vitest";
import { formatRoute, parseRoute } from "../../src/app/route";

const TX = "0x4663c8c20fc80a37f8e93102602d2fb969e93d1973c49011edff6915ab4828db";
const ADDRESS = "0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc";

describe("Explore's addresses that do not name a page", () => {
  it.each([
    ["costs with something after it", "#/explore/costs/1"],
    ["a gate with no chain", "#/explore/gate"],
    ["a gate with a chain that is not a number", "#/explore/gate/pulse"],
    ["a transaction with no chain and no hash", "#/explore/tx"],
    ["a transaction with a chain and no hash", "#/explore/tx/1"],
    ["a transaction with a hash that is too short", "#/explore/tx/1/0x12"],
    ["a contract with an address that is too short", "#/explore/contract/1/0x12"],
    ["a block that is not a number", "#/explore/block/1/latest"],
    ["a proof whose chain is not a number", "#/explore/proof/mainnet/1"],
    ["an address page with no address", "#/explore/address"],
    ["an address that is too short", "#/explore/address/0x12"],
    ["a slot that is not a number", "#/explore/slot/head"],
    ["a token with no address", "#/explore/token/first"],
    ["a token on a side that is neither first nor second", "#/explore/token/third/" + ADDRESS],
    ["a token with a bad address", "#/explore/token/first/0x12"],
    ["a release with a name that is too short", "#/explore/release/v1"],
    ["a browse page with capital letters", "#/explore/browse/Proofs"],
  ])("falls back to the top of Explore for %s", (_name, hash) => {
    expect(parseRoute(hash)).toEqual({ name: "explore" });
  });

  it("reads a release by its identifier, and writes it back", () => {
    const route = parseRoute("#/explore/release/abcdef1234");
    expect(route).toEqual({ name: "explore", page: { kind: "release", id: "abcdef1234" } });
    expect(formatRoute(route)).toBe("#/explore/release/abcdef1234");
  });

  it("keeps the search text of the top when the page is not valid", () => {
    expect(parseRoute("#/explore/slot/head?q=abc")).toEqual({ name: "explore", q: "abc" });
  });
});

describe("writing Explore's addresses", () => {
  it("writes a gate page from its identifier when it has no chain, and a page that is on a chain from its chain", () => {
    expect(formatRoute({ name: "explore", page: { kind: "gate", id: "943" } })).toBe("#/explore/gate/943");
    expect(formatRoute({ name: "explore", page: { kind: "tx", chainId: 1, id: TX } })).toBe(`#/explore/tx/1/${TX}`);
  });

  it("writes a page that is not on a chain from its identifier, escaped", () => {
    expect(formatRoute({ name: "explore", page: { kind: "address", id: ADDRESS } })).toBe(`#/explore/address/${ADDRESS}`);
    expect(formatRoute({ name: "explore", page: { kind: "tx", id: TX } })).toBe(`#/explore/tx/${TX}`);
  });

  it("writes the top of Explore with its search text, and without it when the text is empty", () => {
    expect(formatRoute({ name: "explore", q: "a b" })).toBe("#/explore?q=a+b");
    expect(formatRoute({ name: "explore", q: "" })).toBe("#/explore");
  });
});
