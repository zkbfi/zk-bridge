import { describe, expect, it } from "vitest";
import { gasPriceBasisFor, gasRange, tokenUnitsToWeiFloor } from "../src/index.js";

describe("gasRange with no gas", () => {
  it("keeps the low and high ends at the anchor when the gas costs nothing", () => {
    const range = gasRange({ gasUsed: 0n, baseFeeWei: 10n ** 9n, priorityFeeWei: 0n, nativePriceE18: 10n ** 18n, level: 1 });
    expect(range.lowUsd).toBe(range.anchorUsd);
    expect(range.highUsd).toBe(range.anchorUsd);
  });
});

describe("tokenUnitsToWeiFloor", () => {
  it("converts base units to wei, rounding down", () => {
    expect(tokenUnitsToWeiFloor(1_500_000n, { tokenValueInWei: 10n ** 18n, tokenDecimals: 6 })).toBe(1_500_000n * 10n ** 12n);
    expect(tokenUnitsToWeiFloor(1n, { tokenValueInWei: 1n, tokenDecimals: 6 })).toBe(0n);
  });

  it("refuses negative units and a missing price", () => {
    expect(() => tokenUnitsToWeiFloor(-1n, { tokenValueInWei: 1n, tokenDecimals: 6 })).toThrow(RangeError);
    expect(() => tokenUnitsToWeiFloor(1n, { tokenValueInWei: 0n, tokenDecimals: 6 })).toThrow(RangeError);
  });
});

describe("gasPriceBasisFor", () => {
  it("reads the whole gas price on a chain with no base fee, else the base fee only", () => {
    expect(gasPriceBasisFor("none")).toBe("transaction");
    expect(gasPriceBasisFor("reported")).toBe("base-fee-only");
    expect(gasPriceBasisFor(undefined)).toBe("base-fee-only");
  });
});
