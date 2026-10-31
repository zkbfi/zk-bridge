/**
 * The fee rules of the bridge screen, as pure functions any dapp can run (spec: "Determinism", "SDK", "Gas levels",
 * "Default fee curve", "High-tip warning", "Small transfers", "The $0.025 proof cost").
 *
 * Units, all integers (bigint): token amounts in base units, gas prices in wei, money in USD **micro-dollars**
 * (1 USD = 1,000,000), shares of the amount scaled by 1e18 (`WAD`: 1% = 1e16, the router's own multiplier scale), and
 * prices as USD per whole token scaled by 1e18 (`priceE18`: $1 = 1e18).
 *
 * Rounding: one rule, **down** (truncating division), toward the user: a cost, a fee and a share are never rounded up.
 * Comparisons are exact (cross-multiplied), so no threshold is rounded at all. No floats, epsilons, clock, randomness or
 * I/O; prices and gas come from the caller, read at a named block. The fixed vectors in
 * `test/fixtures/fee-rules-vectors.json` pin every rule.
 */
import { expNegScaled, FIXED_SCALE, lnScaled } from "./fixed-point.js";

/** A share of the amount: 1e18 is 100%. */
export const WAD = 10n ** 18n;
/** 1% as a share. */
export const PERCENT_WAD = WAD / 100n;
/** Micro-dollars in a dollar. */
export const MICRO_USD = 1_000_000n;
/** What generating the proof costs, in micro-dollars ($0.025). The one place it is set. */
export const PROOF_COST_MICRO_USD = 25_000n;
/** The fee must be this many times the total cost (a 100% margin) for the low-fee warning to clear. */
export const COST_MARGIN = 2n;
/** The automatic fee's cap by default: 1%. */
export const DEFAULT_CAP_WAD = PERCENT_WAD;
/** The automatic fee without a price: 0.1% (or the cap, if lower). */
export const NO_PRICE_SHARE_WAD = PERCENT_WAD / 10n;

/** The gas level: 1 Normal, 2 High, 3 Highest. */
export type GasLevel = 1 | 2 | 3;

/**
 * Each gas level: the ceiling it writes (the highest base fee the deliverer may spend) as a multiple of today's base fee,
 * and the base fee it is expected to cost, in halves of today's (2/2 = 1×, 3/2 = 1.5×, 5/2 = 2.5×).
 */
export const GAS_LEVELS: Readonly<Record<GasLevel, { readonly ceilingFactor: bigint; readonly expectedHalves: bigint }>> = {
  1: { ceilingFactor: 2n, expectedHalves: 2n },
  2: { ceilingFactor: 3n, expectedHalves: 3n },
  3: { ceilingFactor: 5n, expectedHalves: 5n },
};

const LEVELS: readonly GasLevel[] = [1, 2, 3];
const PRICE_TO_MICRO = 10n ** 12n; // priceE18 → micro-dollars

/**
 * The base-fee ceiling a level writes, in wei: today's base fee × 2, 3 or 5.
 *
 * @param baseFeeWei Today's base fee.
 * @param level The gas level.
 */
export const ceilingWeiOf = (baseFeeWei: bigint, level: GasLevel): bigint => baseFeeWei * GAS_LEVELS[level].ceilingFactor;

/**
 * The level a signed ceiling stands for: the one whose ceiling is nearest, against today's base fee; a tie goes to the
 * lower level. No ceiling, or no base fee, is Normal.
 *
 * @param ceilingWei The ceiling, in wei, or null.
 * @param baseFeeWei Today's base fee, or null.
 */
export const gasLevelOfCeiling = (ceilingWei: bigint | null, baseFeeWei: bigint | null): GasLevel => {
  if (ceilingWei === null || baseFeeWei === null || baseFeeWei === 0n) return 1;
  const distance = (level: GasLevel): bigint => {
    const gap = ceilingWei - ceilingWeiOf(baseFeeWei, level);
    return gap < 0n ? -gap : gap;
  };
  return LEVELS.reduce((best, level) => (distance(level) < distance(best) ? level : best), 1 as GasLevel);
};

