import { describe, expect, it } from "vitest";
import { buildFeeSuggestions, DEFAULT_GAS_MARGIN, defaultTip, encodeFeeDirector, EXCLUDE_PRIORITY, feeModeOf, requestedPayoutOf, senderPriceOfToken, settingFlagsOf, settingsOf } from "@zk-bridge/shared";
import { selectDelivery, DEFAULT_MARGIN_RATE, type DeliverySelectionInput } from "../../src/tx/delivery-selection";
import { encodeAbiParameters } from "viem";
import { buildDeliveryReport } from "../helpers";

const RECIPIENT = `0x${"12".repeat(20)}` as const;
const ROUTER = `0x${"aa".repeat(20)}` as const;
const OTHER_ROUTER = `0x${"bb".repeat(20)}` as const;
const GWEI = 10n ** 9n;
const ROUTERS = { router: ROUTER, defaultRouter: ROUTER } as const;

/** A token that is worth one native coin per whole token, with 18 decimals. */
const WRAPPED = { symbol: "WPLS", decimals: 18 } as const;
const WRAPPED_PRICE = senderPriceOfToken({ tokenValueInWei: 10n ** 18n, tokenDecimals: 18 });

const input = (overrides: Partial<DeliverySelectionInput> = {}): DeliverySelectionInput => ({
  mode: "percentage",
  recipient: RECIPIENT,
  transferValue: 100n * 10n ** 18n,
  transferValueAtMost: 100n * 10n ** 18n,
  token: WRAPPED,
  tokenValueInWei: 10n ** 18n,
  senderPrice: WRAPPED_PRICE,
  payout: "token",
  report: buildDeliveryReport(369),
  priorityFeeWei: GWEI,
  percentageRate: 10n ** 15n,
  fixedAmount: null,
  marginRate: DEFAULT_MARGIN_RATE,
  gasMargin: DEFAULT_GAS_MARGIN,
  destinationName: "PulseChain",
  baseFeeCeilingWei: null,
  ...overrides,
});

const available = (overrides: Partial<DeliverySelectionInput> = {}) => {
  const selection = selectDelivery(input(overrides), ROUTERS);
  if (selection.kind !== "available") throw new Error(selection.reason);
  return selection;
};

