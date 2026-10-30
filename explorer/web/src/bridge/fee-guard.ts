/**
 * The fee's two warnings, as pure functions (owner: "we need to make a 100% margin on the anticipated cost to execute
 * the bridge (assume a $0.025 cost for the proof generation) for the warning to go away", and "warn when a tip is >1%
 * for bridges under $100. then scale it down to 0.1% as it goes to $1000").
 *
 * The fee is one amount (tip and delivery together). The anticipated cost is the destination gas at the chosen gas
 * level plus the proof generation; the fee must be twice it. Dollar values come from the display oracle, so these only
 * pick warnings: they never set an amount.
 */

/** What generating the proof is assumed to cost, in dollars. */
export const PROOF_COST_USD = 0.025;

/** The fee must be this many times the anticipated cost (a 100% margin). */
export const COST_MARGIN = 2;

/** The gas levels: how far above today's base fee the anticipated delivery gas is priced. */
export const GAS_LEVEL_FACTORS = { 1: 1, 2: 1.5, 3: 2.5 } as const;

/** The gas level on the gas can. */
export type GasLevel = keyof typeof GAS_LEVEL_FACTORS;

/** The ceiling (the highest base fee the deliverer may spend) is this many times the level's price: 2×, 3×, 5×. */
export const CEILING_FACTOR = 2;

/** The base-fee ceiling a level writes, in wei: today's base fee × level factor × {@link CEILING_FACTOR}. */
export const ceilingWeiOf = (baseFeeWei: bigint, level: GasLevel): bigint => (baseFeeWei * BigInt(GAS_LEVEL_FACTORS[level] * CEILING_FACTOR * 10)) / 10n;

/**
 * The level a typed ceiling stands for: the nearest one, against today's base fee. No ceiling is Normal.
 *
 * @param ceilingGweiText The ceiling in the address, in gwei.
 * @param baseFeeWei Today's base fee.
 */
export const gasLevelOfCeiling = (ceilingGweiText: string | undefined, baseFeeWei: bigint | null): GasLevel => {
  if (ceilingGweiText === undefined || baseFeeWei === null || baseFeeWei === 0n) return 1;
  const ratio = (Number(ceilingGweiText) * 1e9) / Number(baseFeeWei);
  const levels = [1, 2, 3] as const;
  return levels.reduce((best, level) => (Math.abs(GAS_LEVEL_FACTORS[level] * CEILING_FACTOR - ratio) < Math.abs(GAS_LEVEL_FACTORS[best] * CEILING_FACTOR - ratio) ? level : best), 1 as GasLevel);
};

/** What {@link anticipatedCostUsd} reads. */
export type CostInput = {
  readonly gasUsed: bigint;
  readonly baseFeeWei: bigint;
  readonly priorityFeeWei: bigint;
  /** One native coin of the destination chain, in dollars. */
  readonly nativeUsd: number;
  readonly level: GasLevel;
};

/** The anticipated cost of executing the bridge, in dollars: the delivery gas at the level's price, plus the proof. */
export const anticipatedCostUsd = (input: CostInput): number => {
  const priceWei = Number(input.baseFeeWei) * GAS_LEVEL_FACTORS[input.level] + Number(input.priorityFeeWei);
  return ((Number(input.gasUsed) * priceWei) / 1e18) * input.nativeUsd + PROOF_COST_USD;
};

/**
 * Whether the fee is too low: under twice the anticipated cost. Without dollar values it falls back to the bots'
 * break-even.
 */
export const lowFeeOf = (input: { readonly feeUsd: number | null; readonly costUsd: number | null; readonly belowBreakEven: boolean }): boolean =>
  input.feeUsd === null || input.costUsd === null ? input.belowBreakEven : input.feeUsd < COST_MARGIN * input.costUsd;

/**
 * The largest share of the amount the tip may be before it warns: 1% up to $100, 1% × 100 / amount up to $1,000 (about
 * a $1 tip across that range), 0.1% from there. 1% when the amount has no price.
 *
 * @param amountUsd The amount in dollars, or null.
 */
export const highTipThreshold = (amountUsd: number | null): number => {
  if (amountUsd === null || amountUsd <= 100) return 0.01;
  if (amountUsd >= 1_000) return 0.001;
  return (0.01 * 100) / amountUsd;
};

/**
 * Whether the tip is high. The tip is the fee before gas pricing: the fee less the anticipated cost. The caller passes
 * the cost at the Normal level, so the gas level never triggers or clears it. Without prices it reads the tip's share
 * of the amount against 1%.
 */
export const highTipOf = (input: { readonly feeUsd: number | null; readonly costUsd: number | null; readonly amountUsd: number | null; readonly shareWithoutPrice: number | null }): boolean => {
  if (input.feeUsd !== null && input.costUsd !== null && input.amountUsd !== null && input.amountUsd > 0) {
    return (input.feeUsd - input.costUsd) / input.amountUsd > highTipThreshold(input.amountUsd);
  }
  return input.shareWithoutPrice !== null && input.shareWithoutPrice > highTipThreshold(null);
};

/** The automatic fee never goes above this share of the amount by default, in percent (owner: "cap ... at 1%"). */
export const DEFAULT_AUTO_CAP_PERCENT = 1;

/** The automatic fee's floor as a share of the amount, in percent. */
export const BASE_FEE_PERCENT = 0.1;

/**
 * The automatic fee as a percentage of the amount (owner: "make the default the larger of the two"): the larger of
 * {@link BASE_FEE_PERCENT} and twice the anticipated cost, then no more than the cap. `capped` says the cap bound, so
 * the fee sits under twice the cost and the low-fee warning stays. Without prices it is the base share.
 */
export const autoFeePercent = (input: { readonly amountUsd: number | null; readonly costUsd: number | null; readonly capPercent: number }): { readonly percent: number; readonly capped: boolean } => {
  const needed = input.amountUsd === null || input.costUsd === null || input.amountUsd <= 0 ? 0 : (COST_MARGIN * input.costUsd * 100) / input.amountUsd;
  // Up to a thousandth of a percent, ignoring float noise.
  const wanted = Math.max(BASE_FEE_PERCENT, Math.ceil(needed * 1000 - 1e-6) / 1000);
  return wanted > input.capPercent ? { percent: input.capPercent, capped: true } : { percent: wanted, capped: false };
};

/**
 * Whether the automatic cap is too large for this amount: above the high-tip line ({@link highTipThreshold}). The review
 * always warns about it and offers to lower it. One function, so the reading can change in one place.
 *
 * @param capPercent The cap, in percent.
 * @param amountUsd The amount in dollars, or null.
 */
export const capTooLarge = (capPercent: number, amountUsd: number | null): boolean => capPercent / 100 > highTipThreshold(amountUsd) + 1e-12;
