/**
 * The one line under the amount that says why a price is missing or old, and what the fee is then. The fee itself is
 * set by `useDefaultFee` (the automatic maximum when no price can be derived); this only words it.
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
  if (state.kind === "stale") return `Prices can't be reached right now. Using the last price, ${ageText(state.ageSeconds)} old, until it is 10 minutes old.`;
  if (!unpriced) return null;
  if (state.kind === "no-market") return `No market price for ${nameOf(problem.key)}: the fee is the ${maximumText} maximum.`;
  return `Prices can't be reached right now, so the fee is the ${maximumText} maximum. They are read again every 30 seconds.`;
};
