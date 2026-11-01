import { describe, expect, it } from "vitest";
import { RATE_SCALE, formatDuration, formatRate, formatTokenAmount, parseTokenAmount } from "../src/format.js";

describe("formatTokenAmount", () => {
  it("formats without floating point error beyond 2^53", () => {
    expect(formatTokenAmount(123456789012345678901234567890n, 18)).toBe("123456789012.34567890123456789");
  });
  it("cuts and never rounds", () => {
    expect(formatTokenAmount(1999999n, 6, { fractionDigits: 2 })).toBe("1.99");
  });
  it("drops trailing zeros and handles zero decimals", () => {
    expect(formatTokenAmount(1500000n, 6)).toBe("1.5");
    expect(formatTokenAmount(42n, 0)).toBe("42");
    expect(formatTokenAmount(0n, 18)).toBe("0");
  });
  it("pads small values", () => {
    expect(formatTokenAmount(1n, 18)).toBe("0.000000000000000001");
  });
  it("groups thousands", () => {
    expect(formatTokenAmount(1234567n * 10n ** 6n, 6, { thousandsSeparator: "," })).toBe("1,234,567");
  });
  it("rejects bad decimals", () => {
    expect(() => formatTokenAmount(1n, -1)).toThrow();
    expect(() => formatTokenAmount(1n, 1.5)).toThrow();
  });
});

describe("parseTokenAmount", () => {
  it("round trips with formatting", () => {
    expect(parseTokenAmount("1.5", 6)).toBe(1_500_000n);
    expect(formatTokenAmount(parseTokenAmount("0.000000000000000001", 18), 18)).toBe("0.000000000000000001");
  });
  it("reads a whole number with no fraction", () => {
    expect(parseTokenAmount("2", 6)).toBe(2_000_000n);
  });
  it("refuses more fraction digits than the token has", () => {
    expect(() => parseTokenAmount("1.1234567", 6)).toThrow(/fraction digits/);
  });
  it("refuses text that is not a decimal", () => {
    expect(() => parseTokenAmount("1e3", 6)).toThrow();
    expect(() => parseTokenAmount("-1", 6)).toThrow();
  });
});

describe("rates scaled by 1e18", () => {
  it("shows 1e18 as 100 percent", () => {
    expect(formatRate(RATE_SCALE)).toBe("100");
    expect(formatRate(RATE_SCALE / 1000n)).toBe("0.1");
  });
});

describe("formatDuration", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatDuration(5)).toBe("5s");
    expect(formatDuration(185)).toBe("3m 05s");
    expect(formatDuration(7500)).toBe("2h 05m");
    expect(formatDuration(-4)).toBe("0s");
  });
});

describe("formatTokenAmount with a negative value", () => {
  it("puts the sign in front of the grouped integer and the fraction", () => {
    expect(formatTokenAmount(-1_234_500_000n, 6, { thousandsSeparator: "," })).toBe("-1,234.5");
  });
});
