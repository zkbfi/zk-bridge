import { describe, expect, it } from "vitest";
import { defaultTip, feeModeOf, FEE_SETTING, senderPriceOfToken } from "@zk-bridge/shared";
import { selectDelivery, DEFAULT_GAS_MULTIPLIER, DEFAULT_MARGIN_RATE, type DeliverySelectionInput } from "../../src/tx/delivery-selection";
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
  gasMargin: DEFAULT_GAS_MULTIPLIER,
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
    expect(selection.maximumRunnerTake).toBe(10n ** 17n);
  });

  it("needs no price for a percentage tip, and leaves the cost lines out when no price is known", () => {
    const selection = available({ tokenValueInWei: null, senderPrice: null, token: { symbol: "zkbUSDC", decimals: 6 } });
    expect(feeModeOf(selection.director.settings)).toBe("share");
    expect(selection.description.breakdown).toEqual([]);
  });

  it("shows the cost lines of a percentage tip once a price is known", () => {
    expect(available().description.breakdown.map((line) => line.id)).toEqual(["gas", "proof", "margin"]);
  });

  it("takes the percentage that the user typed, and refuses one above 100 percent", () => {
    expect(available({ percentageRate: 5n * 10n ** 15n }).director.multiplier).toBe(5n * 10n ** 15n);
    expect(selectDelivery(input({ percentageRate: 10n ** 18n + 1n }), ROUTERS)).toEqual({ kind: "unavailable", reason: "The percentage is above 100 percent." });
  });

  it("sets the unwrap bit when the payout is the native coin", () => {
    expect(available({ payout: "native" }).director.settings & FEE_SETTING.unwrap).toBe(FEE_SETTING.unwrap);
  });

  it("labels a gas multiplier tip an estimate and states the guaranteed maximum", () => {
    const selection = available({ mode: "gas-multiplier" });
    expect(selection.description.certainty).toBe("estimate");
    expect(selection.description.certaintyLabel).toMatch(/^estimate, at most /);
    expect(selection.maximumRunnerTake).toBe(selection.director.limit);
    expect(selection.description.nowUnits).toBeLessThanOrEqual(selection.maximumRunnerTake);
  });

  it("works for any token: the price of the sender is folded into the multiplier", () => {
    // 3,000 USDC (6 decimals) for one native coin: one wei is worth 3,000 * 10^6 / 10^18 base units.
    const price = { numerator: 3_000n * 10n ** 6n, denominator: 10n ** 18n };
    const selection = available({ mode: "gas-multiplier", token: { symbol: "zkbUSDC", decimals: 6 }, tokenValueInWei: 10n ** 18n / 3_000n, senderPrice: price, transferValue: 249_000_000n, transferValueAtMost: 249_750_000n });
    expect(selection.director.multiplier).toBe((price.numerator * DEFAULT_GAS_MULTIPLIER + price.denominator - 1n) / price.denominator);
    expect(selection.description.certainty).toBe("estimate");
  });

  it("asks for the price of the sender when a gas multiplier has none", () => {
    const selection = selectDelivery(input({ mode: "gas-multiplier", tokenValueInWei: null, senderPrice: null, token: { symbol: "zkbUSDC", decimals: 6 } }), ROUTERS);
    expect(selection).toEqual({ kind: "unavailable", reason: expect.stringContaining("Enter your coin price") });
  });

  it("raises the maximum when the user raises the ceiling base fee, and never lowers the estimate now", () => {
    const low = available({ mode: "gas-multiplier", baseFeeCeilingWei: 10n * GWEI });
    const high = available({ mode: "gas-multiplier", baseFeeCeilingWei: 100n * GWEI });
    expect(high.maximumRunnerTake).toBeGreaterThan(low.maximumRunnerTake);
    expect(high.description.nowUnits).toBe(low.description.nowUnits);
  });

  it("states the maximum from the amount that is still in the transfer, not from the amount after the destination fee", () => {
    const selection = available({ transferValue: 99n * 10n ** 18n, transferValueAtMost: 100n * 10n ** 18n });
    expect((100n * 10n ** 18n * selection.director.multiplier) / 10n ** 18n).toBe(selection.maximumRunnerTake);
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
    expect(after.maximumRunnerTake).toBeGreaterThan(before.maximumRunnerTake);
  });

  it("flags a report with no coin price, so the form can say that the proof cost is left out", () => {
    const selection = available({ report: buildDeliveryReport(369, { proofCostWei: null }) });
    expect(selection.suggestions.proofCostMissing).toBe(true);
    expect(selection.suggestions.cost.proofCostWei).toBe(0n);
  });

  it("says when the suggested fixed amount cannot be built because the transfer is too small", () => {
    expect(selectDelivery(input({ mode: "fixed", transferValue: 10n, transferValueAtMost: 10n }), ROUTERS).kind).toBe("unavailable");
  });

  it("builds a fixed tip from the typed amount with no price, and from the suggestion with one", () => {
    const typed = available({ mode: "fixed", fixedAmount: 5n * 10n ** 17n, tokenValueInWei: null, senderPrice: null });
    expect(typed.director).toMatchObject({ settings: FEE_SETTING.fixedFee, limit: 5n * 10n ** 17n, multiplier: 0n });
    expect(typed.description.certainty).toBe("exact");
    const suggested = available({ mode: "fixed" });
    expect(suggested.maximumRunnerTake).toBe(suggested.director.limit);
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
