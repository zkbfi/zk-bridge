import { decodeAbiParameters, encodeAbiParameters, type Address, type Hex } from "viem";
import { parseTokenAmount, RATE_SCALE } from "./format.js";

/**
 * Voluntary delivery fees. A sender who wants a runner to deliver a transfer writes a `FeeDirector` in the callback data
 * of `relayTokensAndCall`, aimed at the `FeeRouter` of the destination chain. This module builds that director, encodes
 * it, and computes the fee that the router takes. It is the TypeScript side of `FeeRouter.sol`. The test in
 * `test/delivery-fee.test.ts` checks it against vectors that the compiled router printed
 * (`vectors/GenerateDeliveryFeeVectors.s.sol`), so the two cannot drift.
 *
 * All amounts are bigint. A rate or a multiplier is scaled by `RATE_SCALE` (1e18).
 */

/** The bits of `FeeDirector.settings`. */
export const FEE_SETTING = {
  /** The fee is `limit`. */
  fixedFee: 1n,
  /** Unwrap the wrapped native token to the native coin. */
  unwrap: 2n,
  /** Price gas at the base fee only, with no priority fee. */
  baseFeeOnly: 4n,
  /** The fee is `value * multiplier / 1e18`. */
  shareOfValue: 8n,
} as const;

/** Gas that the router adds to the measured gas of a token payout. Same as `FeeRouter.TOKEN_GAS_OVERHEAD`. */
export const TOKEN_GAS_OVERHEAD = 100_000n;
/** Gas that the router adds to the measured gas of a native coin payout. Same as `FeeRouter.NATIVE_GAS_OVERHEAD`. */
export const NATIVE_GAS_OVERHEAD = 50_000n;

/** The largest value of a `uint256`. */
export const UINT256_MAXIMUM = 2n ** 256n - 1n;
/** The router keeps the multiplier of a waiting gas based fee in 96 bits and clamps a larger one. */
const UINT96_MAXIMUM = 2n ** 96n - 1n;

/** The `FeeDirector` struct of `FeeRouter.sol`. */
export interface FeeDirector {
  /** Who receives the tokens after the fee. */
  readonly recipient: Address;
  /** Flag bits: see {@link FEE_SETTING}. */
  readonly settings: bigint;
  /** The fixed fee, or the cap on the gas based fee. In base units of the transferred token. */
  readonly limit: bigint;
  /** Scaled by 1e18: the share of the value, or the factor on the gas price. */
  readonly multiplier: bigint;
}

/** How the router computes the fee. Fixed wins over share, as in the router. */
export type FeeMode = "fixed" | "share" | "gas";

/** How the payout travels. `native` needs the unwrap flag and the wrapped native token. */
export type PayoutKind = "token" | "native";

/** Which gas price a gas based fee uses. */
export type GasPriceBasis = "transaction" | "base-fee-only";

/**
 * Tells how the router computes the fee of a director.
 *
 * @param settings The flag bits.
 */
export const feeModeOf = (settings: bigint): FeeMode => {
  if ((settings & FEE_SETTING.fixedFee) !== 0n) return "fixed";
  if ((settings & FEE_SETTING.shareOfValue) !== 0n) return "share";
  return "gas";
};

const OVERHEAD_OF: Readonly<Record<PayoutKind, bigint>> = { token: TOKEN_GAS_OVERHEAD, native: NATIVE_GAS_OVERHEAD };

const DIRECTOR_PARAMETERS = [
  { type: "address", name: "recipient" },
  { type: "uint256", name: "settings" },
  { type: "uint256", name: "limit" },
  { type: "uint256", name: "multiplier" },
] as const;

/** The size of an encoded director: four words. */
export const FEE_DIRECTOR_BYTES = 128;

/**
 * Encodes a director as `abi.encode(director)` does. The struct is static, so the result is four words with no offset.
 * This is the callback data of `relayTokensAndCall`.
 *
 * @param director The director.
 */
