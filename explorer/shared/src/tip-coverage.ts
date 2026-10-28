import { deliveryCostWei, tokenUnitsToWeiFloor, type TokenPrice } from "./delivery-fee.js";
import { expectedFee, maximumFee, type FeeDirector, type PayoutKind } from "./delivery-terms.js";
import { formatTokenAmount } from "./format.js";
import { TIP_VOLUNTARY } from "./tip-copy.js";

/** How far the base fee axis reaches, as a multiple of the base fee now. */
export const BASE_FEE_AXIS_FACTOR = 4n;

/** One point of the two graphs: the delivery cost and the user's tip at one base fee, both in wei. */
export interface TipCoveragePoint {
  readonly baseFeeWei: bigint;
  readonly costWei: bigint;
  readonly tipWei: bigint;
}

/** Input of {@link tipCoverage}. */
export interface TipCoverageInput {
  readonly director: FeeDirector;
  /** The delivery gas that the cost and a gas based tip are priced at. */
  readonly deliveryGas: bigint;
  /** The priority fee, in wei per gas. */
  readonly priorityFeeWei: bigint;
  /** The base fee now, in wei per gas. Must be above zero. The graphs run from zero to four times this. */
  readonly baseFeeNowWei: bigint;
  /** The amount that the router receives, in base units of the token. */
  readonly transferValue: bigint;
  /** What the token is worth, to turn the tip into wei. */
  readonly price: TokenPrice;
  /** How many points to return. At least two. */
  readonly points: number;
  /** How the tip is paid out. Default: `token`. */
  readonly payout?: PayoutKind;
}

/** The two lines, and where the tip covers the cost. */
export interface TipCoverage {
  readonly points: readonly TipCoveragePoint[];
  /** The lowest base fee on the axis at which the tip covers the cost, or null when it covers nowhere. */
  readonly coveredFromBaseFeeWei: bigint | null;
  /** The highest base fee on the axis at which the tip covers the cost, or null when it covers nowhere. */
  readonly coveredUpToBaseFeeWei: bigint | null;
  /** True when the tip covers the cost at every base fee on the axis. */
  readonly coveredEverywhere: boolean;
}

/**
 * The delivery cost and the tip of a director at every base fee from zero to four times the base fee now. The cost line
 * rises with the base fee. A fixed or share tip is flat. A gas based tip rises with the base fee up to its limit and then
 * stays flat. The difference of the tip and the cost is a straight line with at most one bend (where the limit starts to
 * hold), so the base fees where the tip covers the cost form one stretch. The function finds the ends of that stretch
 * exactly, not only on the grid of points.
 *
 * @param input The director, the gas, the prices and the number of points.
 * @throws When the base fee now is not above zero, or fewer than two points are asked for.
 */
export const tipCoverage = (input: TipCoverageInput): TipCoverage => {
  if (input.baseFeeNowWei <= 0n) throw new RangeError("the base fee now must be above zero");
  if (!Number.isInteger(input.points) || input.points < 2) throw new RangeError("at least two points are needed");
  const axisEnd = input.baseFeeNowWei * BASE_FEE_AXIS_FACTOR;
  const feeUnitsAt = (baseFeeWei: bigint): bigint =>
    expectedFee(input.director, {
      value: input.transferValue,
      gasUsed: input.deliveryGas,
      baseFeeWei,
      priorityFeeWei: input.priorityFeeWei,
      ...(input.payout === undefined ? {} : { payout: input.payout }),
    }).fee;
  const pointAt = (baseFeeWei: bigint): TipCoveragePoint => ({
    baseFeeWei,
    costWei: deliveryCostWei({ deliveryGas: input.deliveryGas, baseFeeWei, priorityFeeWei: input.priorityFeeWei }),
    tipWei: tokenUnitsToWeiFloor(feeUnitsAt(baseFeeWei), input.price),
  });
  const covers = (baseFeeWei: bigint): boolean => {
    const point = pointAt(baseFeeWei);
    return point.tipWei >= point.costWei;
  };
  const last = BigInt(input.points - 1);
  const points = Array.from({ length: input.points }, (_, index) => pointAt((axisEnd * BigInt(index)) / last));
  const peak = peakOf({ axisEnd, covers, atLimit: (baseFeeWei) => feeUnitsAt(baseFeeWei) >= maximumFee(input.director, input.transferValue) });
  if (peak === null) return { points, coveredFromBaseFeeWei: null, coveredUpToBaseFeeWei: null, coveredEverywhere: false };
  const from = firstWhere(0n, peak, covers);
  const upTo = lastWhere(peak, axisEnd, covers);
  return { points, coveredFromBaseFeeWei: from, coveredUpToBaseFeeWei: upTo, coveredEverywhere: from === 0n && upTo === axisEnd };
};

