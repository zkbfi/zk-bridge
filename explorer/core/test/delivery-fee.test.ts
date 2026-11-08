import { describe, expect, it } from "vitest";
import {
  defaultTip,
  deliveryCostBreakdown,
  deliveryCostWei,
  gasMultiplierOf,
  senderPriceOfToken,
  suggestFixed,
  suggestGasMultiplier,
  suggestPercentage,
  weiToTokenUnitsCeiling,
} from "../src/delivery-fee.js";
import { feeModeOf, MULTIPLIER_OF_TOTAL, FIXED_FEE, UNWRAP, EXCLUDE_PRIORITY, expectedFee, NATIVE_GAS_OVERHEAD } from "../src/delivery-terms.js";

const recipient = "0x00000000000000000000000000000000000000aa" as const;
const wei = 10n ** 18n;
const price = { tokenValueInWei: wei, tokenDecimals: 18 };

describe("the cost of a delivery", () => {
  it("multiplies gas by the gas price, with no proof share", () => {
    const breakdown = deliveryCostBreakdown({ deliveryGas: 500_000n, baseFeeWei: 7n, priorityFeeWei: 3n, updateShareGas: 1_000n });
    expect(breakdown).toEqual({ gasCostWei: 501_000n * 10n, totalWei: 5_010_000n });
    expect(deliveryCostWei({ deliveryGas: 1n, baseFeeWei: 1n, priorityFeeWei: 0n })).toBe(1n);
  });


  it("refuses a negative input", () => {
    expect(() => deliveryCostWei({ deliveryGas: -1n, baseFeeWei: 1n, priorityFeeWei: 0n })).toThrow(RangeError);
  });
});

describe("suggestPercentage", () => {
  const input = { recipient, ...price, marginRate: wei / 10n };

  it("covers the cost plus the margin: the fee the router takes is never below it", () => {
    for (const [costWei, transferValue] of [[1n, 7n], [123_456_789n, 10n ** 12n], [10n ** 15n, 3n * 10n ** 18n], [900n, 1_000n]] as const) {
      const director = suggestPercentage({ ...input, costWei, transferValue });
      const taken = expectedFee(director, { value: transferValue, gasUsed: 0n, baseFeeWei: 0n }).fee;
      const required = (costWei * 11n + 9n) / 10n;
      expect(taken, `${costWei} on ${transferValue}`).toBeGreaterThanOrEqual(required);
      expect(director.settings).toBe(MULTIPLIER_OF_TOTAL);
    }
  });

  it("rounds the multiplier up by at most one unit", () => {
    const director = suggestPercentage({ ...input, marginRate: 0n, costWei: 1n, transferValue: 3n });
    expect(director.multiplier).toBe((wei + 2n) / 3n);
  });

  it("gives zero for a cost of zero (the floor)", () => {
    expect(suggestPercentage({ ...input, costWei: 0n, transferValue: 1_000n }).multiplier).toBe(0n);
    expect(suggestPercentage({ ...input, costWei: 0n, transferValue: 0n }).multiplier).toBe(0n);
  });

  it("refuses a zero value and a transfer that cannot pay", () => {
    expect(() => suggestPercentage({ ...input, costWei: 1n, transferValue: 0n })).toThrow(RangeError);
    expect(() => suggestPercentage({ ...input, costWei: 100n, transferValue: 100n })).toThrow(RangeError);
  });

  it("holds for huge values", () => {
    const transferValue = 10n ** 50n;
    const director = suggestPercentage({ ...input, costWei: 10n ** 20n, transferValue });
    expect(expectedFee(director, { value: transferValue, gasUsed: 0n, baseFeeWei: 0n }).fee).toBeGreaterThanOrEqual((10n ** 20n * 11n) / 10n);
  });

  it("converts through the price and the decimals of the token", () => {
    // A token with 6 decimals worth 0.0005 coin per whole token, and a transfer of ten whole tokens.
    const director = suggestPercentage({ recipient, tokenValueInWei: 5n * 10n ** 14n, tokenDecimals: 6, marginRate: 0n, costWei: 10n ** 15n, transferValue: 10_000_000n });
    // Cost 1e15 wei at 5e14 wei per token is 2 tokens, a fifth of the ten.
    expect(director.multiplier).toBe(wei / 5n);
  });

  it("sets the unwrap flag for a native payout", () => {
    expect(suggestPercentage({ ...input, costWei: 1n, transferValue: 10n, payout: "native" }).settings).toBe(MULTIPLIER_OF_TOTAL | UNWRAP);
  });
});