export const encodeFeeDirector = (director: FeeDirector): Hex =>
  encodeAbiParameters(DIRECTOR_PARAMETERS, [director.recipient, director.settings, director.limit, director.multiplier]);

/**
 * Decodes `abi.decode(data, (FeeDirector))`.
 *
 * @param data Exactly 128 bytes.
 * @throws When the data is not 128 bytes, or when the address word has bits above 160.
 */
export const decodeFeeDirector = (data: Hex): FeeDirector => {
  const bytes = (data.length - 2) / 2;
  if (bytes !== FEE_DIRECTOR_BYTES) throw new RangeError(`a fee director is ${FEE_DIRECTOR_BYTES} bytes, not ${bytes}`);
  const [recipient, settings, limit, multiplier] = decodeAbiParameters(DIRECTOR_PARAMETERS, data);
  return { recipient, settings, limit, multiplier };
};

const divideRoundingUp = (numerator: bigint, denominator: bigint): bigint =>
  (numerator + denominator - 1n) / denominator;

/** Multiplies like checked Solidity arithmetic: the router reverts when a product passes 256 bits. */
const checkedProduct = (...factors: readonly bigint[]): bigint => {
  let product = 1n;
  for (const factor of factors) {
    product *= factor;
    if (product > UINT256_MAXIMUM) throw new RangeError("the fee arithmetic overflows 256 bits, so the router would revert");
  }
  return product;
};

/** Adds like checked Solidity arithmetic. */
const checkedSum = (left: bigint, right: bigint): bigint => {
  const sum = left + right;
  if (sum > UINT256_MAXIMUM) throw new RangeError("the fee arithmetic overflows 256 bits, so the router would revert");
  return sum;
};

const requireNonNegative = (name: string, value: bigint): void => {
  if (value < 0n) throw new RangeError(`${name} must not be negative`);
};

/** What a token is worth in wei. */
export interface TokenPrice {
  /** The value of one whole token in wei. For the wrapped native token this is 10^18. Must be above zero. */
  readonly tokenValueInWei: bigint;
  /** The decimals of the token. */
  readonly tokenDecimals: number;
}

const requirePrice = (price: TokenPrice): void => {
  if (price.tokenValueInWei <= 0n) throw new RangeError("the value of a token in wei must be above zero");
  if (!Number.isInteger(price.tokenDecimals) || price.tokenDecimals < 0 || price.tokenDecimals > 77) {
    throw new RangeError(`invalid token decimals: ${price.tokenDecimals}`);
  }
};

/**
 * Converts wei to base units of a token, rounded up, so that the amount always covers the wei.
 *
 * @param wei The amount in wei.
 * @param price What the token is worth.
 */
export const weiToTokenUnitsCeiling = (wei: bigint, price: TokenPrice): bigint => {
  requireNonNegative("wei", wei);
  requirePrice(price);
  return divideRoundingUp(wei * 10n ** BigInt(price.tokenDecimals), price.tokenValueInWei);
};

/**
 * Converts base units of a token to wei, rounded down, so that the amount never promises more than the tokens are worth.
 *
 * @param units The amount in base units.
 * @param price What the token is worth.
 */
export const tokenUnitsToWeiFloor = (units: bigint, price: TokenPrice): bigint => {
  requireNonNegative("units", units);
  requirePrice(price);
  return (units * price.tokenValueInWei) / 10n ** BigInt(price.tokenDecimals);
};

/** The default cost of one warm proof in US dollars: the measured cost of one proof on the remote graphics processor. */
export const DEFAULT_PROOF_COST_USD = "0.02";

/** Input of {@link proofCostWei}. */
export interface ProofCostInput {
  /** The cost of one proof in US dollars, as a decimal text such as `0.02`. */
  readonly proofCostUsd: string;
  /** The price of one whole native coin of the destination chain in US dollars, as a decimal text. Must be above zero. */
  readonly nativeCoinPriceUsd: string;
  /** How many deliveries one proof covers. Default: 1. */
  readonly deliveriesPerProof?: number;
}

