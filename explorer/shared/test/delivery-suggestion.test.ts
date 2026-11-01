import { describe, expect, it } from "vitest";
import { parseDeliveryCostReport, type DeliveryCostReport } from "../src/delivery-cost-report.js";
import { buildFeeSuggestions, DEFAULT_GAS_MARGIN, describeDataSource, describeFee, gasPriceBasisFor, SUGGESTED_TIP_RANGE, suggestedTipRange, tipVersusCost } from "../src/delivery-suggestion.js";
import { expectedFee, TOKEN_GAS_OVERHEAD } from "../src/delivery-terms.js";
import { EXCLUDE_PRIORITY, FIXED_FEE, UNWRAP } from "../src/delivery-terms.js";

const recipient = "0x00000000000000000000000000000000000000aa" as const;
const wei = 10n ** 18n;
const token = { symbol: "WPLS", decimals: 18, valueInWei: wei };

const kind = (overrides: Partial<DeliveryCostReport["kinds"]["token"]> = {}) => ({
  sampleCount: 0,
  averageGas: null,
  p90Gas: null,
  defaultGas: "550000",
  isDefault: true,
  ...overrides,
});

const report = (overrides: Partial<DeliveryCostReport> = {}): DeliveryCostReport =>
  parseDeliveryCostReport({
    chainId: 369,
    baseFee: { wei: "10000000000", blockNumber: 12, timestamp: 1_790_000_000 },
    kinds: {
      token_callback: kind({ sampleCount: 40, averageGas: "480000", p90Gas: "520000", isDefault: false }),
      token: kind(),
      message: kind(),
    },
    ...overrides,
  });

const base = { recipient, transferValue: 10n ** 24n, token, priorityFeeWei: 0n };

describe("the data source", () => {
  it("says measured, with the sample count and the statistic, when deliveries are recorded", () => {
    const source = describeDataSource(report(), "token_callback");
    expect(source.kind).toBe("measured");
    expect(source.description).toBe("measured from 40 recent deliveries, p90");
    expect(source.gas).toBe(520_000n);
    expect(source.baseFeeDescription).toBe("base fee 10 gwei at block 12 (2026-09-21T14:13:20.000Z)");
  });

  it("says default when nothing is measured", () => {
    const source = describeDataSource(report(), "message");
    expect(source.kind).toBe("default");
    expect(source.description).toBe("default, no deliveries measured yet");
    expect(source.gas).toBe(550_000n);
    expect(source.sampleCount).toBe(0);
  });

  it("improves with no code change: the same call uses the new samples", () => {
    const later = report({ kinds: { token_callback: kind({ sampleCount: 41, p90Gas: "530000", isDefault: false }), token: kind(), message: kind() } });
    expect(describeDataSource(later, "token_callback").gas).toBe(530_000n);
  });

  it("refuses a report with no base fee", () => {
    expect(() => describeDataSource(report({ baseFee: { wei: null, blockNumber: null, timestamp: null } }), "token")).toThrow(RangeError);
  });
});