describe("suggestFixed", () => {
  it("is the cost plus the margin, rounded up", () => {
    const director = suggestFixed({ recipient, ...price, marginRate: wei / 10n, costWei: 1_001n, transferValue: 10_000n });
    expect(director.limit).toBe(1_102n);
    expect(director.settings).toBe(FIXED_FEE);
  });

  it("refuses a transfer below the fee", () => {
    expect(() => suggestFixed({ recipient, ...price, marginRate: 0n, costWei: 10n, transferValue: 9n })).toThrow(RangeError);
  });
});

describe("suggestGasMultiplier", () => {
  // The native coin itself: one wei is worth one base unit, and the margin is 1.2.
  const nativePrice = { numerator: 1n, denominator: 1n };
  const input = { recipient, senderPrice: nativePrice, margin: (wei * 12n) / 10n, baseFeeCeilingWei: 20n, deliveryGas: 400_000n };

  it("folds the sender's price and the margin into the multiplier, and sets the limit to the cost at the ceiling", () => {
    const director = suggestGasMultiplier(input);
    expect(director.multiplier).toBe((wei * 12n) / 10n);
    expect(director.limit).toBe(((400_000n + 100_000n) * 12n * 20n) / 10n);
    expect(director.settings).toBe(0n);
  });

  it("counts the call gas in the limit and carries it in the director", () => {
    const director = suggestGasMultiplier({ ...input, callGas: 50_000n });
    expect(director.callGas).toBe(50_000n);
    expect(director.limit).toBe(((400_000n + 50_000n + 100_000n) * 12n * 20n) / 10n);
    expect(suggestGasMultiplier(input).callGas).toBe(0n);
    expect(() => suggestGasMultiplier({ ...input, callGas: -1n })).toThrow(RangeError);
  });

  it("enforces the ceiling: a spike in the base fee cannot take more than the limit", () => {
    const director = suggestGasMultiplier(input);
    const spike = expectedFee(director, { value: 10n ** 30n, gasUsed: 400_000n, baseFeeWei: 20_000n });
    expect(spike.fee).toBe(director.limit);
    const calm = expectedFee(director, { value: 10n ** 30n, gasUsed: 400_000n, baseFeeWei: 10n });
    expect(calm.fee).toBeLessThan(director.limit);
    const atCeiling = expectedFee(director, { value: 10n ** 30n, gasUsed: 400_000n, baseFeeWei: 20n });
    expect(atCeiling.fee).toBe(director.limit);
  });

  it("uses the native overhead and the unwrap flag for a native payout", () => {
    const director = suggestGasMultiplier({ ...input, payout: "native" });
    expect(director.limit).toBe(((400_000n + NATIVE_GAS_OVERHEAD) * 12n * 20n) / 10n);
    expect(director.settings).toBe(UNWRAP);
  });

  it("drops the priority fee from the ceiling with the base fee flag", () => {
    const withPriority = suggestGasMultiplier({ ...input, priorityFeeCeilingWei: 5n });
    const baseOnly = suggestGasMultiplier({ ...input, priorityFeeCeilingWei: 5n, gasPrice: "base-fee-only" });
    expect(withPriority.limit).toBeGreaterThan(baseOnly.limit);
    expect(baseOnly.settings).toBe(EXCLUDE_PRIORITY);
  });

  it("gives a limit of zero at a ceiling of zero, and refuses a zero price, or a zero margin", () => {
    expect(suggestGasMultiplier({ ...input, baseFeeCeilingWei: 0n }).limit).toBe(0n);
    expect(() => suggestGasMultiplier({ ...input, senderPrice: { numerator: 0n, denominator: 1n } })).toThrow(RangeError);
    expect(() => suggestGasMultiplier({ ...input, senderPrice: { numerator: 1n, denominator: 0n } })).toThrow(RangeError);
    expect(() => suggestGasMultiplier({ ...input, margin: 0n })).toThrow(RangeError);
    // The router reads the multiplier in full, so a large one is not refused.
    expect(suggestGasMultiplier({ ...input, senderPrice: { numerator: 2n ** 96n, denominator: 1n }, margin: wei }).multiplier).toBe(2n ** 96n * wei);
  });

  it("works for a token that is not the native coin: the price turns wei into token units", () => {
    // The sender says 1 native coin is worth 3,000 of a token with 6 decimals. One wei is 3,000 * 10^6 / 10^18 units.
    const senderPrice = { numerator: 3_000n * 10n ** 6n, denominator: wei };
    const director = suggestGasMultiplier({ ...input, senderPrice, margin: wei, baseFeeCeilingWei: 10n ** 10n });
    // multiplier = units per wei * margin * 1e18 = 3,000,000,000 * 1 (margin 1.0) = 3e9.
    expect(director.multiplier).toBe(3_000_000_000n);
    // At 10 gwei and 500,000 gas the cost is 0.005 native coin, which is 15 tokens: 15,000,000 units.
    const fee = expectedFee(director, { value: 10n ** 12n, gasUsed: 400_000n, baseFeeWei: 10n ** 10n });
    expect(fee.fee).toBe(15_000_000n);
    expect(suggestGasMultiplier({ ...input, senderPrice, margin: wei, baseFeeCeilingWei: 2n * 10n ** 10n }).limit).toBe(30_000_000n);
  });

  it("rounds the multiplier up so the router never takes less than the sender's price allows", () => {
    expect(gasMultiplierOf({ numerator: 1n, denominator: 3n }, wei)).toBe((wei + 2n) / 3n);
  });

  it("derives the price from the valuation of a token", () => {
    expect(senderPriceOfToken({ tokenValueInWei: wei, tokenDecimals: 18 })).toEqual({ numerator: wei, denominator: wei });
    expect(senderPriceOfToken({ tokenValueInWei: 10n ** 12n, tokenDecimals: 6 })).toEqual({ numerator: 10n ** 6n, denominator: 10n ** 12n });
    expect(() => senderPriceOfToken({ tokenValueInWei: 0n, tokenDecimals: 6 })).toThrow(RangeError);
  });
});