/**
 * The share of a proof that one delivery pays, in wei of the native coin, rounded up. The conversion uses scaled bigint
 * math with 18 decimals. It never uses floating point.
 *
 * @param input The dollar cost, the coin price and the deliveries per proof.
 * @throws When a decimal text is malformed, the price is zero, or the deliveries per proof is not a positive integer.
 */
export const proofCostWei = (input: ProofCostInput): bigint => {
  const deliveries = input.deliveriesPerProof ?? 1;
  if (!Number.isInteger(deliveries) || deliveries < 1) throw new RangeError("deliveries per proof must be a positive integer");
  const proofUsd = parseTokenAmount(input.proofCostUsd, 18);
  const priceUsd = parseTokenAmount(input.nativeCoinPriceUsd, 18);
  if (priceUsd === 0n) throw new RangeError("the price of the native coin must be above zero");
  return divideRoundingUp(proofUsd * 10n ** 18n, priceUsd * BigInt(deliveries));
};

/** Input of {@link deliveryCostBreakdown}. */
export interface DeliveryCostInput {
  /** The gas of the delivery transaction. */
  readonly deliveryGas: bigint;
  /** The base fee of the destination chain, in wei per gas. */
  readonly baseFeeWei: bigint;
  /** The priority fee that the runner pays, in wei per gas. */
  readonly priorityFeeWei: bigint;
  /** Gas of a light client update that the runner spreads over the transfers that it covers. Default: none. */
  readonly updateShareGas?: bigint;
  /** The share of the proof cost that this delivery pays, in wei (see {@link proofCostWei}). Default: none. */
  readonly proofCostWei?: bigint;
}

/** The line items of the cost of a delivery. */
export interface DeliveryCostBreakdown {
  /** `(deliveryGas + updateShareGas) * (baseFee + priorityFee)`. */
  readonly gasCostWei: bigint;
  /** The share of the proof cost. An estimate: it comes from configured prices. */
  readonly proofCostWei: bigint;
  readonly totalWei: bigint;
}

/**
 * The cost of a delivery for the runner, as separate line items.
 *
 * @param input The gas, the prices and the proof share.
 */
export const deliveryCostBreakdown = (input: DeliveryCostInput): DeliveryCostBreakdown => {
  const updateShareGas = input.updateShareGas ?? 0n;
  const proofCost = input.proofCostWei ?? 0n;
  requireNonNegative("deliveryGas", input.deliveryGas);
  requireNonNegative("updateShareGas", updateShareGas);
  requireNonNegative("baseFeeWei", input.baseFeeWei);
  requireNonNegative("priorityFeeWei", input.priorityFeeWei);
  requireNonNegative("proofCostWei", proofCost);
  const gasCostWei = (input.deliveryGas + updateShareGas) * (input.baseFeeWei + input.priorityFeeWei);
  return { gasCostWei, proofCostWei: proofCost, totalWei: gasCostWei + proofCost };
};

/**
 * The wei that a delivery costs the runner: gas at the current prices, plus the proof share.
 *
 * @param input The gas, the prices and the proof share.
 */
export const deliveryCostWei = (input: DeliveryCostInput): bigint => deliveryCostBreakdown(input).totalWei;

/** Input of {@link suggestPercentage}. */
export interface SuggestPercentageInput extends TokenPrice {
  /** Who receives the tokens after the fee. */
  readonly recipient: Address;
  /** What the delivery costs the runner, in wei. */
  readonly costWei: bigint;
  /** The amount that the transfer delivers, in base units of the token. */
  readonly transferValue: bigint;
  /** The profit that the runner should see on top of the cost, scaled by 1e18. 0.1e18 is ten percent. */
  readonly marginRate: bigint;
  /** Default: `token`. `native` sets the unwrap flag. */
  readonly payout?: PayoutKind;
}

