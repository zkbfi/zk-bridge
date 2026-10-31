import { describe, expect, it } from "vitest";
import { expNegScaled, FIXED_SCALE, LN2_SCALED, lnScaled } from "../src/fixed-point.js";

// Reference digits (36 after the point) from Python's decimal module at 60 digits.
const LN2 = 693147180559945309417232121458176568n;
const LN10 = 2302585092994045684017991454684364207n;

describe("fixed-point logarithm and exponential", () => {
  it("uses a 1e36 scale", () => {
    expect(FIXED_SCALE).toBe(10n ** 36n);
  });

  it("computes ln 2 and ln 10 to within 1000 units of the 36th decimal", () => {
    expect(LN2_SCALED - LN2).toBeGreaterThanOrEqual(-1000n);
    expect(LN2_SCALED - LN2).toBeLessThanOrEqual(0n);
    const ln10 = lnScaled(10n * FIXED_SCALE);
    expect(ln10 - LN10).toBeGreaterThanOrEqual(-1000n);
    expect(ln10 - LN10).toBeLessThanOrEqual(0n);
  });

  it("gives ln 1 = 0 exactly and refuses values under 1", () => {
    expect(lnScaled(FIXED_SCALE)).toBe(0n);
    expect(() => lnScaled(FIXED_SCALE - 1n)).toThrow(RangeError);
  });

  it("computes exp(-t): exp(0) = 1 exactly, exp(-ln 10) ≈ 0.1, and refuses negative t", () => {
    expect(expNegScaled(0n)).toBe(FIXED_SCALE);
    const tenth = expNegScaled(LN10);
    expect(FIXED_SCALE / 10n - tenth).toBeGreaterThanOrEqual(0n);
    expect(FIXED_SCALE / 10n - tenth).toBeLessThanOrEqual(1000n);
    expect(() => expNegScaled(-1n)).toThrow(RangeError);
  });

  it("is a pure function: the same input gives the same output", () => {
    expect(lnScaled(7n * FIXED_SCALE)).toBe(lnScaled(7n * FIXED_SCALE));
    expect(expNegScaled(3n * FIXED_SCALE)).toBe(expNegScaled(3n * FIXED_SCALE));
  });
});