/** The first value in `[low, high]` where a rising test turns true, given that it is true at `high`. */
const firstWhere = (low: bigint, high: bigint, test: (value: bigint) => boolean): bigint => {
  let lo = low;
  let hi = high;
  while (lo < hi) {
    const middle = (lo + hi) / 2n;
    if (test(middle)) hi = middle;
    else lo = middle + 1n;
  }
  return lo;
};

/** The last value in `[low, high]` where a falling test is still true, given that it is true at `low`. */
const lastWhere = (low: bigint, high: bigint, test: (value: bigint) => boolean): bigint => {
  let lo = low;
  let hi = high;
  while (lo < hi) {
    const middle = (lo + hi + 1n) / 2n;
    if (test(middle)) lo = middle;
    else hi = middle - 1n;
  }
  return lo;
};

/**
 * A base fee where the tip covers the cost, or null when there is none. The gap between tip and cost is concave, so its
 * highest value is at zero, at the end of the axis, or where the limit starts to hold. Those three places are enough.
 */
const peakOf = (input: { readonly axisEnd: bigint; readonly covers: (baseFeeWei: bigint) => boolean; readonly atLimit: (baseFeeWei: bigint) => boolean }): bigint | null => {
  const bend = input.atLimit(input.axisEnd) ? firstWhere(0n, input.axisEnd, input.atLimit) : input.axisEnd;
  const candidates = [0n, bend > 0n ? bend - 1n : 0n, bend, input.axisEnd];
  return candidates.find(input.covers) ?? null;
};

const gweiText = (wei: bigint): string => formatTokenAmount(wei, 9, { fractionDigits: 1 });

const LOSS_WORDS = `a deliverer loses money on it, and the message may wait. Anyone can still deliver it. ${TIP_VOLUNTARY}`;

/**
 * Plain words for the user on where the tip stops covering the delivery cost. It promises nothing in return for a tip.
 *
 * @param result The result of {@link tipCoverage}.
 * @param chainName The name of the chain where the delivery happens.
 */
export const coverageSentence = (result: TipCoverage, chainName: string): string => {
  const axisEnd = result.points[result.points.length - 1]?.baseFeeWei ?? 0n;
  if (result.coveredUpToBaseFeeWei === null || result.coveredFromBaseFeeWei === null) {
    return `Your tip stays under the delivery cost at every base fee on ${chainName} up to ${gweiText(axisEnd)} gwei. At any of them, ${LOSS_WORDS}`;
  }
  if (result.coveredEverywhere) {
    return `Your tip covers the delivery cost at every base fee on ${chainName} up to ${gweiText(axisEnd)} gwei, which is the end of the graph. ${TIP_VOLUNTARY}`;
  }
  if (result.coveredFromBaseFeeWei > 0n) {
    return `Your tip covers the delivery cost only while the base fee on ${chainName} stays between ${gweiText(result.coveredFromBaseFeeWei)} and ${gweiText(result.coveredUpToBaseFeeWei)} gwei. Outside that, ${LOSS_WORDS}`;
  }
  return `Your tip covers the delivery cost while the base fee on ${chainName} stays under ${gweiText(result.coveredUpToBaseFeeWei)} gwei. Above that, ${LOSS_WORDS}`;
};
