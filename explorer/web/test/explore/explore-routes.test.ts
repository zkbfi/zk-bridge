import { describe, expect, it } from "vitest";
import { formatRoute, parseRoute, type Route } from "../../src/app/route";

const TX = "0x4663c8c20fc80a37f8e93102602d2fb969e93d1973c49011edff6915ab4828db";
const ADDRESS = "0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc";

describe("Explore's routes", () => {
  const cases: readonly [string, Route][] = [
    ["#/explore", { name: "explore" }],
    ["#/explore?q=0x4663c8c2", { name: "explore", q: "0x4663c8c2" }],
    ["#/explore?section=route", { name: "explore", section: "route" }],
    [`#/explore/tx/11155111/${TX}`, { name: "explore", page: { kind: "tx", chainId: 11155111, id: TX } }],
    [`#/explore/address/${ADDRESS}`, { name: "explore", page: { kind: "address", id: ADDRESS } }],
    ["#/explore/proof/11155111/1", { name: "explore", page: { kind: "proof", chainId: 11155111, id: "1" } }],
    ["#/explore/block/943/25767883", { name: "explore", page: { kind: "block", chainId: 943, id: "25767883" } }],
    ["#/explore/slot/11194368", { name: "explore", page: { kind: "slot", id: "11194368" } }],
    [`#/explore/token/first/${ADDRESS}`, { name: "explore", page: { kind: "token", id: `first:${ADDRESS}` } }],
    [`#/explore/contract/943/${ADDRESS}`, { name: "explore", page: { kind: "contract", chainId: 943, id: ADDRESS } }],
    ["#/explore/gate/943", { name: "explore", page: { kind: "gate", chainId: 943, id: "943" } }],
    ["#/explore/costs", { name: "explore", page: { kind: "costs", id: "" } }],
    ["#/explore/browse/proofs", { name: "explore", page: { kind: "browse", id: "proofs" } }],
    ["#/explore/browse/transfers?status=inflight&page=2", { name: "explore", page: { kind: "browse", id: "transfers", query: "status=inflight&page=2" } }],
  ];

  it.each(cases)("reads and writes %s", (hash, route) => {
    expect(parseRoute(hash)).toEqual(route);
    expect(formatRoute(route)).toBe(hash);
  });

  it("writes a browse page without a question mark when its query is empty", () => {
    expect(formatRoute({ name: "explore", page: { kind: "browse", id: "proofs", query: "" } })).toBe("#/explore/browse/proofs");
  });

  it("ignores a section it does not know", () => {
    expect(parseRoute("#/explore?section=nothing")).toEqual({ name: "explore" });
  });

  it("refuses malformed identifiers by falling back to Explore's top", () => {
    expect(parseRoute("#/explore/tx/11155111/0x12")).toEqual({ name: "explore" });
    expect(parseRoute("#/explore/tx/abc/" + TX)).toEqual({ name: "explore" });
    expect(parseRoute("#/explore/nothing/1")).toEqual({ name: "explore" });
  });
});