describe("the suggestions", () => {
  it("marks percentage and fixed exact, and the gas multiplier an estimate with its maximum", () => {
    const suggestions = buildFeeSuggestions({ ...base, report: report() });
    if (suggestions.percentage.kind !== "available" || suggestions.fixed.kind !== "available" || suggestions.gasMultiplier.kind !== "available") {
      throw new Error("all three should be available");
    }
    expect(suggestions.percentage.description.certaintyLabel).toBe("exact");
    expect(suggestions.fixed.description.certaintyLabel).toBe("exact");
    const gas = suggestions.gasMultiplier.description;
    expect(gas.certainty).toBe("estimate");
    expect(gas.certaintyLabel).toBe("estimate, at most 0.0124 WPLS");
    expect(gas.amountText.startsWith("about ")).toBe(true);
    expect(gas.nowUnits).toBeLessThanOrEqual(gas.maximumUnits);
  });

  it("lists the gas cost and the margin as separate lines, all estimates, with no proof line", () => {
    const suggestions = buildFeeSuggestions({ ...base, report: report() });
    if (suggestions.percentage.kind !== "available") throw new Error("available");
    const lines = suggestions.percentage.description.breakdown;
    expect(lines.map((line) => line.id)).toEqual(["gas", "margin"]);
    expect(lines.every((line) => line.certainty === "estimate")).toBe(true);
    expect(lines[0]?.amountWei).toBe(520_000n * 10_000_000_000n);
    // The fee covers the cost, so the margin is not negative.
    expect(lines[1]?.amountWei).toBeGreaterThanOrEqual(0n);
    expect(suggestions.cost.totalWei).toBe(suggestions.cost.gasCostWei);
  });

  it("explains an unavailable suggestion instead of throwing", () => {
    const suggestions = buildFeeSuggestions({ ...base, transferValue: 1n, report: report() });
    expect(suggestions.percentage.kind).toBe("unavailable");
    expect(suggestions.fixed.kind).toBe("unavailable");
    if (suggestions.percentage.kind === "unavailable") expect(suggestions.percentage.reason).toContain("too small");
  });
});

describe("a gas based fee and the unit of the token", () => {
  const stable = { symbol: "USDC", decimals: 6, valueInWei: 5n * 10n ** 14n };

  it("is available for a token that is not the native coin, priced in token units from the sender's price", () => {
    const suggestions = buildFeeSuggestions({ ...base, transferValue: 10n ** 16n, token: stable, report: report() });
    if (suggestions.gasMultiplier.kind !== "available") throw new Error("available");
    // One USDC unit is worth 5e14 / 1e6 = 5e8 wei, so one wei is 1 / 5e8 units. The default margin is 1, the measured cost itself.
    expect(suggestions.gasMultiplier.director.multiplier).toBe((10n ** 18n) / (5n * 10n ** 8n));
    expect(suggestions.gasMultiplier.description.certainty).toBe("estimate");
    expect(suggestions.gasMultiplier.description.certaintyLabel).toMatch(/^estimate, at most [\d.]+ USDC$/);
    expect(suggestions.percentage.kind).toBe("available");
  });

  it("uses the price that the sender gives instead of the valuation of the token", () => {
    // The sender says one wei is worth 1 / 10^9 unit, so the multiplier is 1e18 / 1e9 = 1e9.
    const senderPrice = { numerator: 1n, denominator: 10n ** 9n };
    const suggestions = buildFeeSuggestions({ ...base, transferValue: 10n ** 16n, token: stable, report: report(), senderPrice });
    if (suggestions.gasMultiplier.kind !== "available") throw new Error("available");
    expect(suggestions.gasMultiplier.director.multiplier).toBe(1_000_000_000n);
  });
});

describe("describeFee", () => {
  const context = { transferValue: 1_000n, token: { symbol: "TKN", decimals: 0, valueInWei: wei }, gasUsed: 0n, baseFeeWei: 0n, priorityFeeWei: 0n, cost: null };

  it("states a fixed fee as exact", () => {
    const description = describeFee({ recipient, settings: FIXED_FEE, limit: 30n, multiplier: 0n, callGas: 0n }, context);
    expect(description.summary).toBe("30 TKN (exact)");
    expect(description.maximumUnits).toBe(30n);
    expect(description.breakdown).toEqual([]);
  });

  it("states a gas based fee as an estimate and shows the cap", () => {
    const description = describeFee(
      { recipient, settings: 0n, limit: 50n, multiplier: wei, callGas: 0n },
      { ...context, gasUsed: 100n, baseFeeWei: 1n },
    );
    expect(description.summary).toBe("about 50 TKN now (estimate, at most 50 TKN)");
  });
});