describe("defaultTip", () => {
  it("is 0.1 percent in the share mode, and takes exactly that from a transfer", () => {
    const director = defaultTip(recipient);
    expect(director).toEqual({ recipient, settings: MULTIPLIER_OF_TOTAL, limit: 0n, multiplier: 10n ** 15n, callGas: 0n });
    expect(feeModeOf(director.settings)).toBe("share");
    expect(expectedFee(director, { value: 100n * wei, gasUsed: 0n, baseFeeWei: 0n })).toEqual({ fee: wei / 10n, toRecipient: 100n * wei - wei / 10n });
  });

  it("sets the unwrap flag for a native payout", () => {
    expect(defaultTip(recipient, "native").settings).toBe(MULTIPLIER_OF_TOTAL | UNWRAP);
  });
});

describe("the price check and a zero cost", () => {
  const goodPrice = { tokenValueInWei: 10n ** 18n, tokenDecimals: 18 };

  it.each([-1, 78, 1.5, Number.NaN])("refuses token decimals of %s", (tokenDecimals) => {
    expect(() => weiToTokenUnitsCeiling(1n, { ...goodPrice, tokenDecimals })).toThrow(new RangeError(`invalid token decimals: ${tokenDecimals}`));
  });

  it("accepts the limits 0 and 77 for token decimals", () => {
    expect(weiToTokenUnitsCeiling(1n, { ...goodPrice, tokenDecimals: 0 })).toBe(1n);
    expect(weiToTokenUnitsCeiling(1n, { ...goodPrice, tokenDecimals: 77 })).toBe(10n ** 59n);
  });

  it("refuses a token value of zero wei", () => {
    expect(() => weiToTokenUnitsCeiling(1n, { ...goodPrice, tokenValueInWei: 0n })).toThrow("must be above zero");
  });

  it("gives a fixed fee of zero for a cost of zero, whatever the margin", () => {
    const director = suggestFixed({ recipient, ...goodPrice, marginRate: 10n ** 17n, costWei: 0n, transferValue: 0n });
    expect(director).toEqual({ recipient, settings: FIXED_FEE, limit: 0n, multiplier: 0n, callGas: 0n });
  });
});