/**
 * The dollar value of a token amount, in micro-dollars, rounded down.
 *
 * @param units The amount in base units.
 * @param decimals The token's decimals.
 * @param priceE18 USD per whole token × 1e18.
 */
export const usdMicroOf = (units: bigint, decimals: number, priceE18: bigint): bigint => (units * priceE18) / (10n ** BigInt(decimals) * PRICE_TO_MICRO);

/** What the delivery gas and the total cost read. */
export type CostInput = {
  /** The gas of the delivery transaction. */
  readonly gasUsed: bigint;
  /** Today's base fee on the destination, in wei. */
  readonly baseFeeWei: bigint;
  /** The priority fee the deliverer pays, in wei. */
  readonly priorityFeeWei: bigint;
  /** One native coin of the destination, USD × 1e18. */
  readonly nativePriceE18: bigint;
  readonly level: GasLevel;
};

/**
 * The delivery gas at the level's expected price, in micro-dollars: gasUsed × (base fee × level + priority fee) ×
 * price, rounded down once.
 */
export const deliveryGasMicroUsd = (input: CostInput): bigint =>
  (input.gasUsed * (input.baseFeeWei * GAS_LEVELS[input.level].expectedHalves + 2n * input.priorityFeeWei) * input.nativePriceE18) / (2n * WAD * PRICE_TO_MICRO);

/**
 * The total cost of releasing this bridge as if it were the only one, in micro-dollars: the $0.025 proof plus the
 * delivery gas at the level. Every percentage is set against it.
 */
export const totalCostMicroUsd = (input: CostInput): bigint => PROOF_COST_MICRO_USD + deliveryGasMicroUsd(input);

/** The default curve's ends: 1% at $10 and below, 0.1% at $500 and above. */
const CURVE_LOW_MICRO_USD = 10n * MICRO_USD;
const CURVE_HIGH_MICRO_USD = 500n * MICRO_USD;
const LN10 = lnScaled(10n * FIXED_SCALE);
const LN50 = lnScaled(50n * FIXED_SCALE);
const FIXED_PER_WAD = FIXED_SCALE / WAD;

/**
 * The default share of the amount: 1% × (10 / amount)^(ln 10 / ln 50) between $10 and $500, 1% below, 0.1% from $500.
 * Computed as 1% × exp(−ln(amount / 10) × ln 10 / ln 50) in 1e36 fixed point (see `fixed-point.ts`), then truncated to
 * 18 decimals.
 *
 * @param amountMicroUsd The amount, in micro-dollars.
 */
export const defaultCurveShareWad = (amountMicroUsd: bigint): bigint => {
  if (amountMicroUsd <= CURVE_LOW_MICRO_USD) return PERCENT_WAD;
  if (amountMicroUsd >= CURVE_HIGH_MICRO_USD) return PERCENT_WAD / 10n;
  const lnRatio = lnScaled((amountMicroUsd * FIXED_SCALE) / CURVE_LOW_MICRO_USD);
  return expNegScaled((lnRatio * LN10) / LN50) / 100n / FIXED_PER_WAD;
};

/** Which term set the default fee. */
export type FeeBinding = "curve" | "cost" | "cap" | "no-price";

/** The default fee. */
export type DefaultFee = {
  readonly binding: FeeBinding;
  /** The share to sign (the router's multiplier): the largest share whose fee is no more than {@link feeMicroUsd}. */
  readonly shareWad: bigint;
  /** The fee in micro-dollars, or null without prices. */
  readonly feeMicroUsd: bigint | null;
};

/**
 * The default fee: the larger of the curve's share of the amount and 2 × the total cost, then no more than the cap. A
 * tie between curve and cost reads as the curve; the cap binds only when it is strictly lower. Without an amount, a
 * price or a cost, it is 0.1% (or the cap, if lower).
 *
 * @param input The amount and the total cost in micro-dollars (null when unpriced), and the cap as a share.
 */