const payoutSettings = (payout: PayoutKind | undefined): bigint => (payout === "native" ? FEE_SETTING.unwrap : 0n);

/**
 * Suggests a share of the transfer. The multiplier is the fee over the value, scaled by 1e18, rounded up at every step,
 * so the fee that the router takes (`value * multiplier / 1e18`, rounded down) is never below the cost plus the margin.
 * A cost of zero gives a multiplier of zero.
 *
 * @param input The cost, the value and the price of the token.
 * @throws When the transfer is too small to pay for its delivery (the share would pass 100 percent), or an input is out of range.
 */
export const suggestPercentage = (input: SuggestPercentageInput): FeeDirector => {
  requireNonNegative("costWei", input.costWei);
  requireNonNegative("transferValue", input.transferValue);
  requireNonNegative("marginRate", input.marginRate);
  const settings = FEE_SETTING.shareOfValue | payoutSettings(input.payout);
  if (input.costWei === 0n) {
    requirePrice(input);
    return { recipient: input.recipient, settings, limit: 0n, multiplier: 0n };
  }
  const costUnits = weiToTokenUnitsCeiling(input.costWei, input);
  const feeUnits = divideRoundingUp(costUnits * (RATE_SCALE + input.marginRate), RATE_SCALE);
  if (input.transferValue === 0n || feeUnits > input.transferValue) {
    throw new RangeError("the transfer is too small to pay for its delivery");
  }
  const multiplier = divideRoundingUp(feeUnits * RATE_SCALE, input.transferValue);
  return { recipient: input.recipient, settings, limit: 0n, multiplier };
};

/**
 * Suggests a fixed fee: the cost plus the margin, in base units of the token, rounded up. The runner takes exactly this
 * amount (never above the value).
 *
 * @param input The cost, the value and the price of the token.
 * @throws When the fee would pass the transfer value, or an input is out of range.
 */
export const suggestFixed = (input: SuggestPercentageInput): FeeDirector => {
  requireNonNegative("costWei", input.costWei);
  requireNonNegative("transferValue", input.transferValue);
  requireNonNegative("marginRate", input.marginRate);
  const settings = FEE_SETTING.fixedFee | payoutSettings(input.payout);
  const costUnits = input.costWei === 0n ? 0n : weiToTokenUnitsCeiling(input.costWei, input);
  const limit = divideRoundingUp(costUnits * (RATE_SCALE + input.marginRate), RATE_SCALE);
  if (limit > input.transferValue) throw new RangeError("the transfer is too small to pay for its delivery");
  return { recipient: input.recipient, settings, limit, multiplier: 0n };
};

/**
 * What the sender says one wei of the native coin of the destination chain is worth, in base units of the token that
 * pays the fee. It is a ratio of two integers, so it stays exact. The price is the sender's own: nothing at delivery
 * reads or changes it. Example: when 1 native coin is worth 3,000 of a token with 6 decimals, one wei is worth
 * 3,000 * 10^6 / 10^18 base units, which is `{ numerator: 3_000_000_000n, denominator: 10n ** 18n }`.
 */
export interface SenderPrice {
  /** Base units of the token. Must be above zero. */
  readonly numerator: bigint;
  /** Wei. Must be above zero. */
  readonly denominator: bigint;
}

/**
 * The price that a token valuation gives: one whole token is worth `tokenValueInWei`, so one wei is worth
 * `10^decimals / tokenValueInWei` base units.
 *
 * @param price What the token is worth.
 */
export const senderPriceOfToken = (price: TokenPrice): SenderPrice => {
  requirePrice(price);
  return { numerator: 10n ** BigInt(price.tokenDecimals), denominator: price.tokenValueInWei };
};

/** The tip that the user interfaces offer by default: 0.1 percent of the transfer, in the share mode. */
export const DEFAULT_TIP_PERCENTAGE_MULTIPLIER = RATE_SCALE / 1000n;

