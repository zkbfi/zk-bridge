import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decodeFeeDirector,
  defaultTip,
  deliveryCostBreakdown,
  deliveryCostWei,
  encodeFeeDirector,
  expectedFee,
  FEE_SETTING,
  gasMultiplierOf,
  feeModeOf,
  maximumFee,
  proofCostWei,
  senderPriceOfToken,
  suggestFixed,
  suggestGasMultiplier,
  suggestPercentage,
  weiToTokenUnitsCeiling,
  type FeeDirector,
} from "../src/delivery-fee.js";

type Vector = {
  recipient: `0x${string}`;
  settings: string;
  limit: string;
  multiplier: string;
  encoded: `0x${string}`;
  wrappedNative: boolean;
  value: string;
  gasUsed: string;
  baseFee: string;
  priorityFee: string;
  reverts: boolean;
  fee: string;
  toRecipient: string;
};

const vectors = readFileSync(new URL("./fixtures/delivery-fee-vectors.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line) as Vector);

const directorOf = (vector: Vector): FeeDirector => ({
  recipient: vector.recipient,
  settings: BigInt(vector.settings),
  limit: BigInt(vector.limit),
  multiplier: BigInt(vector.multiplier),
});

const recipient = "0x00000000000000000000000000000000000000aa" as const;
const context = { router: "0x00000000000000000000000000000000000000bb", protectedAddresses: [] } as const;
const wei = 10n ** 18n;
const price = { tokenValueInWei: wei, tokenDecimals: 18 };

describe("against vectors printed by the compiled FeeRouter", () => {
  it("has vectors, including overflows that revert", () => {
    expect(vectors.length).toBeGreaterThan(2000);
    expect(vectors.some((vector) => vector.reverts)).toBe(true);
    expect(vectors.some((vector) => !vector.reverts && BigInt(vector.fee) > 0n)).toBe(true);
  });

  it("encodes every director as abi.encode does, and decodes it back", () => {
    for (const vector of vectors) {
      const director = directorOf(vector);
      expect(encodeFeeDirector(director, context), JSON.stringify(vector)).toBe(vector.encoded);
      expect(decodeFeeDirector(vector.encoded).settings).toBe(director.settings);
      expect(decodeFeeDirector(vector.encoded).limit).toBe(director.limit);
      expect(decodeFeeDirector(vector.encoded).multiplier).toBe(director.multiplier);
      expect(decodeFeeDirector(vector.encoded).recipient.toLowerCase()).toBe(director.recipient.toLowerCase());
    }
  }, 30_000);

  it("computes the fee and the rest as feeInfo does, and throws where the router reverts", () => {
    for (const vector of vectors) {
      const run = () =>
        expectedFee(directorOf(vector), {
          value: BigInt(vector.value),
          gasUsed: BigInt(vector.gasUsed),
          baseFeeWei: BigInt(vector.baseFee),
          priorityFeeWei: BigInt(vector.priorityFee),
          payout: vector.wrappedNative && (BigInt(vector.settings) & FEE_SETTING.unwrap) !== 0n ? "native" : "token",
        });
      if (vector.reverts) {
        expect(run, JSON.stringify(vector)).toThrow(RangeError);
        continue;
      }
      expect(run(), JSON.stringify(vector)).toEqual({ fee: BigInt(vector.fee), toRecipient: BigInt(vector.toRecipient) });
    }
  });
});

describe("the encoding", () => {
  it("is four words with no offset", () => {
    const encoded = encodeFeeDirector({ recipient, settings: 8n, limit: 0n, multiplier: 5n }, context);
    expect((encoded.length - 2) / 2).toBe(128);
  });

  it("refuses data of another length", () => {
    expect(() => decodeFeeDirector("0x1234")).toThrow(RangeError);
  });
});

describe("the fee modes", () => {
  it("lets fixed win over share, as the router does", () => {
    expect(feeModeOf(FEE_SETTING.fixedFee | FEE_SETTING.shareOfValue)).toBe("fixed");
    expect(feeModeOf(FEE_SETTING.shareOfValue)).toBe("share");
    expect(feeModeOf(0n)).toBe("gas");
    expect(feeModeOf(FEE_SETTING.unwrap | FEE_SETTING.baseFeeOnly)).toBe("gas");
  });

  it("takes the limit in fixed mode, never above the value", () => {
    const director = { recipient, settings: FEE_SETTING.fixedFee, limit: 500n, multiplier: 0n };
    expect(expectedFee(director, { value: 1_000n, gasUsed: 0n, baseFeeWei: 0n }).fee).toBe(500n);
    expect(expectedFee(director, { value: 100n, gasUsed: 0n, baseFeeWei: 0n })).toEqual({ fee: 100n, toRecipient: 0n });
  });

  it("prices gas at the base fee only when the flag is set", () => {
    const base = { recipient, limit: 10n ** 30n, multiplier: wei };
    const input = { value: 10n ** 30n, gasUsed: 0n, baseFeeWei: 7n, priorityFeeWei: 3n };
    expect(expectedFee({ ...base, settings: 0n }, input).fee).toBe(100_000n * 10n);
    expect(expectedFee({ ...base, settings: FEE_SETTING.baseFeeOnly }, input).fee).toBe(100_000n * 7n);
    expect(expectedFee({ ...base, settings: 0n }, { ...input, payout: "native" }).fee).toBe(50_000n * 10n);
  });

  it("reports the maximum: the limit for gas, the amount for the others", () => {
    expect(maximumFee({ recipient, settings: 0n, limit: 500n, multiplier: wei }, 1_000n)).toBe(500n);
    expect(maximumFee({ recipient, settings: 0n, limit: 5_000n, multiplier: wei }, 1_000n)).toBe(1_000n);
    expect(maximumFee({ recipient, settings: FEE_SETTING.shareOfValue, limit: 0n, multiplier: wei / 100n }, 1_000n)).toBe(10n);
  });
});

describe("the cost of a delivery", () => {
  it("multiplies gas by the gas price and keeps the proof share as its own line", () => {
    const breakdown = deliveryCostBreakdown({ deliveryGas: 500_000n, baseFeeWei: 7n, priorityFeeWei: 3n, updateShareGas: 1_000n, proofCostWei: 77n });
    expect(breakdown).toEqual({ gasCostWei: 501_000n * 10n, proofCostWei: 77n, totalWei: 5_010_077n });
    expect(deliveryCostWei({ deliveryGas: 1n, baseFeeWei: 1n, priorityFeeWei: 0n })).toBe(1n);
  });

  it("converts the dollar cost of a proof to wei with exact math, rounded up", () => {
    // 0.02 dollars at 2,000 dollars a coin is 0.00001 coin.
    expect(proofCostWei({ proofCostUsd: "0.02", nativeCoinPriceUsd: "2000" })).toBe(10n ** 13n);
    // Split over three deliveries, the share rounds up so the runner is never short.
    expect(proofCostWei({ proofCostUsd: "0.02", nativeCoinPriceUsd: "2000", deliveriesPerProof: 3 })).toBe(3_333_333_333_334n);
    // A coin worth a hundred-thousandth of a dollar: no floating point error at this scale.
    expect(proofCostWei({ proofCostUsd: "0.02", nativeCoinPriceUsd: "0.00001" })).toBe(2_000n * wei);
  });

  it("refuses a missing price or a bad split", () => {
    expect(() => proofCostWei({ proofCostUsd: "0.02", nativeCoinPriceUsd: "0" })).toThrow(RangeError);
    expect(() => proofCostWei({ proofCostUsd: "0.02", nativeCoinPriceUsd: "1", deliveriesPerProof: 0 })).toThrow(RangeError);
    expect(() => proofCostWei({ proofCostUsd: "abc", nativeCoinPriceUsd: "1" })).toThrow();
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
      expect(director.settings).toBe(FEE_SETTING.shareOfValue);
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
    expect(suggestPercentage({ ...input, costWei: 1n, transferValue: 10n, payout: "native" }).settings).toBe(FEE_SETTING.shareOfValue | FEE_SETTING.unwrap);
  });
});

describe("suggestFixed", () => {
  it("is the cost plus the margin, rounded up", () => {
    const director = suggestFixed({ recipient, ...price, marginRate: wei / 10n, costWei: 1_001n, transferValue: 10_000n });
    expect(director.limit).toBe(1_102n);
    expect(director.settings).toBe(FEE_SETTING.fixedFee);
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

  it("enforces the ceiling: a spike in the base fee cannot take more than the limit", () => {
    const director = suggestGasMultiplier(input);
    const spike = expectedFee(director, { value: 10n ** 30n, gasUsed: 400_000n, baseFeeWei: 20_000n });
    expect(spike.fee).toBe(director.limit);
    const calm = expectedFee(director, { value: 10n ** 30n, gasUsed: 400_000n, baseFeeWei: 10n });
    expect(calm.fee).toBeLessThan(director.limit);
    const atCeiling = expectedFee(director, { value: 10n ** 30n, gasUsed: 400_000n, baseFeeWei: 20n });
    expect(atCeiling.fee).toBe(director.limit);
  });

  it("uses the smaller overhead and the unwrap flag for a native payout", () => {
    const director = suggestGasMultiplier({ ...input, payout: "native" });
    expect(director.limit).toBe(((400_000n + 50_000n) * 12n * 20n) / 10n);
    expect(director.settings).toBe(FEE_SETTING.unwrap);
  });

  it("drops the priority fee from the ceiling with the base fee flag", () => {
    const withPriority = suggestGasMultiplier({ ...input, priorityFeeCeilingWei: 5n });
    const baseOnly = suggestGasMultiplier({ ...input, priorityFeeCeilingWei: 5n, gasPrice: "base-fee-only" });
    expect(withPriority.limit).toBeGreaterThan(baseOnly.limit);
    expect(baseOnly.settings).toBe(FEE_SETTING.baseFeeOnly);
  });

  it("gives a limit of zero at a ceiling of zero, and refuses a zero price, a zero margin or an oversized multiplier", () => {
    expect(suggestGasMultiplier({ ...input, baseFeeCeilingWei: 0n }).limit).toBe(0n);
    expect(() => suggestGasMultiplier({ ...input, senderPrice: { numerator: 0n, denominator: 1n } })).toThrow(RangeError);
    expect(() => suggestGasMultiplier({ ...input, senderPrice: { numerator: 1n, denominator: 0n } })).toThrow(RangeError);
    expect(() => suggestGasMultiplier({ ...input, margin: 0n })).toThrow(RangeError);
    expect(() => suggestGasMultiplier({ ...input, senderPrice: { numerator: 2n ** 96n, denominator: 1n }, margin: wei })).toThrow(RangeError);
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
    expect(director).toEqual({ recipient, settings: FEE_SETTING.shareOfValue, limit: 0n, multiplier: 10n ** 15n });
    expect(feeModeOf(director.settings)).toBe("share");
    expect(expectedFee(director, { value: 100n * wei, gasUsed: 0n, baseFeeWei: 0n })).toEqual({ fee: wei / 10n, toRecipient: 100n * wei - wei / 10n });
  });

  it("sets the unwrap flag for a native payout", () => {
    expect(defaultTip(recipient, "native").settings).toBe(FEE_SETTING.shareOfValue | FEE_SETTING.unwrap);
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
    expect(director).toEqual({ recipient, settings: FEE_SETTING.fixedFee, limit: 0n, multiplier: 0n });
  });
});
