import { describe, expect, it } from "vitest";
import vectors from "./fixtures/fee-rules-vectors.json" with { type: "json" };
import {
  capWarns,
  ceilingCostMicroUsd,
  ceilingWeiOf,
  COST_MARGIN,
  defaultCurveShareWad,
  defaultFee,
  DEFAULT_CAP_WAD,
  deliveryGasMicroUsd,
  feeWarnings,
  GAS_LEVELS,
  gasLevelOfCeiling,
  highCap,
  highCapLine,
  lowFee,
  NO_PRICE_SHARE_WAD,
  PERCENT_WAD,
  PROOF_COST_MICRO_USD,
  shareWadOfPercentText,
  smallTransfer,
  totalCostMicroUsd,
  usdMicroOf,
  type GasLevel,
} from "../src/fee-rules.js";

const USD = 1_000_000n;
const cents = (micro: bigint): string => `$${(Number(micro / 10_000n) / 100).toFixed(2)}`;
/** Rounds micro-dollars to the nearest cent, half up, for comparing with the owner's two-decimal table. */
const nearestCent = (micro: bigint): string => cents(micro + 5_000n);
const big = (text: string | null): bigint | null => (text === null ? null : BigInt(text));

describe("the constants", () => {
  it("are the owner's: $0.025 proof, 2× cost, 1% cap, 0.1% without a price, gas levels 2/3/5× and 1/1.5/2.5×", () => {
    expect(PROOF_COST_MICRO_USD).toBe(25_000n);
    expect(COST_MARGIN).toBe(2n);
    expect(PERCENT_WAD).toBe(10n ** 16n);
    expect(DEFAULT_CAP_WAD).toBe(PERCENT_WAD);
    expect(NO_PRICE_SHARE_WAD).toBe(PERCENT_WAD / 10n);
    expect(GAS_LEVELS).toEqual({ 1: { ceilingFactor: 2n, expectedHalves: 2n }, 2: { ceilingFactor: 3n, expectedHalves: 3n }, 3: { ceilingFactor: 5n, expectedHalves: 5n } });
  });
});

describe("the default fee curve: the owner's reference table", () => {
  const table: readonly [number, number, string][] = [
    [0.05, 10, "$0.10"],
    [0.05, 20, "$0.13"],
    [0.05, 50, "$0.19"],
    [0.05, 100, "$0.26"],
    [0.05, 200, "$0.34"],
    [0.05, 500, "$0.50"],
    [0.05, 1_000, "$1.00"],
    [0.525, 200, "$1.05"],
    [0.525, 500, "$1.05"],
    [0.525, 1_000, "$1.05"],
    [0.525, 2_000, "$2.00"],
    [0.125, 25, "$0.25"],
    [0.125, 50, "$0.25"],
    [0.125, 100, "$0.26"],
  ];
  it.each(table)("cost $%s, amount $%s → %s", (cost, amount, expected) => {
    const result = defaultFee({ amountMicroUsd: BigInt(amount) * USD, costMicroUsd: BigInt(Math.round(cost * 1e6)), capWad: DEFAULT_CAP_WAD });
    expect(nearestCent(result.feeMicroUsd!)).toBe(expected);
  });

  it("is 1% below $10 and 0.1% from $500, and slides monotonically between", () => {
    expect(defaultCurveShareWad(5n * USD)).toBe(PERCENT_WAD);
    expect(defaultCurveShareWad(10n * USD)).toBe(PERCENT_WAD);
    expect(defaultCurveShareWad(500n * USD)).toBe(PERCENT_WAD / 10n);
    expect(defaultCurveShareWad(10_000n * USD)).toBe(PERCENT_WAD / 10n);
    let previous = PERCENT_WAD;
    for (let dollars = 11n; dollars < 500n; dollars += 7n) {
      const share = defaultCurveShareWad(dollars * USD);
      expect(share).toBeLessThan(previous);
      previous = share;
    }
    expect(previous).toBeGreaterThan(PERCENT_WAD / 10n);
  });

  it("says which term bound and gives the share to sign", () => {
    expect(defaultFee({ amountMicroUsd: 100n * USD, costMicroUsd: 50_000n, capWad: DEFAULT_CAP_WAD }).binding).toBe("curve");
    expect(defaultFee({ amountMicroUsd: 200n * USD, costMicroUsd: 525_000n, capWad: DEFAULT_CAP_WAD })).toEqual({ binding: "cost", feeMicroUsd: 1_050_000n, shareWad: 5_250_000_000_000_000n });
    expect(defaultFee({ amountMicroUsd: 25n * USD, costMicroUsd: 125_000n, capWad: PERCENT_WAD / 2n })).toEqual({ binding: "cap", feeMicroUsd: 125_000n, shareWad: PERCENT_WAD / 2n });
  });

  it("is 0.1% (or the cap when lower) without a price or an amount", () => {
    expect(defaultFee({ amountMicroUsd: null, costMicroUsd: 50_000n, capWad: DEFAULT_CAP_WAD })).toEqual({ binding: "no-price", feeMicroUsd: null, shareWad: NO_PRICE_SHARE_WAD });
    expect(defaultFee({ amountMicroUsd: 100n * USD, costMicroUsd: null, capWad: PERCENT_WAD / 20n })).toEqual({ binding: "no-price", feeMicroUsd: null, shareWad: PERCENT_WAD / 20n });
    expect(defaultFee({ amountMicroUsd: 0n, costMicroUsd: 50_000n, capWad: DEFAULT_CAP_WAD }).binding).toBe("no-price");
  });
});