describe("the base fee note", () => {
  it("leaves out the time and the block when the report has none", () => {
    const source = describeDataSource(report({ baseFee: { wei: "10000000000", blockNumber: null, timestamp: null } }), "token");
    expect(source.baseFeeDescription).toBe("base fee 10 gwei");
  });

  it("leaves out only the block when only the block is missing, and only the time when only the time is missing", () => {
    expect(describeDataSource(report({ baseFee: { wei: "10000000000", blockNumber: null, timestamp: 1_790_000_000 } }), "token").baseFeeDescription).toBe(
      "base fee 10 gwei (2026-09-21T14:13:20.000Z)",
    );
    expect(describeDataSource(report({ baseFee: { wei: "10000000000", blockNumber: 12, timestamp: null } }), "token").baseFeeDescription).toBe(
      "base fee 10 gwei at block 12",
    );
  });
});

describe("the payout kind", () => {
  it("unwraps the payout in all three directors when the payout is native", () => {
    const suggestions = buildFeeSuggestions({ ...base, payout: "native", report: report() });
    if (suggestions.percentage.kind !== "available" || suggestions.fixed.kind !== "available" || suggestions.gasMultiplier.kind !== "available") {
      throw new Error("all three should be available");
    }
    for (const director of [suggestions.percentage.director, suggestions.fixed.director, suggestions.gasMultiplier.director]) {
      expect(director.settings & UNWRAP).toBe(UNWRAP);
    }
  });

  it("keeps the payout in the token when none is named", () => {
    const suggestions = buildFeeSuggestions({ ...base, report: report() });
    if (suggestions.percentage.kind !== "available") throw new Error("available");
    expect(suggestions.percentage.director.settings & UNWRAP).toBe(0n);
  });
});

describe("an error that is not a range error", () => {
  it("is not hidden as an unavailable tip range either", () => {
    expect(() => suggestedTipRange({ ...base, senderPrice: {} as never, report: report() })).toThrow(TypeError);
  });

  it("is not hidden as an unavailable suggestion, because it is a bug and not a bad input", () => {
    expect(() => buildFeeSuggestions({ ...base, senderPrice: {} as never, report: report() })).toThrow(TypeError);
  });
});

describe("the gas price basis of the default gas based tip", () => {
  it("reads the base fee only where the chain reports one, and the whole gas price where it reports none", () => {
    expect(gasPriceBasisFor("reported")).toBe("base-fee-only");
    expect(gasPriceBasisFor(undefined)).toBe("base-fee-only");
    expect(gasPriceBasisFor("none")).toBe("transaction");
  });

  it("sets the base fee flag by default, and clears it for a chain with no base fee", () => {
    const priority = { ...base, priorityFeeWei: 1_000_000_000n, report: report() };
    const reported = buildFeeSuggestions(priority);
    const none = buildFeeSuggestions({ ...priority, gasPrice: gasPriceBasisFor("none") });
    if (reported.gasMultiplier.kind !== "available" || none.gasMultiplier.kind !== "available") throw new Error("available");
    expect(reported.gasMultiplier.director.settings).toBe(EXCLUDE_PRIORITY);
    expect(none.gasMultiplier.director.settings).toBe(0n);
    // The whole gas price adds the priority fee to the ceiling, so its limit is higher.
    expect(none.gasMultiplier.director.limit).toBeGreaterThan(reported.gasMultiplier.director.limit);
  });

  it("has a default margin of 1: the tip equals the cost", () => {
    expect(DEFAULT_GAS_MARGIN).toBe(10n ** 18n);
  });
});