export const defaultFee = (input: { readonly amountMicroUsd: bigint | null; readonly costMicroUsd: bigint | null; readonly capWad: bigint }): DefaultFee => {
  const { amountMicroUsd: amount, costMicroUsd: cost, capWad } = input;
  if (amount === null || cost === null || amount <= 0n) return { binding: "no-price", shareWad: capWad < NO_PRICE_SHARE_WAD ? capWad : NO_PRICE_SHARE_WAD, feeMicroUsd: null };
  const curveShare = defaultCurveShareWad(amount);
  const curveFee = (amount * curveShare) / WAD;
  const costFee = COST_MARGIN * cost;
  const capFee = (amount * capWad) / WAD;
  const wanted = curveFee >= costFee ? { binding: "curve" as const, fee: curveFee, share: curveShare } : { binding: "cost" as const, fee: costFee, share: (costFee * WAD) / amount };
  if (capFee < wanted.fee) return { binding: "cap", shareWad: capWad, feeMicroUsd: capFee };
  return { binding: wanted.binding, shareWad: wanted.share, feeMicroUsd: wanted.fee };
};

/** A share as an exact fraction. */
export type Fraction = { readonly numerator: bigint; readonly denominator: bigint };

/**
 * The "High cap %" line, as an exact fraction of the amount: 1% up to $100, 1% × 100 / amount from $100 to $1,000 (a
 * tip of exactly $1), 0.1% from $1,000. 1% without a price.
 *
 * @param amountMicroUsd The amount, or null.
 */
export const highCapLine = (amountMicroUsd: bigint | null): Fraction => {
  if (amountMicroUsd === null || amountMicroUsd <= 100n * MICRO_USD) return { numerator: 1n, denominator: 100n };
  if (amountMicroUsd >= 1_000n * MICRO_USD) return { numerator: 1n, denominator: 1_000n };
  return { numerator: MICRO_USD, denominator: amountMicroUsd };
};

/**
 * Whether the tip is a "High cap %": the tip before gas (the fee less the total cost at Normal, so the gas level never
 * moves it) over the amount is above {@link highCapLine}. Without prices, the fee's share against 1%.
 */
export const highCap = (input: { readonly feeMicroUsd: bigint | null; readonly costNormalMicroUsd: bigint | null; readonly amountMicroUsd: bigint | null; readonly shareWithoutPriceWad: bigint | null }): boolean => {
  const { feeMicroUsd: fee, costNormalMicroUsd: cost, amountMicroUsd: amount } = input;
  if (fee !== null && cost !== null && amount !== null && amount > 0n) {
    const tip = fee > cost ? fee - cost : 0n;
    const line = highCapLine(amount);
    return tip * line.denominator > line.numerator * amount;
  }
  return input.shareWithoutPriceWad !== null && input.shareWithoutPriceWad > PERCENT_WAD;
};

/**
 * Whether the transfer is small: the total cost is more than the share the user is willing to pay (their cap) of the
 * amount, so it "may not be delivered in a timely manner". False without prices.
 */
export const smallTransfer = (input: { readonly costMicroUsd: bigint | null; readonly amountMicroUsd: bigint | null; readonly capWad: bigint }): boolean =>
  input.costMicroUsd !== null && input.amountMicroUsd !== null && input.costMicroUsd * WAD > input.capWad * input.amountMicroUsd;

/** Whether the fee is too low: under 2 × the total cost; without prices, the bots' break-even. */
export const lowFee = (input: { readonly feeMicroUsd: bigint | null; readonly costMicroUsd: bigint | null; readonly belowBreakEven: boolean }): boolean =>
  input.feeMicroUsd === null || input.costMicroUsd === null ? input.belowBreakEven : input.feeMicroUsd < COST_MARGIN * input.costMicroUsd;

/**
 * The expanded cost of a gas-based fee, in micro-dollars: the $0.025 proof plus the delivery gas at the level's
 * ceiling (2×, 3× or 5× today's base fee, plus the priority fee once): the most the signed terms let the cost drift to.
 */
export const ceilingCostMicroUsd = (input: CostInput): bigint =>
  PROOF_COST_MICRO_USD + (input.gasUsed * (input.baseFeeWei * GAS_LEVELS[input.level].ceilingFactor + input.priorityFeeWei) * input.nativePriceE18) / (WAD * PRICE_TO_MICRO);