describe("the total cost", () => {
  const gas = { gasUsed: 1_000_000n, baseFeeWei: 1_000_000_000n, priorityFeeWei: 0n, nativePriceE18: 1_000n * 10n ** 18n };
  it("is the $0.025 proof plus the delivery gas at the level's expected price (1×, 1.5×, 2.5× the base fee)", () => {
    // 1e6 gas × 1 gwei = 0.001 coin at $1,000 = $1 at Normal.
    expect(([1, 2, 3] as GasLevel[]).map((level) => deliveryGasMicroUsd({ ...gas, level }))).toEqual([1_000_000n, 1_500_000n, 2_500_000n]);
    expect(totalCostMicroUsd({ ...gas, level: 1 })).toBe(1_025_000n);
  });

  it("adds the priority fee once, at every level, and rounds down", () => {
    expect(deliveryGasMicroUsd({ ...gas, priorityFeeWei: 1_000_000_000n, level: 2 })).toBe(2_500_000n);
    expect(deliveryGasMicroUsd({ ...gas, gasUsed: 1n, nativePriceE18: 1n, level: 1 })).toBe(0n);
  });
});

describe("gas levels and the ceiling", () => {
  it("write a ceiling of 2×, 3× or 5× today's base fee and read back as the nearest level, ties to the lower", () => {
    expect(([1, 2, 3] as GasLevel[]).map((level) => ceilingWeiOf(10n, level))).toEqual([20n, 30n, 50n]);
    expect(gasLevelOfCeiling(null, 10n)).toBe(1);
    expect(gasLevelOfCeiling(30n, null)).toBe(1);
    expect(gasLevelOfCeiling(30n, 0n)).toBe(1);
    expect(gasLevelOfCeiling(30n, 10n)).toBe(2);
    expect(gasLevelOfCeiling(49n, 11n)).toBe(3);
    expect(gasLevelOfCeiling(25n, 10n)).toBe(1); // halfway between 20 and 30
    expect(gasLevelOfCeiling(40n, 10n)).toBe(2); // halfway between 30 and 50
  });
});

describe("USD of an amount", () => {
  it("is units × price ÷ 10^decimals, in micro-dollars, rounded down", () => {
    expect(usdMicroOf(1_500_000n, 6, 10n ** 18n)).toBe(1_500_000n);
    expect(usdMicroOf(10n ** 18n, 18, 56_200_000_000_000n)).toBe(56n); // 1 PLS at $0.0000562
    expect(usdMicroOf(1n, 18, 10n ** 18n)).toBe(0n);
  });
});

