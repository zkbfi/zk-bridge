import { describe, expect, it } from "vitest";
import { DEFAULT_GAS_MARGIN, FIXED_FEE, senderPriceOfToken, UNWRAP } from "@zk-bridge/shared";
import { selectDelivery, DEFAULT_MARGIN_RATE, type DeliverySelectionInput } from "../../src/tx/delivery-selection";
import { buildDeliveryReport } from "../helpers";

const RECIPIENT = `0x${"12".repeat(20)}` as const;
const ROUTER = `0x${"aa".repeat(20)}` as const;
const ROUTERS = { router: ROUTER, defaultRouter: ROUTER } as const;

const input = (overrides: Partial<DeliverySelectionInput> = {}): DeliverySelectionInput => ({
  mode: "percentage",
  recipient: RECIPIENT,
  transferValue: 100n * 10n ** 18n,
  transferValueAtMost: 100n * 10n ** 18n,
  token: { symbol: "WPLS", decimals: 18 },
  tokenValueInWei: 10n ** 18n,
  senderPrice: senderPriceOfToken({ tokenValueInWei: 10n ** 18n, tokenDecimals: 18 }),
  payout: "token",
  report: buildDeliveryReport(369),
  priorityFeeWei: 10n ** 9n,
  percentageRate: 10n ** 15n,
  fixedAmount: null,
  marginRate: DEFAULT_MARGIN_RATE,
  gasMargin: DEFAULT_GAS_MARGIN,
  destinationName: "PulseChain",
  baseFeeCeilingWei: null,
  ...overrides,
});

describe("selectDelivery: the payout and the failures of the arithmetic", () => {
  it("sets the unwrap bit with the fixed fee bit when a fixed tip pays out the native coin", () => {
    const selection = selectDelivery(input({ mode: "fixed", fixedAmount: 5n * 10n ** 17n, payout: "native" }), ROUTERS);
    if (selection.kind !== "available") throw new Error(selection.reason);
    expect(selection.director.settings).toBe(FIXED_FEE | UNWRAP);
    expect(selection.director.limit).toBe(5n * 10n ** 17n);
  });

  it("sets only the fixed fee bit when a fixed tip pays out the token", () => {
    const selection = selectDelivery(input({ mode: "fixed", fixedAmount: 5n * 10n ** 17n, payout: "token" }), ROUTERS);
    if (selection.kind !== "available") throw new Error(selection.reason);
    expect(selection.director.settings).toBe(FIXED_FEE);
  });

  it("says that the transfer is too small when the delivery costs more than the transfer", () => {
    const selection = selectDelivery(input({ mode: "fixed", transferValue: 1n, transferValueAtMost: 1n }), ROUTERS);
    expect(selection).toEqual({ kind: "unavailable", reason: "the transfer is too small to pay for its delivery" });
  });

  it("turns a range failure of the shared arithmetic into a sentence for the user", () => {
    expect(selectDelivery(input({ priorityFeeWei: -1n }), ROUTERS)).toEqual({ kind: "unavailable", reason: "priorityFeeWei must not be negative" });
    const unpriced = input({ mode: "gas-multiplier", senderPrice: { numerator: 0n, denominator: 1n } });
    expect(selectDelivery(unpriced, ROUTERS)).toEqual({ kind: "unavailable", reason: "the price of the native coin must be above zero" });
  });

  it("does not hide a defect that is not a range failure", () => {
    const report = { ...buildDeliveryReport(369), kinds: {} } as unknown as DeliverySelectionInput["report"];
    expect(() => selectDelivery(input({ report }), ROUTERS)).toThrow(TypeError);
  });
});
