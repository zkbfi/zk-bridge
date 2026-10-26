import type { PrerequisiteBudgetState, PrerequisiteLossEntry, PrerequisiteSpendEntry } from "./state.ts";

/** The rolling window of the daily budget and the loss threshold: 24 hours. */
export const SPEND_WINDOW_MILLISECONDS = 24 * 60 * 60 * 1000;

/** The limits of the rolling window. */
export interface SpendLimits {
  readonly dailySpendWei: bigint;
  readonly unrecoveredLossWei: bigint;
}

/** Why layout spending is paused, and when the window rolls far enough to resume. */
export interface BudgetPause {
  readonly kind: "daily-budget" | "loss-threshold";
  readonly detail: string;
  readonly resumesAtMilliseconds: number;
}

interface TimedWei {
  readonly atMilliseconds: number;
  readonly wei: string;
}

function inWindow<Entry extends TimedWei>(entries: readonly Entry[], now: number): Entry[] {
  return entries.filter((entry) => now - entry.atMilliseconds < SPEND_WINDOW_MILLISECONDS);
}

function total(entries: readonly TimedWei[]): bigint {
  return entries.reduce((sum, entry) => sum + BigInt(entry.wei), 0n);
}

/** Drops the entries that are older than the window. */
export function pruneBudget(budget: PrerequisiteBudgetState, now: number): PrerequisiteBudgetState {
  return { prerequisiteSpend: inWindow(budget.prerequisiteSpend, now), prerequisiteLosses: inWindow(budget.prerequisiteLosses, now) };
}

/** The wei that layout calls cost, or may cost, in the window that ends at `now`. */
export function windowSpendWei(budget: PrerequisiteBudgetState, now: number): bigint {
  return total(inWindow(budget.prerequisiteSpend, now));
}

/** The unrecovered loss in the window that ends at `now`. */
export function windowLossWei(budget: PrerequisiteBudgetState, now: number): bigint {
  return total(inWindow(budget.prerequisiteLosses, now));
}

/** Adds a charge. The budget is not changed. */
export function withCharge(budget: PrerequisiteBudgetState, entry: PrerequisiteSpendEntry): PrerequisiteBudgetState {
  return { ...budget, prerequisiteSpend: [...budget.prerequisiteSpend, entry] };
}

/** Replaces the wei of one charge, for example with the actual cost once the receipt is known. An unknown identifier changes nothing. */
export function withSettledCharge(budget: PrerequisiteBudgetState, id: string, wei: bigint): PrerequisiteBudgetState {
  return { ...budget, prerequisiteSpend: budget.prerequisiteSpend.map((entry) => (entry.id === id ? { ...entry, wei: wei.toString() } : entry)) };
}

/** Adds an unrecovered loss. */
export function withLoss(budget: PrerequisiteBudgetState, entry: PrerequisiteLossEntry): PrerequisiteBudgetState {
  return { ...budget, prerequisiteLosses: [...budget.prerequisiteLosses, entry] };
}

/** The time at which the oldest entries have rolled out far enough that the total falls below the limit. */
function resumeTime(entries: readonly TimedWei[], limit: bigint): number {
  const oldestFirst = [...entries].sort((left, right) => left.atMilliseconds - right.atMilliseconds);
  let remaining = total(oldestFirst);
  for (const entry of oldestFirst) {
    remaining -= BigInt(entry.wei);
    if (remaining < limit) return entry.atMilliseconds + SPEND_WINDOW_MILLISECONDS;
  }
  return oldestFirst.length === 0 ? 0 : (oldestFirst[oldestFirst.length - 1] as TimedWei).atMilliseconds + SPEND_WINDOW_MILLISECONDS;
}

/**
 * Says whether layout spending is paused: the spend of the window reached the daily budget, or the unrecovered loss of
 * the window reached the threshold. Reaching a limit pauses spending, so a window that holds exactly the limit is paused.
 */
export function budgetPause(budget: PrerequisiteBudgetState, limits: SpendLimits, now: number): BudgetPause | null {
  const spend = inWindow(budget.prerequisiteSpend, now);
  const spent = total(spend);
  if (spent >= limits.dailySpendWei) {
    return { kind: "daily-budget", detail: `${spent} of ${limits.dailySpendWei} wei spent in the last 24 hours`, resumesAtMilliseconds: resumeTime(spend, limits.dailySpendWei) };
  }
  const losses = inWindow(budget.prerequisiteLosses, now);
  const lost = total(losses);
  if (lost < limits.unrecoveredLossWei) return null;
  return { kind: "loss-threshold", detail: `${lost} wei lost in the last 24 hours, the threshold is ${limits.unrecoveredLossWei}`, resumesAtMilliseconds: resumeTime(losses, limits.unrecoveredLossWei) };
}