describe("percent text", () => {
  it("parses exactly to an 18-decimal share and refuses what is not a percentage", () => {
    expect(shareWadOfPercentText("1")).toBe(PERCENT_WAD);
    expect(shareWadOfPercentText("0.05")).toBe(PERCENT_WAD / 20n);
    expect(shareWadOfPercentText(" .5% ")).toBe(PERCENT_WAD / 2n);
    expect(shareWadOfPercentText("abc")).toBeNull();
    expect(shareWadOfPercentText("0.00000000000000001")).toBeNull();
  });
});

describe("High cap %", () => {
  it("has a line of 1% up to $100, a $1 tip from $100 to $1,000, and 0.1% above; 1% without a price", () => {
    expect(highCapLine(50n * USD)).toEqual({ numerator: 1n, denominator: 100n });
    expect(highCapLine(100n * USD)).toEqual({ numerator: 1n, denominator: 100n });
    expect(highCapLine(316n * USD)).toEqual({ numerator: USD, denominator: 316n * USD });
    expect(highCapLine(1_000n * USD)).toEqual({ numerator: 1n, denominator: 1_000n });
    expect(highCapLine(null)).toEqual({ numerator: 1n, denominator: 100n });
  });

  it("reads the tip before gas: the fee less the Normal-level cost", () => {
    const base = { costNormalMicroUsd: 1_025_000n, amountMicroUsd: 50n * USD, shareWithoutPriceWad: null };
    expect(highCap({ ...base, feeMicroUsd: 1_525_000n })).toBe(false); // $0.50 tip is exactly 1%
    expect(highCap({ ...base, feeMicroUsd: 1_525_001n })).toBe(true);
    expect(highCap({ ...base, feeMicroUsd: 100n })).toBe(false); // under cost: no tip
    expect(highCap({ ...base, amountMicroUsd: 500n * USD, feeMicroUsd: 2_025_000n })).toBe(false); // $1 tip in the middle zone
    expect(highCap({ ...base, amountMicroUsd: 500n * USD, feeMicroUsd: 2_025_001n })).toBe(true);
  });

  it("reads the share against 1% without a price", () => {
    const base = { feeMicroUsd: null, costNormalMicroUsd: null, amountMicroUsd: null };
    expect(highCap({ ...base, shareWithoutPriceWad: PERCENT_WAD + 1n })).toBe(true);
    expect(highCap({ ...base, shareWithoutPriceWad: PERCENT_WAD })).toBe(false);
    expect(highCap({ ...base, shareWithoutPriceWad: null })).toBe(false);
  });
});

describe("small transfers", () => {
  it("warn when the total cost is more than the cap's share of the amount, and the line moves with the cap", () => {
    expect(smallTransfer({ costMicroUsd: 50_000n, amountMicroUsd: 5n * USD, capWad: DEFAULT_CAP_WAD })).toBe(false); // exactly 1%
    expect(smallTransfer({ costMicroUsd: 50_001n, amountMicroUsd: 5n * USD, capWad: DEFAULT_CAP_WAD })).toBe(true);
    expect(smallTransfer({ costMicroUsd: 50_000n, amountMicroUsd: 8n * USD, capWad: PERCENT_WAD / 2n })).toBe(true); // 0.625% > 0.5%
    expect(smallTransfer({ costMicroUsd: 50_000n, amountMicroUsd: 8n * USD, capWad: DEFAULT_CAP_WAD })).toBe(false);
    expect(smallTransfer({ costMicroUsd: null, amountMicroUsd: 8n * USD, capWad: DEFAULT_CAP_WAD })).toBe(false);
    expect(smallTransfer({ costMicroUsd: 1n, amountMicroUsd: null, capWad: DEFAULT_CAP_WAD })).toBe(false);
  });
});

describe("the low-fee warning", () => {
  it("shows until the fee is twice the total cost, else falls back to the bots' break-even", () => {
    expect(lowFee({ feeMicroUsd: 2_049_999n, costMicroUsd: 1_025_000n, belowBreakEven: false })).toBe(true);
    expect(lowFee({ feeMicroUsd: 2_050_000n, costMicroUsd: 1_025_000n, belowBreakEven: true })).toBe(false);
    expect(lowFee({ feeMicroUsd: null, costMicroUsd: 1n, belowBreakEven: true })).toBe(true);
    expect(lowFee({ feeMicroUsd: 1n, costMicroUsd: null, belowBreakEven: false })).toBe(false);
  });
});

