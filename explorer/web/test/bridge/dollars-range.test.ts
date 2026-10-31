import { describe, expect, it } from "vitest";
import { dollarsRange } from "../../src/bridge/number";

describe("dollarsRange", () => {
  const usd = (text: string): bigint => BigInt(Math.round(Number(text) * 1e6)) * 10n ** 12n;
  it("keeps two decimals when the ends already differ", () => {
    expect(dollarsRange(usd("0.18"), usd("0.31"))).toEqual(["$0.18", "$0.31"]);
  });
  it("adds digits until the ends can be told apart", () => {
    expect(dollarsRange(usd("0.0213"), usd("0.0234"))).toEqual(["$0.0213", "$0.0234"]);
    expect(dollarsRange(usd("2.121"), usd("2.128"))).toEqual(["$2.121", "$2.128"]);
  });
  it("prints one value twice only when the ends are equal", () => {
    expect(dollarsRange(usd("0.05"), usd("0.05"))).toEqual(["$0.05", "$0.05"]);
  });
});
