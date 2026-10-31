import { describe, expect, it } from "vitest";
import vectors from "./fixtures/fee-rules-vectors.json" with { type: "json" };
import {
  capWarns,
  ceilingCostUsd,
  ceilingWeiOf,
  COST_MARGIN,
  defaultCurveShareWad,
  defaultFee,
  DEFAULT_CAP_WAD,
  deliveryGasUsd,
  feeWarnings,
  GAS_LEVELS,
  gasLevelOfCeiling,
  highCap,
  highCapLine,
  lowFee,
  NO_PRICE_SHARE_WAD,
  PERCENT_WAD,
  WAD,
  PROOF_COST_USD,
  shareWadOfPercentText,
  smallTransfer,
  totalCostUsd,
  usdOf,
  type GasLevel,
} from "../src/fee-rules.js";

const USD = 10n ** 18n;
/** Micro-dollars as USD × 1e18, to keep the literals short. */
const micro = (value: bigint): bigint => value * 10n ** 12n;
const cents = (usd: bigint): string => `$${(Number(usd / 10n ** 16n) / 100).toFixed(2)}`;
/** Rounds micro-dollars to the nearest cent, half up, for comparing with the owner's two-decimal table. */
const nearestCent = (usd: bigint): string => cents(usd + 5n * 10n ** 15n);
const big = (text: string | null): bigint | null => (text === null ? null : BigInt(text));

describe("the constants", () => {
  it("are the owner's: $0.025 proof, 2× cost, 1% cap, 0.1% without a price, gas levels 2/3/5× and 1/1.5/2.5×", () => {
    expect(PROOF_COST_USD).toBe(25n * 10n ** 15n);
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
    const result = defaultFee({ amountUsd: BigInt(amount) * USD, costUsd: micro(BigInt(Math.round(cost * 1e6))), capWad: DEFAULT_CAP_WAD });
    expect(nearestCent(result.feeUsd!)).toBe(expected);
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
    expect(defaultFee({ amountUsd: 100n * USD, costUsd: micro(50_000n), capWad: DEFAULT_CAP_WAD }).binding).toBe("curve");
    expect(defaultFee({ amountUsd: 200n * USD, costUsd: micro(525_000n), capWad: DEFAULT_CAP_WAD })).toEqual({ binding: "cost", feeUsd: micro(1_050_000n), shareWad: 5_250_000_000_000_000n });
    expect(defaultFee({ amountUsd: 25n * USD, costUsd: micro(125_000n), capWad: PERCENT_WAD / 2n })).toEqual({ binding: "cap", feeUsd: micro(125_000n), shareWad: PERCENT_WAD / 2n });
  });

  it("adds a higher gas level's extra cost on top of the curve, so the fee rises with the level; the floor and the cap still hold", () => {
    // $50: the curve is about $0.1939; at High the cost is $0.0375 against $0.025 at Normal, an extra $0.0125.
    const normal = defaultFee({ amountUsd: 50n * USD, costUsd: micro(25_000n), capWad: DEFAULT_CAP_WAD });
    const high = defaultFee({ amountUsd: 50n * USD, costUsd: micro(37_500n), capWad: DEFAULT_CAP_WAD, levelExtraUsd: micro(12_500n) });
    expect(high.binding).toBe("curve");
    expect(high.feeUsd).toBe(normal.feeUsd! + micro(12_500n));
    expect(high.shareWad).toBe((high.feeUsd! * WAD) / (50n * USD));
    expect(defaultFee({ amountUsd: 50n * USD, costUsd: micro(25_000n), capWad: DEFAULT_CAP_WAD, levelExtraUsd: 0n })).toEqual(normal);
    // Twice the cost still wins when it is larger, and the cap still binds.
    expect(defaultFee({ amountUsd: 2_000n * USD, costUsd: micro(7_500_000n), capWad: DEFAULT_CAP_WAD, levelExtraUsd: micro(2_500_000n) })).toEqual({ binding: "cost", feeUsd: micro(15_000_000n), shareWad: 7_500_000_000_000_000n });
    expect(defaultFee({ amountUsd: 50n * USD, costUsd: micro(37_500n), capWad: PERCENT_WAD / 4n, levelExtraUsd: micro(12_500n) }).binding).toBe("cap");
  });

  it("is 0.1% (or the cap when lower) without a price or an amount", () => {
    expect(defaultFee({ amountUsd: null, costUsd: micro(50_000n), capWad: DEFAULT_CAP_WAD })).toEqual({ binding: "no-price", feeUsd: null, shareWad: NO_PRICE_SHARE_WAD });
    expect(defaultFee({ amountUsd: 100n * USD, costUsd: null, capWad: PERCENT_WAD / 20n })).toEqual({ binding: "no-price", feeUsd: null, shareWad: PERCENT_WAD / 20n });
    expect(defaultFee({ amountUsd: micro(0n), costUsd: micro(50_000n), capWad: DEFAULT_CAP_WAD }).binding).toBe("no-price");
  });
});

