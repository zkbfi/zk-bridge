/**
 * The one verdict on a tip, used by the dapp (the fee warning and the wait), the backend (whether a batch pays to prove
 * at finality) and the delivery runner (whether it delivers now).
 *
 * - A priced tip (the token and the destination coin both have a usable price, `token-pricing.ts`) is judged by a
 *   profit rule against the delivery cost: `pays` or `below-cost`.
 * - An unpriced tip (no market, or the source unreachable with no recent price) cannot be valued. Owner, 2026-11-09:
 *   a tip of at least the frontend's automatic maximum ({@link DEFAULT_CAP_WAD}, 1% of the amount) counts as paying,
 *   and the runner delivers it straight away ("yes, deliver straight away"): `unpriced-at-max`. A smaller tip, or none,
 *   is `unpriced-below-max`: it does not pay, and the runner's hourly unpaid rule applies to it.
 *
 * The profit rules, one per place that judges (each keeps its own semantics; {@link ProfitRule}):
 *
 * - `margin` (the backend's `profitMargin`, the dapp's 2× `COST_MARGIN`): pays when the fee's value reaches the cost
 *   times the margin, the product rounded up. The backend's cost is the proof plus the delivery gas of each message,
 *   for the fees that reach the fee address; the dapp's is the total cost at the gas level.
 * - `loss` (the runner's `maximumLossPercent`): pays when the runner's loss, the gas cost less the tip, stays under
 *   that share of the cost: `(cost − fee) × 100 < maximumLossPercent × cost`, and always when the tip covers the cost.
 *   The runner's cost is the gas it spends, with its share of a light client update.
 *
 * Pure: integers only, the fee and the cost in one unit the caller chooses (wei of the destination coin or USD × 1e18),
 * and the token's value per whole token in that same unit.
 */
import { DEFAULT_CAP_WAD, WAD } from "./fee-rules.js";
import { expectedFee, type ExpectedFeeInput, type FeeDirector } from "./delivery-terms.js";
import { isUsablePrice, type PriceState } from "./token-pricing.js";
import { withMargin } from "./wait-estimates.js";

/** The verdict on a tip. */
export type TipVerdict = "pays" | "below-cost" | "unpriced-at-max" | "unpriced-below-max";

/** The rule a priced tip is judged by. */
export type ProfitRule =
  /** The fee's value reaches the cost times `marginWad` (1e18 = 1), rounded up. */
  | { readonly kind: "margin"; readonly marginWad: bigint }
  /** The loss (cost − fee) stays under `maximumLossPercent` percent of the cost; a fee at or above the cost always pays. */
  | { readonly kind: "loss"; readonly maximumLossPercent: number };

/** What {@link tipVerdict} reads. */
export type TipVerdictInput = {
  /** The amount the transfer releases to the delivery router, in base units of the token. */
  readonly amount: bigint;
  /** The tip the router takes, in base units of the token (0 for no tip). */
  readonly fee: bigint;
  /** The token's decimals. */
  readonly decimals: number;
  /**
   * The token's price state and its value per whole token in the cost's unit (null when it has none). Use the
   * combined state of the token and the destination coin (`tokenValuationOf`).
   */
  readonly price: { readonly state: PriceState; readonly perWholeToken: bigint | null };
  /** The delivery cost estimate in the same unit, or null when it cannot be valued. */
  readonly cost: bigint | null;
  readonly rule: ProfitRule;
  /**
   * The fee's value in the cost's unit when the caller has it already (the dapp's automatic fee is the fee rule's own
   * figure, which the share it signs rounds down by at most a unit). Used only while the price is usable; absent or
   * null, the value is `fee` at the price ({@link feeValueOf}).
   */
  readonly feeValue?: bigint | null;
};

/**
 * Whether a tip is at least the frontend's automatic maximum of the amount ({@link DEFAULT_CAP_WAD}, 1%), in base units,
 * so it needs no price. The maximum is the tip the dapp signs for it: the router's share, `amount × 1% / 1e18` rounded
 * down, so the automatic 1% always reaches it. A tip of nothing never does, also where 1% of a tiny amount rounds to 0.
 *
 * @param fee The tip, in base units.
 * @param amount The amount, in base units.
 */
export const atAutomaticMaximum = (fee: bigint, amount: bigint): boolean => fee > 0n && fee >= (amount * DEFAULT_CAP_WAD) / WAD;

/**
 * Whether a valued fee meets the profit rule against a cost (both in one unit).
 *
 * @param feeValue The fee's value.
 * @param cost The cost.
 * @param rule The rule.
 */
export const meetsProfitRule = (feeValue: bigint, cost: bigint, rule: ProfitRule): boolean => {
  if (rule.kind === "margin") return feeValue >= withMargin(cost, rule.marginWad);
  const loss = cost - feeValue;
  return loss <= 0n || loss * 100n < BigInt(rule.maximumLossPercent) * cost;
};

/** Whether a verdict counts as paying: the runner delivers it now, and its batch proves at finality. */
export const tipPays = (verdict: TipVerdict): boolean => verdict === "pays" || verdict === "unpriced-at-max";

/** The value of a fee in the cost's unit, rounded down, or null when the price is not usable. */
export const feeValueOf = (fee: bigint, decimals: number, price: TipVerdictInput["price"]): bigint | null =>
  isUsablePrice(price.state) && price.perWholeToken !== null ? (fee * price.perWholeToken) / 10n ** BigInt(decimals) : null;

/**
 * The verdict on a tip. Priced (a usable price and a cost): the profit rule. Unpriced: the automatic maximum.
 *
 * @param input The amount, the tip, the price and the cost, and the rule.
 */
export const tipVerdict = (input: TipVerdictInput): TipVerdict => {
  const priced = feeValueOf(input.fee, input.decimals, input.price);
  const value = priced === null ? null : (input.feeValue ?? priced);
  if (value === null || input.cost === null) return atAutomaticMaximum(input.fee, input.amount) ? "unpriced-at-max" : "unpriced-below-max";
  return meetsProfitRule(value, input.cost, input.rule) ? "pays" : "below-cost";
};

/** What {@link tipVerdictOfTerms} reads: the terms instead of the tip. */
export type TermsVerdictInput = Omit<TipVerdictInput, "fee"> & {
  /** The transfer's fee director, or null when it carries none (no tip). */
  readonly director: FeeDirector | null;
  /** The gas the router measures and the prices, for a gas based tip (`expectedFee`); the value is `amount`. */
  readonly gas: Omit<ExpectedFeeInput, "value">;
};

/**
 * The verdict on a transfer's terms: the tip the router would take under the director (`expectedFee`; none when there
 * is no director, or when the router would revert on an overflow), then {@link tipVerdict}.
 *
 * @param input The terms, the amount, the gas, the price and the cost, and the rule.
 */
export const tipVerdictOfTerms = (input: TermsVerdictInput): TipVerdict => {
  const { director, gas, ...rest } = input;
  let fee = 0n;
  if (director !== null) {
    try {
      fee = expectedFee(director, { ...gas, value: input.amount }).fee;
    } catch {
      // The router would revert on an overflow: no tip.
    }
  }
  return tipVerdict({ ...rest, fee });
};
