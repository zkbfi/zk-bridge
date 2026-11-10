/**
 * The short fact about a missing or old price, for the fee pill's tooltip and the delivery menu (never a standing line
 * under the amount). The fee itself is set by `useDefaultFee` (the automatic maximum when no price can be derived); this
 * only words it.
 */
import { priceProblemOf, type PriceStates } from "@zkb/react";

/** An age as short text: seconds under a minute, else whole minutes. */
export const ageText = (seconds: number): string => (seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min`);

/** What {@link priceNotice} reads. */
export type PriceNoticeInput = {
  readonly states: PriceStates;
  /** The keys of the prices the fee needs: the token and the destination's coin. */
  readonly keys: readonly string[];
  /** The name of what a key prices, for the line ("tUSD", "tPLS"). */
  readonly nameOf: (key: string) => string;
  /** True when the fee is the automatic maximum because no price could be derived. */
  readonly unpriced: boolean;
  /** The automatic maximum as text, such as `1%`. */
  readonly maximumText: string;
};

/**
 * The line, or null when every price is known (or not yet read).
 *
 * @param input The states, the keys and the fee's situation.
 */
export const priceNotice = ({ states, keys, nameOf, unpriced, maximumText }: PriceNoticeInput): string | null => {
  const problem = priceProblemOf(states, keys);
  if (problem === null) return null;
  const { state } = problem;
  if (state.kind === "stale") return `Price from ${ageText(state.ageSeconds)} ago`;
  if (!unpriced) return null;
  if (state.kind === "no-market") return `${maximumText} maximum: ${nameOf(problem.key)} has no market price`;
  return `${maximumText} maximum: prices unreachable, read again every 30 s`;
};
