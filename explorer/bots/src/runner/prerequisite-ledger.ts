import { randomUUID } from "node:crypto";
import type { Logger } from "../logging/logger.ts";
import { budgetPause, pruneBudget, windowSpendWei, withCharge, withLoss, withSettledCharge, type SpendLimits } from "./spend-budget.ts";
import type { PrerequisiteBudgetState } from "./state.ts";

/** Where the rolling budget lives between sweeps and restarts. The runner backs it with its state file. */
export interface BudgetStore {
  load(): Promise<PrerequisiteBudgetState>;
  save(budget: PrerequisiteBudgetState): Promise<void>;
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

  async function current(): Promise<PrerequisiteBudgetState> {
    return pruneBudget(await store.load(), now());
  }

  async function refusal(wei: bigint): Promise<string | null> {
    const budget = await current();
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

  return {
    capWei,
    get spentWei() {
      return sweepSpentWei;
    },
    refusal,
    async reserve(wei) {
      const detail = await refusal(wei);
      if (detail !== null) return { ok: false, detail };
      const reservation = { id: randomUUID(), wei };
      await store.save(withCharge(await current(), { id: reservation.id, atMilliseconds: now(), wei: wei.toString() }));
      sweepSpentWei += wei;
      return { ok: true, reservation };
    },
    async settle(reservation, actualWei) {
      await store.save(withSettledCharge(await current(), reservation.id, actualWei));
      sweepSpentWei += actualWei - reservation.wei;
    },
    async recordLoss(wei) {
      if (wei === 0n) return;
      await store.save(withLoss(await current(), { atMilliseconds: now(), wei: wei.toString() }));
    },
  };
}