/**
 * The default tip: the share mode with a multiplier of 1e15, which is 0.1 percent of the value. The recipient and the
 * payout are the caller's to set.
 *
 * @param recipient Who receives the tokens after the tip.
 * @param payout Default: `token`. `native` sets the unwrap flag.
 */
export const defaultTip = (recipient: Address, payout?: PayoutKind): FeeDirector => ({
  recipient,
  settings: FEE_SETTING.shareOfValue | payoutSettings(payout),
  limit: 0n,
  multiplier: DEFAULT_TIP_PERCENTAGE_MULTIPLIER,
});

/** Input of {@link suggestGasMultiplier}. */
export interface SuggestGasMultiplierInput {
  /** Who receives the tokens after the fee. */
  readonly recipient: Address;
  /** The sender's price of one wei of the native coin, in base units of the token. It is folded into the multiplier. */
  readonly senderPrice: SenderPrice;
  /** The factor on the gas cost, scaled by 1e18. 1.2e18 pays the runner twenty percent above its measured gas cost. */
  readonly margin: bigint;
  /** The base fee above which the sender will not pay more, in wei per gas. A spike above it cannot raise the fee. */
  readonly baseFeeCeilingWei: bigint;
  /** The gas that the router measures for the delivery. */
  readonly deliveryGas: bigint;
  /** The gas that the router adds. Default: the overhead of the payout. */
  readonly overheadGas?: bigint;
  /** The priority fee that the ceiling allows, in wei per gas. Ignored with `base-fee-only`. Default: zero. */
  readonly priorityFeeCeilingWei?: bigint;
  /** Default: `transaction`. `base-fee-only` sets the base fee flag. */
  readonly gasPrice?: GasPriceBasis;
  /** Default: `token`. `native` sets the unwrap flag and uses the smaller overhead. */
  readonly payout?: PayoutKind;
}

/**
 * The multiplier for the gas based mode, for any token: the sender's price is folded in at send time. The router
 * computes `gas * multiplier * gasPrice / 1e18` and caps it by the limit, both in base units of the token. So
 * `multiplier = (base units per wei) * margin * 1e18`, which is `numerator * margin / denominator` when `margin` is
 * scaled by 1e18. It rounds up, so the router never takes less than the price and the margin allow.
 *
 * @param senderPrice The sender's price of one wei, in base units of the token.
 * @param margin The factor on the gas cost, scaled by 1e18.
 * @throws When the price or the margin is not above zero, or the result does not fit in 96 bits (the router clamps it).
 */
export const gasMultiplierOf = (senderPrice: SenderPrice, margin: bigint): bigint => {
  if (senderPrice.numerator <= 0n || senderPrice.denominator <= 0n) throw new RangeError("the price of the native coin must be above zero");
  if (margin <= 0n) throw new RangeError("the margin must be above zero");
  const multiplier = divideRoundingUp(senderPrice.numerator * margin, senderPrice.denominator);
  if (multiplier > UINT96_MAXIMUM) throw new RangeError("the multiplier must fit in 96 bits");
  return multiplier;
};

/**
 * Suggests a gas based fee with a cap. The multiplier carries the sender's price (see {@link gasMultiplierOf}), so the
 * fee is in token units for any token. The limit is the fee at the ceiling base fee, in base units of the token and
 * rounded up. The router takes the lesser of its gas based fee and the limit, so a spike in the base fee cannot take
 * more than the limit.
 *
 * @param input The sender's price, the margin, the ceiling and the gas.
 * @throws When the price or the margin is not above zero, the multiplier does not fit in 96 bits, or an input is out of range.
 */