describe("selectDelivery", () => {
  it("builds the default tip of the shared package when the user leaves the percentage at 0.1", () => {
    const selection = available();
    expect(selection.director).toEqual(defaultTip(RECIPIENT));
    expect(selection.description.certainty).toBe("exact");
    expect(selection.description.nowUnits).toBe(10n ** 17n);
    expect(selection.maximumTip).toBe(10n ** 17n);
  });

  it("needs no price for a percentage tip, and leaves the cost lines out when no price is known", () => {
    const selection = available({ tokenValueInWei: null, senderPrice: null, token: { symbol: "zkbUSDC", decimals: 6 } });
    expect(feeModeOf(selection.director.settings)).toBe("share");
    expect(selection.description.breakdown).toEqual([]);
  });

  it("shows the cost lines of a percentage tip once a price is known", () => {
    expect(available().description.breakdown.map((line) => line.id)).toEqual(["gas", "margin"]);
  });

  it("takes the percentage that the user typed, and refuses one above 100 percent", () => {
    expect(available({ percentageRate: 5n * 10n ** 15n }).director.multiplier).toBe(5n * 10n ** 15n);
    expect(selectDelivery(input({ percentageRate: 10n ** 18n + 1n }), ROUTERS)).toEqual({ kind: "unavailable", reason: "The percentage is above 100 percent." });
  });

  it("sets the unwrap bit when the payout is the native coin", () => {
    expect(settingFlagsOf(available({ payout: "native" }).director.settings)).toContain("UNWRAP");
    expect(requestedPayoutOf(available({ payout: "native" }).director.settings)).toBe("native");
  });

  it("labels a gas multiplier tip an estimate and states the guaranteed maximum", () => {
    const selection = available({ mode: "gas-multiplier" });
    expect(selection.description.certainty).toBe("estimate");
    expect(selection.description.certaintyLabel).toMatch(/^estimate, at most /);
    expect(selection.maximumTip).toBe(selection.director.limit);
    expect(selection.description.nowUnits).toBeLessThanOrEqual(selection.maximumTip);
  });

  it("works for any token: the price of the sender is folded into the multiplier", () => {
    // 3,000 USDC (6 decimals) for one native coin: one wei is worth 3,000 * 10^6 / 10^18 base units.
    const price = { numerator: 3_000n * 10n ** 6n, denominator: 10n ** 18n };
    const selection = available({ mode: "gas-multiplier", token: { symbol: "zkbUSDC", decimals: 6 }, tokenValueInWei: 10n ** 18n / 3_000n, senderPrice: price, transferValue: 249_000_000n, transferValueAtMost: 249_750_000n });
    expect(selection.director.multiplier).toBe((price.numerator * DEFAULT_GAS_MARGIN + price.denominator - 1n) / price.denominator);
    expect(selection.description.certainty).toBe("estimate");
  });

  it("builds a valid delivery for a fixed amount of 0, the way to tip nothing", () => {
    const selection = available({ mode: "fixed", fixedAmount: 0n, tokenValueInWei: null, senderPrice: null });
    expect(selection.director.limit).toBe(0n);
    expect(selection.description.nowUnits).toBe(0n);
    expect(selection.description.certaintyLabel).toBe("exact");
  });

  it("asks for the price of the sender when a gas multiplier has none", () => {
    const selection = selectDelivery(input({ mode: "gas-multiplier", tokenValueInWei: null, senderPrice: null, token: { symbol: "zkbUSDC", decimals: 6 } }), ROUTERS);
    expect(selection).toEqual({ kind: "unavailable", reason: expect.stringContaining("Enter your price of the native coin") });
  });

  it("raises the maximum when the user raises the ceiling base fee, and never lowers the estimate now", () => {
    const low = available({ mode: "gas-multiplier", baseFeeCeilingWei: 10n * GWEI });
    const high = available({ mode: "gas-multiplier", baseFeeCeilingWei: 100n * GWEI });
    expect(high.maximumTip).toBeGreaterThan(low.maximumTip);
    expect(high.description.nowUnits).toBe(low.description.nowUnits);
  });

  it("states the maximum from the amount that is still in the transfer, not from the amount after the destination fee", () => {
    const selection = available({ transferValue: 99n * 10n ** 18n, transferValueAtMost: 100n * 10n ** 18n });
    expect((100n * 10n ** 18n * selection.director.multiplier) / 10n ** 18n).toBe(selection.maximumTip);
  });

  it("tells where the gas comes from: measured deliveries, or a default when none is measured", () => {
    const measured = available({ report: buildDeliveryReport(369, { sampleCount: 40 }) });
    const unmeasured = available({ report: buildDeliveryReport(369, { sampleCount: 0 }) });
    expect(measured.suggestions.dataSource.description).toBe("measured from 40 recent deliveries, p90");
    expect(unmeasured.suggestions.dataSource.description).toBe("default, no deliveries measured yet");
    expect(measured.suggestions.dataSource.baseFeeDescription).toMatch(/base fee 7 gwei at block 21000000/);
  });

  it("follows the report: more measured deliveries with higher gas give a higher gas based estimate", () => {
    const before = available({ mode: "gas-multiplier", report: buildDeliveryReport(369, { p90Gas: 210_000n }) });
    const after = available({ mode: "gas-multiplier", report: buildDeliveryReport(369, { p90Gas: 420_000n }) });
    expect(after.maximumTip).toBeGreaterThan(before.maximumTip);
  });

  it("counts the gas alone in the cost, with no share of the cost of proving", () => {
    const selection = available();
    expect(selection.suggestions.cost.totalWei).toBe(selection.suggestions.cost.gasCostWei);
  });

  it("offers the range as low, suggested and high, each half a step apart in the multiplier", () => {
    const { tipRange } = available().suggestions;
    if (tipRange.kind !== "available") throw new Error("available");
    expect(tipRange.low.director.multiplier * 2n).toBe(tipRange.default.director.multiplier);
    expect(tipRange.high.director.multiplier * 2n).toBe(tipRange.default.director.multiplier * 3n);
  });

  it("says when the suggested fixed amount cannot be built because the transfer is too small", () => {
    expect(selectDelivery(input({ mode: "fixed", transferValue: 10n, transferValueAtMost: 10n }), ROUTERS).kind).toBe("unavailable");
  });

  it("builds a fixed tip from the typed amount with no price, and from the suggestion with one", () => {
    const typed = available({ mode: "fixed", fixedAmount: 5n * 10n ** 17n, tokenValueInWei: null, senderPrice: null });
    expect(typed.director).toMatchObject({ settings: settingsOf({ mode: "fixed" }), limit: 5n * 10n ** 17n, multiplier: 0n });
    expect(typed.description.certainty).toBe("exact");
    const suggested = available({ mode: "fixed" });
    expect(suggested.maximumTip).toBe(suggested.director.limit);
  });

  it("carries the router of the relay and the router of the deployment, so the dialog can mark a different one", () => {
    const selection = selectDelivery(input(), { router: OTHER_ROUTER, defaultRouter: ROUTER });
    if (selection.kind !== "available") throw new Error(selection.reason);
    expect(selection).toMatchObject({ router: OTHER_ROUTER, defaultRouter: ROUTER });
  });

  it("says when the indexer has seen no block yet", () => {
    const report = buildDeliveryReport(369);
    const empty = { ...report, baseFee: { ...report.baseFee, wei: null } };
    expect(selectDelivery(input({ report: empty }), ROUTERS)).toEqual({ kind: "unavailable", reason: expect.stringContaining("no base fee") });
  });
});

