/**
 * The feed filter of the page. The state is the one of the terminal (`FilterState`), and the conversion adds one guard:
 * an address that is still being typed never reaches the indexer, which would answer 400 for it.
 */
import { isAddress } from "viem";
import { EMPTY_FILTER, toFeedFilter, type FilterState } from "@terminal/model/filter-state";
import type { FeedFilter } from "@terminal/model/types";

export { EMPTY_FILTER };
export type { FilterState };

/** The filter for the data source and the problem with the address field, if any. */
export type ValidatedFilter = {
  readonly filter: FeedFilter;
  /** A sentence for the address field, or null. */
  readonly addressProblem: string | null;
};

/**
 * Converts the state to a data source filter.
 *
 * @param state The state of the filter bar.
 * @param nowSeconds The clock, for the time range.
 */
export const validateFilter = (state: FilterState, nowSeconds: number): ValidatedFilter => {
  const address = state.address.trim();
  const addressIsValid = address === "" || isAddress(address, { strict: false });
  const filter = toFeedFilter({ ...state, address: addressIsValid ? address : "" }, nowSeconds);
  return { filter, addressProblem: addressIsValid ? null : "This is not an address yet. The feed is not filtered by it." };
};