export const suggestGasMultiplier = (input: SuggestGasMultiplierInput): FeeDirector => {
  const payout = input.payout ?? "token";
  const gasPrice = input.gasPrice ?? "transaction";
  requireNonNegative("deliveryGas", input.deliveryGas);
  requireNonNegative("baseFeeCeilingWei", input.baseFeeCeilingWei);
  const multiplier = gasMultiplierOf(input.senderPrice, input.margin);
  const priorityFeeCeilingWei = gasPrice === "base-fee-only" ? 0n : (input.priorityFeeCeilingWei ?? 0n);
  requireNonNegative("priorityFeeCeilingWei", priorityFeeCeilingWei);
  const gas = input.deliveryGas + (input.overheadGas ?? OVERHEAD_OF[payout]);
  const limit = divideRoundingUp(gas * multiplier * (input.baseFeeCeilingWei + priorityFeeCeilingWei), RATE_SCALE);
  const settings = payoutSettings(payout) | (gasPrice === "base-fee-only" ? FEE_SETTING.baseFeeOnly : 0n);
  return { recipient: input.recipient, settings, limit, multiplier };
};

/** Input of {@link expectedFee}. */
export interface ExpectedFeeInput {
  /** The amount that the mediator releases to the router, in base units. */
  readonly value: bigint;
  /** The gas that the router measures, for a gas based fee. It does not matter for a fixed or share fee. */
  readonly gasUsed: bigint;
  /** The base fee of the destination chain, in wei per gas. */
  readonly baseFeeWei: bigint;
  /** The priority fee, in wei per gas. The transaction gas price is the base fee plus this. Default: zero. */
  readonly priorityFeeWei?: bigint;
  /** `native` when the token is the wrapped native token and the unwrap flag is set. Default: `token`. */
  readonly payout?: PayoutKind;
}

/** The split that `FeeRouter.feeInfo` returns. */
export interface FeeSplit {
  readonly fee: bigint;
  readonly toRecipient: bigint;
}

/**
 * The fee that the router takes, as `FeeRouter.feeInfo` computes it. Fixed: `limit`. Share: `value * multiplier / 1e18`.
 * Gas based: `(gasUsed + overhead) * multiplier * gasPrice / 1e18`, capped by `limit`. The fee never passes the value.
 *
 * `feeInfo` reads the multiplier in full. When it settles a gas based fee, the router clamps the multiplier to 96 bits.
 * {@link suggestGasMultiplier} refuses a larger multiplier, so the two agree for every director that this module builds.
 *
 * @param director The fee terms.
 * @param input The value, the gas and the prices.
 * @throws When the router would revert on an overflow of 256 bits.
 */
export const expectedFee = (director: FeeDirector, input: ExpectedFeeInput): FeeSplit => {
  const fee = clampToValue(rawFee(director, input), input.value);
  return { fee, toRecipient: input.value - fee };
};

const clampToValue = (fee: bigint, value: bigint): bigint => (fee > value ? value : fee);

const rawFee = (director: FeeDirector, input: ExpectedFeeInput): bigint => {
  const mode = feeModeOf(director.settings);
  if (mode === "fixed") return director.limit;
  if (mode === "share") return checkedProduct(input.value, director.multiplier) / RATE_SCALE;
  const priorityFeeWei = (director.settings & FEE_SETTING.baseFeeOnly) !== 0n ? 0n : (input.priorityFeeWei ?? 0n);
  const overhead = OVERHEAD_OF[input.payout ?? "token"];
  const uncapped = checkedProduct(checkedSum(input.gasUsed, overhead), director.multiplier, checkedSum(input.baseFeeWei, priorityFeeWei)) / RATE_SCALE;
  return uncapped > director.limit ? director.limit : uncapped;
};

/**
 * The most that a runner can take for a director from a transfer of `value`: the fee with no gas figure counted for a
 * fixed or share fee, and the cap for a gas based fee. In all cases it is no more than the value.
 *
 * @param director The fee terms.
 * @param value The amount that the mediator releases, in base units.
 * @throws When a share fee would overflow 256 bits.
 */
export const maximumFee = (director: FeeDirector, value: bigint): bigint => {
  const mode = feeModeOf(director.settings);
  if (mode === "gas") return clampToValue(director.limit, value);
  return expectedFee(director, { value, gasUsed: 0n, baseFeeWei: 0n }).fee;
};
