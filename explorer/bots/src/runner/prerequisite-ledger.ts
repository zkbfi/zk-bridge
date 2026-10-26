import { randomUUID } from "node:crypto";
import type { Logger } from "../logging/logger.ts";
import { budgetPause, pruneBudget, windowSpendWei, withCharge, withLoss, withSettledCharge, type SpendLimits } from "./spend-budget.ts";
import type { PrerequisiteBudgetState } from "./state.ts";

/**
 * Where the rolling budget lives between sweeps and restarts. The runner backs it with its state file.
 * A change is a function of the freshest stored budget. The store applies it under one lock, so two changes never
 * overwrite each other. A function that returns the budget it was given changes nothing.
 */
export interface BudgetStore {
  load(): Promise<PrerequisiteBudgetState>;
  update(mutate: (budget: PrerequisiteBudgetState) => PrerequisiteBudgetState): Promise<void>;
}

/** Wei that the ledger charged before a send, to be settled to the actual cost. */
export interface Reservation {
  readonly id: string;
  readonly wei: bigint;
}

/** The answer of {@link PrerequisiteLedger.reserve}. */
export type ReserveResult = { readonly ok: true; readonly reservation: Reservation } | { readonly ok: false; readonly detail: string };

/**
 * The layout spend of one sweep and of the rolling 24 hours. A runner makes one ledger for each sweep and passes it to
 * every delivery. Layout rows help every sender, so this spend is a gift that the fee of one item may never repay.
 *
 * The ledger charges before it spends: `reserve` writes the worst case of a send to the store before the send leaves, and
 * `settle` replaces it with the actual cost. A send that throws never settles, so the reservation stays charged.
 */
export interface PrerequisiteLedger {
  /** The most wei that one sweep may spend. */
  readonly capWei: bigint;
  /** The wei charged in this sweep, reservations included. */
  readonly spentWei: bigint;
  /** Null when `wei` more may be charged now, or the reason it may not. */
  refusal(wei: bigint): Promise<string | null>;
  /** Charges `wei` when `refusal` allows it. The charge is stored before the call returns. */
  reserve(wei: bigint): Promise<ReserveResult>;
  /** Replaces a reservation with the actual cost. */
  settle(reservation: Reservation, actualWei: bigint): Promise<void>;
  /** Records wei that layout calls cost for an item that was then not delivered. */
  recordLoss(wei: bigint): Promise<void>;
}

/** Input of {@link createPrerequisiteLedger}. */
export interface PrerequisiteLedgerInput {
  readonly capWei: bigint;
  readonly limits: SpendLimits;
  readonly store: BudgetStore;
  readonly now: () => number;
  readonly logger: Logger;
}

/** Makes a ledger for one sweep. The rolling part comes from the store. */
export function createPrerequisiteLedger(input: PrerequisiteLedgerInput): PrerequisiteLedger {
  const { capWei, limits, store, now, logger } = input;
  let sweepSpentWei = 0n;
  let warnedOfPause = false;

  /** The refusal for `wei` more against a budget that is already pruned, or null. Warns once about a pause. */
  function refusalFor(budget: PrerequisiteBudgetState, wei: bigint): string | null {
    const pause = budgetPause(budget, limits, now());
    if (pause !== null) {
      if (!warnedOfPause) {
        warnedOfPause = true;
        logger.warn("prerequisite_spending_paused", {
          limit: pause.kind,
          detail: pause.detail,
          resumesAt: new Date(pause.resumesAtMilliseconds).toISOString(),
          note: "The runner sends no layout calls until the window rolls. It still delivers items that need none.",
        });
      }
      return `${pause.kind}: ${pause.detail}`;
    }
    if (sweepSpentWei + wei > capWei) return `${sweepSpentWei} of ${capWei} wei spent this sweep, and this call may cost ${wei}`;
    const windowSpent = windowSpendWei(budget, now());
    if (windowSpent + wei > limits.dailySpendWei) return `${windowSpent} of ${limits.dailySpendWei} wei spent in the last 24 hours, and this call may cost ${wei}`;
    return null;
  }

  async function refusal(wei: bigint): Promise<string | null> {
    return refusalFor(pruneBudget(await store.load(), now()), wei);
  }

  return {
    capWei,
    get spentWei() {
      return sweepSpentWei;
    },
    refusal,
    async reserve(wei) {
      const reservation = { id: randomUUID(), wei };
      const verdict: { detail: string | null } = { detail: null };
      // The check and the charge happen on one freshly loaded budget under the lock, so concurrent reservations
      // cannot all pass the check against the same stale total.
      await store.update((stored) => {
        const budget = pruneBudget(stored, now());
        verdict.detail = refusalFor(budget, wei);
        if (verdict.detail !== null) return stored;
        return withCharge(budget, { id: reservation.id, atMilliseconds: now(), wei: wei.toString() });
      });
      if (verdict.detail !== null) return { ok: false, detail: verdict.detail };
      sweepSpentWei += wei;
      return { ok: true, reservation };
    },
    async settle(reservation, actualWei) {
      await store.update((stored) => withSettledCharge(pruneBudget(stored, now()), reservation.id, actualWei));
      sweepSpentWei += actualWei - reservation.wei;
    },
    async recordLoss(wei) {
      if (wei === 0n) return;
      await store.update((stored) => withLoss(pruneBudget(stored, now()), { atMilliseconds: now(), wei: wei.toString() }));
    },
  };
}