describe("the total cost", () => {
  const gas = { gasUsed: 1_000_000n, baseFeeWei: 1_000_000_000n, priorityFeeWei: 0n, nativePriceE18: 1_000n * 10n ** 18n };
  it("is the full cost, the $0.025 proof plus the delivery gas, times the level's expected multiple (1×, 1.5×, 2.5×)", () => {
    // 1e6 gas × 1 gwei = 0.001 coin at $1,000 = $1 of gas; + $0.025 proof = $1.025 at Normal.
    expect(([1, 2, 3] as GasLevel[]).map((level) => deliveryGasUsd({ ...gas, level }))).toEqual([micro(1_000_000n), micro(1_000_000n), micro(1_000_000n)]);
    expect(([1, 2, 3] as GasLevel[]).map((level) => totalCostUsd({ ...gas, level }))).toEqual([micro(1_025_000n), micro(1_537_500n), micro(2_562_500n)]);
  });

  it("moves with the level even where gas is nearly free: the proof is multiplied too", () => {
    const free = { ...gas, baseFeeWei: 7n, priorityFeeWei: 0n };
    expect(([1, 2, 3] as GasLevel[]).map((level) => totalCostUsd({ ...free, level }))).toEqual([micro(25_000n) + 7_000_000_000n, (3n * (micro(25_000n) + 7_000_000_000n)) / 2n, (5n * (micro(25_000n) + 7_000_000_000n)) / 2n]);
  });

  it("adds the priority fee to the base fee and rounds down", () => {
    expect(deliveryGasUsd({ ...gas, priorityFeeWei: 1_000_000_000n, level: 2 })).toBe(micro(2_000_000n));
    expect(deliveryGasUsd({ ...gas, gasUsed: 1n, nativePriceE18: 1n, level: 1 })).toBe(0n);
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
  it("is units × price ÷ 10^decimals, in USD × 1e18, rounded down", () => {
    expect(usdOf(1_500_000n, 6, 10n ** 18n)).toBe(micro(1_500_000n));
    expect(usdOf(10n ** 18n, 18, 56_200_000_000_000n)).toBe(56_200_000_000_000n); // 1 PLS at $0.0000562, no precision lost
    expect(usdOf(1n, 18, 1n)).toBe(0n);
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
    const base = { costNormalUsd: micro(1_025_000n), amountUsd: 50n * USD, shareWithoutPriceWad: null };
    expect(highCap({ ...base, feeUsd: micro(1_525_000n) })).toBe(false); // $0.50 tip is exactly 1%
    expect(highCap({ ...base, feeUsd: micro(1_525_001n) })).toBe(true);
    expect(highCap({ ...base, feeUsd: micro(100n) })).toBe(false); // under cost: no tip
    expect(highCap({ ...base, amountUsd: 500n * USD, feeUsd: micro(2_025_000n) })).toBe(false); // $1 tip in the middle zone
    expect(highCap({ ...base, amountUsd: 500n * USD, feeUsd: micro(2_025_001n) })).toBe(true);
  });

  it("reads the share against 1% without a price", () => {
    const base = { feeUsd: null, costNormalUsd: null, amountUsd: null };
    expect(highCap({ ...base, shareWithoutPriceWad: PERCENT_WAD + 1n })).toBe(true);
    expect(highCap({ ...base, shareWithoutPriceWad: PERCENT_WAD })).toBe(false);
    expect(highCap({ ...base, shareWithoutPriceWad: null })).toBe(false);
  });
});

describe("small transfers", () => {
  it("warn when the total cost is more than the cap's share of the amount, and the line moves with the cap", () => {
    expect(smallTransfer({ costUsd: micro(50_000n), amountUsd: 5n * USD, capWad: DEFAULT_CAP_WAD })).toBe(false); // exactly 1%
    expect(smallTransfer({ costUsd: micro(50_001n), amountUsd: 5n * USD, capWad: DEFAULT_CAP_WAD })).toBe(true);
    expect(smallTransfer({ costUsd: micro(50_000n), amountUsd: 8n * USD, capWad: PERCENT_WAD / 2n })).toBe(true); // 0.625% > 0.5%
    expect(smallTransfer({ costUsd: micro(50_000n), amountUsd: 8n * USD, capWad: DEFAULT_CAP_WAD })).toBe(false);
    expect(smallTransfer({ costUsd: null, amountUsd: 8n * USD, capWad: DEFAULT_CAP_WAD })).toBe(false);
    expect(smallTransfer({ costUsd: micro(1n), amountUsd: null, capWad: DEFAULT_CAP_WAD })).toBe(false);
  });
});

describe("the low-fee warning", () => {
  it("shows until the fee is twice the total cost, else falls back to the bots' break-even", () => {
    expect(lowFee({ feeUsd: micro(2_049_999n), costUsd: micro(1_025_000n), belowBreakEven: false })).toBe(true);
    expect(lowFee({ feeUsd: micro(2_050_000n), costUsd: micro(1_025_000n), belowBreakEven: true })).toBe(false);
    expect(lowFee({ feeUsd: null, costUsd: micro(1n), belowBreakEven: true })).toBe(true);
    expect(lowFee({ feeUsd: micro(1n), costUsd: null, belowBreakEven: false })).toBe(false);
  });
});

describe("the cap warning (owner, quotes 70-71)", () => {
  const gas = { gasUsed: 1_000_000n, baseFeeWei: 1_000_000_000n, priorityFeeWei: 0n, nativePriceE18: 1_000n * 10n ** 18n };
  it("reads the cost at the level's ceiling: the proof plus gas at 2x, 3x or 5x the base fee", () => {
    expect(([1, 2, 3] as GasLevel[]).map((level) => ceilingCostUsd({ ...gas, level }))).toEqual([micro(2_025_000n), micro(3_025_000n), micro(5_025_000n)]);
    expect(ceilingCostUsd({ ...gas, priorityFeeWei: 1_000_000_000n, level: 1 })).toBe(micro(3_025_000n));
  });
  it("does not warn in the owner's example: $500, cost $0.05, Normal ceiling gives $0.075, fee $0.50 keeps $0.45 under $1", () => {
    expect(capWarns({ gasBased: true, amountUsd: 500n * USD, capWad: DEFAULT_CAP_WAD, expandedCostUsd: micro(75_000n), costNormalUsd: micro(50_000n) })).toBe(false);
  });
  it("warns in gas-based mode when the fee at the expanded cost, capped, would leave more than the line", () => {
    // $500 at Highest with $2 of gas at Normal: expanded $10.025, fee max($0.50, $20.05) capped at $5, leaves $2.975 > $1.
    expect(capWarns({ gasBased: true, amountUsd: 500n * USD, capWad: DEFAULT_CAP_WAD, expandedCostUsd: micro(10_025_000n), costNormalUsd: micro(2_025_000n) })).toBe(true);
    // A lower cap pulls it back under the line: 0.5% = $2.50 leaves $0.475.
    expect(capWarns({ gasBased: true, amountUsd: 500n * USD, capWad: PERCENT_WAD / 2n, expandedCostUsd: micro(10_025_000n), costNormalUsd: micro(2_025_000n) })).toBe(false);
  });
  it("never warns for percent or fixed fees, or without prices", () => {
    expect(capWarns({ gasBased: false, amountUsd: 500n * USD, capWad: DEFAULT_CAP_WAD, expandedCostUsd: micro(10_025_000n), costNormalUsd: micro(2_025_000n) })).toBe(false);
    expect(capWarns({ gasBased: true, amountUsd: null, capWad: DEFAULT_CAP_WAD, expandedCostUsd: micro(10_025_000n), costNormalUsd: micro(2_025_000n) })).toBe(false);
    expect(capWarns({ gasBased: true, amountUsd: 500n * USD, capWad: DEFAULT_CAP_WAD, expandedCostUsd: null, costNormalUsd: micro(2_025_000n) })).toBe(false);
    expect(capWarns({ gasBased: true, amountUsd: 500n * USD, capWad: DEFAULT_CAP_WAD, expandedCostUsd: micro(10_025_000n), costNormalUsd: null })).toBe(false);
  });
});

describe("the warnings together", () => {
  it("suppress High cap % and the cap warning in the small-transfer zone", () => {
    const result = feeWarnings({
      amountUsd: 5n * USD,
      capWad: DEFAULT_CAP_WAD,
      feeUsd: 2n * USD,
      costUsd: micro(100_000n),
      costNormalUsd: micro(100_000n),
      shareWithoutPriceWad: null,
      belowBreakEven: false,
      gasBased: true,
      expandedCostUsd: 3n * USD,
    });
    expect(result).toEqual({ smallTransfer: true, lowFee: false, highCap: false, capWarning: false });
  });
});

/** The fixed vectors in fixtures/fee-rules-vectors.json, which any SDK user can run against their build. */
describe("the fixed vectors", () => {
  it("describe their units and rounding", () => {
    expect(vectors.about).toMatch(/1e18/);
    expect(vectors.rounding).toMatch(/down/);
  });
  it.each(vectors.usdOf)("usdOf $input", ({ input, output }) => {
    expect(usdOf(BigInt(input.units), input.decimals, BigInt(input.priceE18))).toBe(BigInt(output));
  });
  it.each(vectors.totalCostUsd)("totalCostUsd $input", ({ input, output }) => {
    expect(totalCostUsd({ gasUsed: BigInt(input.gasUsed), baseFeeWei: BigInt(input.baseFeeWei), priorityFeeWei: BigInt(input.priorityFeeWei), nativePriceE18: BigInt(input.nativePriceE18), level: input.level as GasLevel })).toBe(BigInt(output));
  });
  it.each(vectors.ceilingWeiOf)("ceilingWeiOf $input", ({ input, output }) => {
    expect(ceilingWeiOf(BigInt(input.baseFeeWei), input.level as GasLevel)).toBe(BigInt(output));
  });
  it.each(vectors.gasLevelOfCeiling)("gasLevelOfCeiling $input", ({ input, output }) => {
    expect(gasLevelOfCeiling(big(input.ceilingWei), big(input.baseFeeWei))).toBe(output);
  });
  it.each(vectors.defaultCurveShareWad)("defaultCurveShareWad $input", ({ input, output }) => {
    expect(defaultCurveShareWad(BigInt(input.amountUsd))).toBe(BigInt(output));
  });
  it.each(vectors.defaultFee)("defaultFee $input", ({ input, output }) => {
    const result = defaultFee({ amountUsd: big(input.amountUsd), costUsd: big(input.costUsd), capWad: BigInt(input.capWad) });
    expect({ binding: result.binding, shareWad: String(result.shareWad), feeUsd: result.feeUsd === null ? null : String(result.feeUsd) }).toEqual(output);
  });
  it.each(vectors.highCap)("highCap $input", ({ input, output }) => {
    expect(highCap({ feeUsd: big(input.feeUsd), costNormalUsd: big(input.costNormalUsd), amountUsd: big(input.amountUsd), shareWithoutPriceWad: big(input.shareWithoutPriceWad) })).toBe(output);
  });
  it.each(vectors.smallTransfer)("smallTransfer $input", ({ input, output }) => {
    expect(smallTransfer({ costUsd: big(input.costUsd), amountUsd: big(input.amountUsd), capWad: BigInt(input.capWad) })).toBe(output);
  });
  it.each(vectors.lowFee)("lowFee $input", ({ input, output }) => {
    expect(lowFee({ feeUsd: big(input.feeUsd), costUsd: big(input.costUsd), belowBreakEven: input.belowBreakEven })).toBe(output);
  });
  it.each(vectors.feeWarnings)("feeWarnings $input", ({ input, output }) => {
    expect(
      feeWarnings({
        amountUsd: big(input.amountUsd),
        capWad: BigInt(input.capWad),
        feeUsd: big(input.feeUsd),
        costUsd: big(input.costUsd),
        costNormalUsd: big(input.costNormalUsd),
        shareWithoutPriceWad: big(input.shareWithoutPriceWad),
        belowBreakEven: input.belowBreakEven,
        gasBased: input.gasBased,
        expandedCostUsd: big(input.expandedCostUsd),
      }),
    ).toEqual(output);
  });
  it.each(vectors.ceilingCostUsd)("ceilingCostUsd $input", ({ input, output }) => {
    expect(ceilingCostUsd({ gasUsed: BigInt(input.gasUsed), baseFeeWei: BigInt(input.baseFeeWei), priorityFeeWei: BigInt(input.priorityFeeWei), nativePriceE18: BigInt(input.nativePriceE18), level: input.level as GasLevel })).toBe(BigInt(output));
  });
  it.each(vectors.capWarns)("capWarns $input", ({ input, output }) => {
    expect(capWarns({ gasBased: input.gasBased, amountUsd: big(input.amountUsd), capWad: BigInt(input.capWad), expandedCostUsd: big(input.expandedCostUsd), costNormalUsd: big(input.costNormalUsd) })).toBe(output);
  });
});