describe("selectDelivery: the default gas based tip", () => {
  const gas = (overrides: Partial<DeliverySelectionInput> = {}) => available({ mode: "gas-multiplier", ...overrides });

  it("reads the base fee only on a chain that reports one, and says nothing", () => {
    const selection = gas({ destinationBaseFee: "reported" });
    expect(selection.director.settings & EXCLUDE_PRIORITY).toBe(EXCLUDE_PRIORITY);
    expect(selection.gasPrice).toBe("base-fee-only");
    expect(selection.notice).toBeNull();
  });

  it("reads the base fee only when the chain config names no base fee support", () => {
    expect(gas().gasPrice).toBe("base-fee-only");
  });

  it("falls back to the whole gas price on a chain with no base fee, and says why", () => {
    const selection = gas({ destinationBaseFee: "none" });
    expect(selection.director.settings & EXCLUDE_PRIORITY).toBe(0n);
    expect(selection.gasPrice).toBe("transaction");
    expect(selection.notice).toBe("PulseChain reports no base fee, so the tip reads the whole gas price.");
  });

  it("asks for a price when neither the sender nor the valuation gives one, with no fixed fallback", () => {
    const selection = selectDelivery(input({ mode: "gas-multiplier", tokenValueInWei: null, senderPrice: null, token: { symbol: "zkbUSDC", decimals: 6 } }), ROUTERS);
    expect(selection).toEqual({ kind: "unavailable", reason: expect.stringContaining("Enter your price of the native coin in this token") });
  });

  it("sets the multiplier to the price times 1e18, rounded up: the tip equals the measured cost", () => {
    const price = { numerator: 3_001n * 10n ** 6n + 1n, denominator: 10n ** 18n };
    const selection = gas({ token: { symbol: "zkbUSDC", decimals: 6 }, tokenValueInWei: 10n ** 18n / 3_000n, senderPrice: price });
    const expected = (price.numerator * 10n ** 18n + price.denominator - 1n) / price.denominator;
    expect(selection.director.multiplier).toBe(expected);
  });

  it("sets the limit to the tip at the ceiling base fee of twice the base fee now", () => {
    const selection = gas();
    const suggestion = buildFeeSuggestions({
      recipient: RECIPIENT,
      transferValue: 100n * 10n ** 18n,
      token: { ...WRAPPED, valueInWei: 10n ** 18n },
      report: buildDeliveryReport(369),
      priorityFeeWei: GWEI,
      gasPrice: "base-fee-only",
    }).gasMultiplier;
    if (suggestion.kind !== "available") throw new Error(suggestion.reason);
    expect(selection.director.limit).toBe(suggestion.director.limit);
    expect(selection.maximumTip).toBe(selection.director.limit);
    // The base fee now is 7 gwei in the report, and the ceiling is twice that, so the limit is twice the tip now.
    expect(selection.director.limit).toBeGreaterThanOrEqual(selection.description.nowUnits * 2n - 1n);
    expect(selection.director.limit).toBeLessThanOrEqual(selection.description.nowUnits * 2n + 1n);
  });

  it("has no proof line in the cost breakdown", () => {
    expect(gas().description.breakdown.map((line) => line.id)).not.toContain("proof");
  });

  it("encodes the default director as the abi encoding of the recipient, the settings, the limit and the multiplier", () => {
    const { director } = gas();
    const expected = encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [RECIPIENT, 4n, director.limit, director.multiplier],
    );
    expect(encodeFeeDirector(director, { router: ROUTER, protectedAddresses: [], destinationToken: null, destinationWrappedNative: null })).toBe(expected);
  });

  it("gives the percentage and fixed modes no notice, and keeps them selectable on a chain with no base fee", () => {
    expect(available({ destinationBaseFee: "none" }).notice).toBeNull();
    expect(available({ mode: "fixed", destinationBaseFee: "none" }).notice).toBeNull();
  });
  it("limits a gas-based tip by the automatic cap's share of the amount, and leaves the other modes alone", () => {
    const uncapped = available({ mode: "gas-multiplier" });
    const cap = uncapped.director.limit / 2n;
    const capped = available({ mode: "gas-multiplier", gasLimitCapUnits: cap });
    expect(capped.director.limit).toBe(cap);
    expect(capped.maximumTip).toBe(cap);
    // A cap above the limit changes nothing.
    expect(available({ mode: "gas-multiplier", gasLimitCapUnits: uncapped.director.limit * 2n }).director.limit).toBe(uncapped.director.limit);
    expect(available({ mode: "percentage", gasLimitCapUnits: 1n }).director).toEqual(available({ mode: "percentage" }).director);
  });
});