/**
 * Whether the review warns "High cap %" about the cap (owner, quotes 70–71). Only the gas-based mode can drift after
 * signing; percent and fixed fees are known ahead of time and never warn here. In gas-based mode the fee is recomputed
 * at the expanded cost ({@link ceilingCostMicroUsd}) by the default rule, limited by the cap, and it warns when that fee
 * less the estimated total cost at Normal is above the {@link highCapLine}. One function, so the reading changes in one
 * place.
 */
export const capWarns = (input: { readonly gasBased: boolean; readonly amountMicroUsd: bigint | null; readonly capWad: bigint; readonly expandedCostMicroUsd: bigint | null; readonly costNormalMicroUsd: bigint | null }): boolean => {
  if (!input.gasBased || input.expandedCostMicroUsd === null || input.costNormalMicroUsd === null) return false;
  const atExpanded = defaultFee({ amountMicroUsd: input.amountMicroUsd, costMicroUsd: input.expandedCostMicroUsd, capWad: input.capWad }).feeMicroUsd;
  return atExpanded !== null && highCap({ feeMicroUsd: atExpanded, costNormalMicroUsd: input.costNormalMicroUsd, amountMicroUsd: input.amountMicroUsd, shareWithoutPriceWad: null });
};

/** Everything {@link feeWarnings} reads. */
export type FeeWarningsInput = {
  readonly amountMicroUsd: bigint | null;
  readonly capWad: bigint;
  readonly feeMicroUsd: bigint | null;
  /** The total cost at the chosen gas level. */
  readonly costMicroUsd: bigint | null;
  /** The total cost at Normal, for the tip before gas. */
  readonly costNormalMicroUsd: bigint | null;
  readonly shareWithoutPriceWad: bigint | null;
  readonly belowBreakEven: boolean;
  /** The tip is gas-based (base fee / gas+), so it can drift after signing. */
  readonly gasBased: boolean;
  /** The cost at the gas level's ceiling, for the cap warning ({@link ceilingCostMicroUsd}). */
  readonly expandedCostMicroUsd: bigint | null;
};

/** The fee's warnings. */
export type FeeWarnings = { readonly smallTransfer: boolean; readonly lowFee: boolean; readonly highCap: boolean; readonly capWarning: boolean };

/**
 * The fee's warnings together. In the small-transfer zone "High cap %" and the cap warning do not show: any fee that
 * covers the cost reads as a high share there.
 */
export const feeWarnings = (input: FeeWarningsInput): FeeWarnings => {
  const small = smallTransfer({ costMicroUsd: input.costMicroUsd, amountMicroUsd: input.amountMicroUsd, capWad: input.capWad });
  return {
    smallTransfer: small,
    lowFee: lowFee({ feeMicroUsd: input.feeMicroUsd, costMicroUsd: input.costMicroUsd, belowBreakEven: input.belowBreakEven }),
    highCap: !small && highCap({ feeMicroUsd: input.feeMicroUsd, costNormalMicroUsd: input.costNormalMicroUsd, amountMicroUsd: input.amountMicroUsd, shareWithoutPriceWad: input.shareWithoutPriceWad }),
    capWarning: !small && capWarns({ gasBased: input.gasBased, amountMicroUsd: input.amountMicroUsd, capWad: input.capWad, expandedCostMicroUsd: input.expandedCostMicroUsd, costNormalMicroUsd: input.costNormalMicroUsd }),
  };
};

/**
 * A percentage as typed ("0.5", "0.5%", ".5") as an exact share, or null when it is not a number with at most 16
 * decimals.
 *
 * @param text The percentage.
 */
export const shareWadOfPercentText = (text: string): bigint | null => {
  const trimmed = text.trim().replace(/%$/, "").trim();
  const match = /^(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (match === null || trimmed === "" || trimmed === "." || (match[2] ?? "").length > 16) return null;
  return BigInt(`${match[1] === "" ? "0" : match[1]}${(match[2] ?? "").padEnd(16, "0")}`);
};