describe("the suggested tip range", () => {
  const rangeInput = { ...base, report: report() };

  it("the default tip equals the measured gas cost at the base fee, with no proof share", () => {
    const range = suggestedTipRange(rangeInput);
    const source = describeDataSource(report(), "token_callback");
    const { fee } = expectedFee(range.default, { value: base.transferValue, gasUsed: source.gas, baseFeeWei: source.baseFeeWei, priorityFeeWei: 0n, payout: "token" });
    // The router adds its own overhead to the measured gas. The tip is exactly that gas at the base fee, with no further share.
    expect(fee).toBe((source.gas + TOKEN_GAS_OVERHEAD) * source.baseFeeWei);
  });

  it("the range is half to one and a half times the cost", () => {
    expect(SUGGESTED_TIP_RANGE).toEqual({ low: 5n * 10n ** 17n, high: 15n * 10n ** 17n });
    const range = suggestedTipRange(rangeInput);
    expect(range.low.multiplier * 2n).toBe(range.default.multiplier);
    expect(range.high.multiplier * 2n).toBe(range.default.multiplier * 3n);
  });

  it("follows a change of the margin of the middle of the range, not the ends", () => {
    const range = suggestedTipRange({ ...rangeInput, gasMargin: 2n * 10n ** 18n });
    expect(range.default.multiplier).toBe(2n * suggestedTipRange(rangeInput).default.multiplier);
    expect(range.low.multiplier).toBe(suggestedTipRange(rangeInput).low.multiplier);
  });

  it("is part of the suggestions, and is unavailable with a reason when the price is bad", () => {
    const suggestions = buildFeeSuggestions(rangeInput);
    if (suggestions.tipRange.kind !== "available") throw new Error("available");
    expect(suggestions.tipRange.default.director).toEqual(suggestedTipRange(rangeInput).default);
    expect(suggestions.tipRange.default.description.mode).toBe("gas");
    const bad = buildFeeSuggestions({ ...rangeInput, senderPrice: { numerator: 0n, denominator: 1n } });
    expect(bad.tipRange.kind).toBe("unavailable");
    // A margin of zero spoils only the middle of the range, and the whole range says so.
    const spoiled = buildFeeSuggestions({ ...rangeInput, gasMargin: 0n });
    expect(spoiled.tipRange).toEqual({ kind: "unavailable", reason: "the margin must be above zero" });
  });

  it("prices a kind with no measure at the configured default gas, and nothing else", () => {
    const source = describeDataSource(report(), "token_callback");
    expect(source.kind).toBe("measured");
    const unmeasured = describeDataSource(report({ kinds: { token_callback: kind(), token: kind(), message: kind() } }), "token_callback");
    expect(unmeasured.gas).toBe(550_000n);
    expect(describeDataSource(report(), "message").gas).toBe(550_000n);
  });
});

describe("a tip against the cost", () => {
  it("refuses a negative tip or cost", () => {
    expect(() => tipVersusCost({ tipWei: -1n, costWei: 0n })).toThrow(RangeError);
    expect(() => tipVersusCost({ tipWei: 0n, costWei: -1n })).toThrow(RangeError);
  });

  it("a tip of zero is allowed and described as below cost", () => {
    const zero = tipVersusCost({ tipWei: 0n, costWei: 100n });
    expect(zero.position).toBe("below-cost");
    expect(zero.shortfallWei).toBe(100n);
    expect(zero.words).toContain("below the cost");
    expect(zero.words).toContain("still works");
  });

  it("tells a covering tip and a tip above cost apart", () => {
    expect(tipVersusCost({ tipWei: 100n, costWei: 100n }).position).toBe("covers-cost");
    expect(tipVersusCost({ tipWei: 101n, costWei: 100n }).position).toBe("above-cost");
    expect(tipVersusCost({ tipWei: 101n, costWei: 100n }).shortfallWei).toBe(0n);
  });

  it("describes a zero fixed tip with a negative margin line", () => {
    const description = describeFee(
      { recipient, settings: FIXED_FEE, limit: 0n, multiplier: 0n, callGas: 0n },
      { transferValue: 1_000n, token, gasUsed: 100n, baseFeeWei: 1n, priorityFeeWei: 0n, cost: { gasCostWei: 100n, totalWei: 100n } },
    );
    expect(description.nowUnits).toBe(0n);
    expect(description.breakdown.find((line) => line.id === "margin")?.amountWei).toBe(-100n);
  });
});
