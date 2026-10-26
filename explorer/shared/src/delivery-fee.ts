import { type Address } from "viem";
import {
  ceilingDivide,
  gasOverheadOf,
  settingsOf,
  UINT96_MAXIMUM,
  type FeeDirector,
  type GasPriceBasis,
  type PayoutKind,
} from "./delivery-terms.js";
import { parseTokenAmount, RATE_SCALE } from "./format.js";

/**
 * Voluntary delivery tips: the suggestions. A sender who wants a delivery writes a `FeeDirector` in the callback data of
 * `relayTokensAndCall`, aimed at the `DeliveryRouter` of the destination chain. This module turns a cost, a price and a
 * margin into that director. It never sets a settings bit or computes a router fee itself: `delivery-terms.ts` holds the
 * flags, the encoding and the fee formulas that mirror the contract, and this module calls it.
 *
 * All amounts are bigint. A rate or a multiplier is scaled by `RATE_SCALE` (1e18).
 */

const divideRoundingUp = ceilingDivide;

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
  const settings = settingsOf({ mode: "share", payout: input.payout });
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
  const settings = settingsOf({ mode: "fixed", payout: input.payout });
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
  settings: settingsOf({ mode: "share", payout }),
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
  const gas = input.deliveryGas + (input.overheadGas ?? gasOverheadOf(payout));
  const limit = divideRoundingUp(gas * multiplier * (input.baseFeeCeilingWei + priorityFeeCeilingWei), RATE_SCALE);
  const settings = settingsOf({ mode: "gas", payout, gasPrice });
  return { recipient: input.recipient, settings, limit, multiplier };
};
