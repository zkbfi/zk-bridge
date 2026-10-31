import { describe, expect, it } from "vitest";
import { dollarsRange, dollarsSpanWords } from "../../src/bridge/number";

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

describe("dollarsSpanWords", () => {
  const usd = (text: string): bigint => BigInt(Math.round(Number(text) * 1e6)) * 10n ** 12n;
  it("says between when the ends differ, about when they cannot be told apart", () => {
    expect(dollarsSpanWords(usd("0.18"), usd("0.31"))).toBe("between $0.18 and $0.31");
    expect(dollarsSpanWords(25_000_000_000_000_000n, 25_000_000_000_100_000n)).toBe("about $0.025");
  });
});
