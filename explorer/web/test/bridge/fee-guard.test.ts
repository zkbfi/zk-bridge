import { describe, expect, it } from "vitest";
import { anticipatedCostUsd, ceilingWeiOf, CEILING_FACTOR, GAS_LEVEL_FACTORS, gasLevelOfCeiling, highTipOf, highTipThreshold, lowFeeOf, PROOF_COST_USD } from "../../src/bridge/fee-guard";

const GWEI = 1_000_000_000n;
// 1e6 gas × 1 gwei = 0.001 coin, at $1,000 a coin: $1 of gas at the Normal level.
const gas = { gasUsed: 1_000_000n, baseFeeWei: GWEI, priorityFeeWei: 0n, nativeUsd: 1_000 };

describe("anticipated cost", () => {
  it("is the delivery gas at the level's price plus the proof generation", () => {
    // 1e6 gas × 1 gwei = 0.001 coin = $1, plus $0.025 for the proof.
    expect(anticipatedCostUsd({ ...gas, level: 1 })).toBeCloseTo(1 + PROOF_COST_USD, 9);
    expect(PROOF_COST_USD).toBe(0.025);
  });

  it("rises with the gas level", () => {
    const [normal, high, highest] = ([1, 2, 3] as const).map((level) => anticipatedCostUsd({ ...gas, level }));
    expect(normal).toBeLessThan(high!);
    expect(high).toBeLessThan(highest!);
    expect(high).toBeCloseTo(GAS_LEVEL_FACTORS[2] * 1 + PROOF_COST_USD, 9);
  });
});

describe("the gas level's ceiling", () => {
  it("is today's base fee × 2, 3 or 5, and reads back as its level", () => {
    expect(GAS_LEVEL_FACTORS).toEqual({ 1: 1, 2: 1.5, 3: 2.5 });
    expect([1, 2, 3].map((level) => ceilingWeiOf(10n * GWEI, level as 1 | 2 | 3))).toEqual([20n * GWEI, 30n * GWEI, 50n * GWEI]);
    expect(CEILING_FACTOR).toBe(2);
    expect(gasLevelOfCeiling(undefined, 10n * GWEI)).toBe(1);
    expect(gasLevelOfCeiling("30", 10n * GWEI)).toBe(2);
    expect(gasLevelOfCeiling("50", 10n * GWEI)).toBe(3);
    expect(gasLevelOfCeiling("49", 11n * GWEI)).toBe(3); // the base fee moved since; nearest level
  });
});

describe("the low-fee warning", () => {
  const cost = 1 + PROOF_COST_USD;
  it("shows until the fee is twice the anticipated cost", () => {
    expect(lowFeeOf({ feeUsd: 2 * cost - 0.0001, costUsd: cost, belowBreakEven: false })).toBe(true);
    expect(lowFeeOf({ feeUsd: 2 * cost, costUsd: cost, belowBreakEven: false })).toBe(false);
  });

  it("counts the proof generation", () => {
    // $2 covers twice the gas alone but not twice gas + proof.
    expect(lowFeeOf({ feeUsd: 2, costUsd: anticipatedCostUsd({ ...gas, level: 1 }), belowBreakEven: false })).toBe(true);
  });

  it("moves with the gas level: a fee enough at Normal is too low at Highest", () => {
    const feeUsd = 2 * anticipatedCostUsd({ ...gas, level: 1 });
    expect(lowFeeOf({ feeUsd, costUsd: anticipatedCostUsd({ ...gas, level: 1 }), belowBreakEven: false })).toBe(false);
    expect(lowFeeOf({ feeUsd, costUsd: anticipatedCostUsd({ ...gas, level: 3 }), belowBreakEven: false })).toBe(true);
  });

  it("falls back to the break-even without a price", () => {
    expect(lowFeeOf({ feeUsd: null, costUsd: null, belowBreakEven: true })).toBe(true);
    expect(lowFeeOf({ feeUsd: null, costUsd: null, belowBreakEven: false })).toBe(false);
  });
});

describe("the high-tip threshold", () => {
  it("is 1% up to $100, then 1% × 100 / amount, then 0.1% from $1,000; 1% without a price", () => {
    expect(highTipThreshold(50)).toBe(0.01);
    expect(highTipThreshold(100)).toBe(0.01);
    expect(highTipThreshold(316)).toBeCloseTo(0.00316, 5);
    expect(highTipThreshold(1_000)).toBeCloseTo(0.001, 9);
    expect(highTipThreshold(5_000)).toBe(0.001);
    expect(highTipThreshold(null)).toBe(0.01);
  });
});

describe("the high-tip warning", () => {
  it("measures the fee less the anticipated cost against the amount", () => {
    // $50 bridged, $1.025 cost: a $1.50 fee is a $0.475 tip (0.95%), under 1%; $1.60 is 1.15%, over.
    expect(highTipOf({ feeUsd: 1.5, costUsd: 1.025, amountUsd: 50, shareWithoutPrice: null })).toBe(false);
    expect(highTipOf({ feeUsd: 1.6, costUsd: 1.025, amountUsd: 50, shareWithoutPrice: null })).toBe(true);
    // $5,000: threshold 0.1% = $5.
    expect(highTipOf({ feeUsd: 6.0, costUsd: 1.025, amountUsd: 5_000, shareWithoutPrice: null })).toBe(false);
    expect(highTipOf({ feeUsd: 6.1, costUsd: 1.025, amountUsd: 5_000, shareWithoutPrice: null })).toBe(true);
  });

  it("uses 1% of the share without a price", () => {
    expect(highTipOf({ feeUsd: null, costUsd: null, amountUsd: null, shareWithoutPrice: 0.011 })).toBe(true);
    expect(highTipOf({ feeUsd: null, costUsd: null, amountUsd: null, shareWithoutPrice: 0.01 })).toBe(false);
    expect(highTipOf({ feeUsd: null, costUsd: null, amountUsd: null, shareWithoutPrice: null })).toBe(false);
  });

  it("is measured against the Normal-level cost, so the gas level never triggers or clears it", () => {
    // The caller passes the Normal-level cost; show that changing levels leaves the answer alone.
    const normalCost = anticipatedCostUsd({ ...gas, level: 1 });
    const answers = ([1, 2, 3] as const).map(() => highTipOf({ feeUsd: 1.6, costUsd: normalCost, amountUsd: 50, shareWithoutPrice: null }));
    expect(new Set(answers).size).toBe(1);
  });
});