describe("the cap warning (owner, quotes 70-71)", () => {
  const gas = { gasUsed: 1_000_000n, baseFeeWei: 1_000_000_000n, priorityFeeWei: 0n, nativePriceE18: 1_000n * 10n ** 18n };
  it("reads the cost at the level's ceiling: the proof plus gas at 2x, 3x or 5x the base fee", () => {
    expect(([1, 2, 3] as GasLevel[]).map((level) => ceilingCostMicroUsd({ ...gas, level }))).toEqual([2_025_000n, 3_025_000n, 5_025_000n]);
    expect(ceilingCostMicroUsd({ ...gas, priorityFeeWei: 1_000_000_000n, level: 1 })).toBe(3_025_000n);
  });
  it("does not warn in the owner's example: $500, cost $0.05, Normal ceiling gives $0.075, fee $0.50 keeps $0.45 under $1", () => {
    expect(capWarns({ gasBased: true, amountMicroUsd: 500n * USD, capWad: DEFAULT_CAP_WAD, expandedCostMicroUsd: 75_000n, costNormalMicroUsd: 50_000n })).toBe(false);
  });
  it("warns in gas-based mode when the fee at the expanded cost, capped, would leave more than the line", () => {
    // $500 at Highest with $2 of gas at Normal: expanded $10.025, fee max($0.50, $20.05) capped at $5, leaves $2.975 > $1.
    expect(capWarns({ gasBased: true, amountMicroUsd: 500n * USD, capWad: DEFAULT_CAP_WAD, expandedCostMicroUsd: 10_025_000n, costNormalMicroUsd: 2_025_000n })).toBe(true);
    // A lower cap pulls it back under the line: 0.5% = $2.50 leaves $0.475.
    expect(capWarns({ gasBased: true, amountMicroUsd: 500n * USD, capWad: PERCENT_WAD / 2n, expandedCostMicroUsd: 10_025_000n, costNormalMicroUsd: 2_025_000n })).toBe(false);
  });
  it("never warns for percent or fixed fees, or without prices", () => {
    expect(capWarns({ gasBased: false, amountMicroUsd: 500n * USD, capWad: DEFAULT_CAP_WAD, expandedCostMicroUsd: 10_025_000n, costNormalMicroUsd: 2_025_000n })).toBe(false);
    expect(capWarns({ gasBased: true, amountMicroUsd: null, capWad: DEFAULT_CAP_WAD, expandedCostMicroUsd: 10_025_000n, costNormalMicroUsd: 2_025_000n })).toBe(false);
    expect(capWarns({ gasBased: true, amountMicroUsd: 500n * USD, capWad: DEFAULT_CAP_WAD, expandedCostMicroUsd: null, costNormalMicroUsd: 2_025_000n })).toBe(false);
    expect(capWarns({ gasBased: true, amountMicroUsd: 500n * USD, capWad: DEFAULT_CAP_WAD, expandedCostMicroUsd: 10_025_000n, costNormalMicroUsd: null })).toBe(false);
  });
});

describe("the warnings together", () => {
  it("suppress High cap % and the cap warning in the small-transfer zone", () => {
    const result = feeWarnings({
      amountMicroUsd: 5n * USD,
      capWad: DEFAULT_CAP_WAD,
      feeMicroUsd: 2n * USD,
      costMicroUsd: 100_000n,
      costNormalMicroUsd: 100_000n,
      shareWithoutPriceWad: null,
      belowBreakEven: false,
      gasBased: true,
      expandedCostMicroUsd: 3n * USD,
    });
    expect(result).toEqual({ smallTransfer: true, lowFee: false, highCap: false, capWarning: false });
  });
});

