import { SPEND_WINDOW_MILLISECONDS } from "./spend-budget.ts";
import type { PrerequisiteSpendEntry, RunnerState } from "./state.ts";

/** The wei that unpaid deliveries cost, from their receipts, in the 24 hours that end at `now`. */
export function unpaidSpentWei(state: Pick<RunnerState, "unpaidSpend">, now: number): bigint {
  return state.unpaidSpend.filter((entry) => now - entry.atMilliseconds < SPEND_WINDOW_MILLISECONDS).reduce((sum, entry) => sum + BigInt(entry.wei), 0n);
}

/** Adds one receipt's cost and drops the entries that left the window. The state is not changed. */
export function withUnpaidSpend(state: RunnerState, entry: PrerequisiteSpendEntry, now: number): RunnerState {
  const kept = state.unpaidSpend.filter((old) => now - old.atMilliseconds < SPEND_WINDOW_MILLISECONDS);
  return { ...state, unpaidSpend: [...kept, entry] };
}