/** The fixed vectors in fixtures/fee-rules-vectors.json, which any SDK user can run against their build. */
describe("the fixed vectors", () => {
  it("describe their units and rounding", () => {
    expect(vectors.about).toMatch(/micro-dollars/);
    expect(vectors.rounding).toMatch(/down/);
  });
  it.each(vectors.usdMicroOf)("usdMicroOf $input", ({ input, output }) => {
    expect(usdMicroOf(BigInt(input.units), input.decimals, BigInt(input.priceE18))).toBe(BigInt(output));
  });
  it.each(vectors.totalCostMicroUsd)("totalCostMicroUsd $input", ({ input, output }) => {
    expect(totalCostMicroUsd({ gasUsed: BigInt(input.gasUsed), baseFeeWei: BigInt(input.baseFeeWei), priorityFeeWei: BigInt(input.priorityFeeWei), nativePriceE18: BigInt(input.nativePriceE18), level: input.level as GasLevel })).toBe(BigInt(output));
  });
  it.each(vectors.ceilingWeiOf)("ceilingWeiOf $input", ({ input, output }) => {
    expect(ceilingWeiOf(BigInt(input.baseFeeWei), input.level as GasLevel)).toBe(BigInt(output));
  });
  it.each(vectors.gasLevelOfCeiling)("gasLevelOfCeiling $input", ({ input, output }) => {
    expect(gasLevelOfCeiling(big(input.ceilingWei), big(input.baseFeeWei))).toBe(output);
  });
  it.each(vectors.defaultCurveShareWad)("defaultCurveShareWad $input", ({ input, output }) => {
    expect(defaultCurveShareWad(BigInt(input.amountMicroUsd))).toBe(BigInt(output));
  });
  it.each(vectors.defaultFee)("defaultFee $input", ({ input, output }) => {
    const result = defaultFee({ amountMicroUsd: big(input.amountMicroUsd), costMicroUsd: big(input.costMicroUsd), capWad: BigInt(input.capWad) });
    expect({ binding: result.binding, shareWad: String(result.shareWad), feeMicroUsd: result.feeMicroUsd === null ? null : String(result.feeMicroUsd) }).toEqual(output);
  });
  it.each(vectors.highCap)("highCap $input", ({ input, output }) => {
    expect(highCap({ feeMicroUsd: big(input.feeMicroUsd), costNormalMicroUsd: big(input.costNormalMicroUsd), amountMicroUsd: big(input.amountMicroUsd), shareWithoutPriceWad: big(input.shareWithoutPriceWad) })).toBe(output);
  });
  it.each(vectors.smallTransfer)("smallTransfer $input", ({ input, output }) => {
    expect(smallTransfer({ costMicroUsd: big(input.costMicroUsd), amountMicroUsd: big(input.amountMicroUsd), capWad: BigInt(input.capWad) })).toBe(output);
  });
  it.each(vectors.lowFee)("lowFee $input", ({ input, output }) => {
    expect(lowFee({ feeMicroUsd: big(input.feeMicroUsd), costMicroUsd: big(input.costMicroUsd), belowBreakEven: input.belowBreakEven })).toBe(output);
  });
  it.each(vectors.feeWarnings)("feeWarnings $input", ({ input, output }) => {
    expect(
      feeWarnings({
        amountMicroUsd: big(input.amountMicroUsd),
        capWad: BigInt(input.capWad),
        feeMicroUsd: big(input.feeMicroUsd),
        costMicroUsd: big(input.costMicroUsd),
        costNormalMicroUsd: big(input.costNormalMicroUsd),
        shareWithoutPriceWad: big(input.shareWithoutPriceWad),
        belowBreakEven: input.belowBreakEven,
        gasBased: input.gasBased,
        expandedCostMicroUsd: big(input.expandedCostMicroUsd),
      }),
    ).toEqual(output);
  });
  it.each(vectors.ceilingCostMicroUsd)("ceilingCostMicroUsd $input", ({ input, output }) => {
    expect(ceilingCostMicroUsd({ gasUsed: BigInt(input.gasUsed), baseFeeWei: BigInt(input.baseFeeWei), priorityFeeWei: BigInt(input.priorityFeeWei), nativePriceE18: BigInt(input.nativePriceE18), level: input.level as GasLevel })).toBe(BigInt(output));
  });
  it.each(vectors.capWarns)("capWarns $input", ({ input, output }) => {
    expect(capWarns({ gasBased: input.gasBased, amountMicroUsd: big(input.amountMicroUsd), capWad: BigInt(input.capWad), expandedCostMicroUsd: big(input.expandedCostMicroUsd), costNormalMicroUsd: big(input.costNormalMicroUsd) })).toBe(output);
  });
});
