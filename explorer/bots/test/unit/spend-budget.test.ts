import { describe, expect, it } from "vitest";
import {
  budgetPause,
  pruneBudget,
  SPEND_WINDOW_MILLISECONDS,
  windowDeliverySpendWei,
  windowSpendWei,
  withCharge,
  withDeliveryCharge,
  withLoss,
  withSettledCharge,
  withSettledDeliveryCharge,
} from "../../src/runner/spend-budget.ts";
import { INITIAL_RUNNER_STATE, runnerStateSchema } from "../../src/runner/state.ts";

const EMPTY = { prerequisiteSpend: [], deliverySpend: [], prerequisiteLosses: [] };
const LIMITS = { dailySpendWei: 100n, unrecoveredLossWei: 50n };

describe("the rolling spend budget", () => {
  it("reads a state file from before the budget existed as an empty budget", () => {
    const old = runnerStateSchema.parse({ schemaVersion: 1, finished: { "0x01": "elsewhere" } });
    expect(old).toEqual({ ...INITIAL_RUNNER_STATE, finished: { "0x01": "elsewhere" } });
  });

  it("pauses at the limit, not only above it, because reaching the limit is the stop", () => {
    const budget = withCharge(EMPTY, { id: "a", atMilliseconds: 0, wei: "100" });
    expect(budgetPause(budget, LIMITS, 10)).toMatchObject({ kind: "daily-budget" });
    expect(budgetPause(withSettledCharge(budget, "a", 99n), LIMITS, 10)).toBeNull();
  });

  it("resumes when enough old spend has rolled out of the window", () => {
    const budget = withCharge(withCharge(EMPTY, { id: "a", atMilliseconds: 0, wei: "60" }), { id: "b", atMilliseconds: 1000, wei: "60" });
    expect(budgetPause(budget, LIMITS, 2000)?.resumesAtMilliseconds).toBe(SPEND_WINDOW_MILLISECONDS);
    expect(budgetPause(budget, LIMITS, SPEND_WINDOW_MILLISECONDS)).toBeNull();
  });

  it("drops entries older than 24 hours and counts the rest", () => {
    const budget = withCharge(withCharge(EMPTY, { id: "old", atMilliseconds: 0, wei: "70" }), { id: "new", atMilliseconds: SPEND_WINDOW_MILLISECONDS, wei: "5" });
    expect(windowSpendWei(budget, SPEND_WINDOW_MILLISECONDS)).toBe(5n);
    expect(pruneBudget(budget, SPEND_WINDOW_MILLISECONDS).prerequisiteSpend.map((entry) => entry.id)).toEqual(["new"]);
  });

  it("pauses on the loss threshold alone", () => {
    const budget = withLoss(EMPTY, { atMilliseconds: 0, wei: "50" });
    expect(budgetPause(budget, LIMITS, 1)).toMatchObject({ kind: "loss-threshold" });
  });

  it("settles only the charge with the identifier and leaves the others at their reserved wei", () => {
    const budget = withCharge(withCharge(EMPTY, { id: "a", atMilliseconds: 0, wei: "10" }), { id: "b", atMilliseconds: 1, wei: "20" });
    expect(withSettledCharge(budget, "b", 7n).prerequisiteSpend).toEqual([
      { id: "a", atMilliseconds: 0, wei: "10" },
      { id: "b", atMilliseconds: 1, wei: "7" },
    ]);
    expect(withSettledCharge(budget, "unknown", 7n)).toEqual(budget);
  });

  it("resumes at the roll-out of the entry after which the total falls below the limit, not at the first entry", () => {
    // Three charges of 60 against a limit of 100: the total is 180. Dropping the oldest leaves 120, still at or above
    // the limit. Dropping the second leaves 60, below it. So spending resumes when the second charge rolls out.
    const budget = [0, 1000, 2000].reduce((sum, at) => withCharge(sum, { id: `c${at}`, atMilliseconds: at, wei: "60" }), EMPTY as Parameters<typeof withCharge>[0]);
    expect(budgetPause(budget, LIMITS, 3000)?.resumesAtMilliseconds).toBe(1000 + SPEND_WINDOW_MILLISECONDS);
  });

  it("sorts the entries oldest first, whatever the order of the list", () => {
    const budget = withCharge(withCharge(EMPTY, { id: "late", atMilliseconds: 1000, wei: "60" }), { id: "early", atMilliseconds: 0, wei: "60" });
    expect(budgetPause(budget, LIMITS, 2000)?.resumesAtMilliseconds).toBe(SPEND_WINDOW_MILLISECONDS);
  });

  it("names the last entry as the resume point when the limit is zero, because no total is below zero", () => {
    const budget = withLoss(withLoss(EMPTY, { atMilliseconds: 5, wei: "1" }), { atMilliseconds: 9, wei: "1" });
    expect(budgetPause(budget, { dailySpendWei: 100n, unrecoveredLossWei: 0n }, 10)?.resumesAtMilliseconds).toBe(9 + SPEND_WINDOW_MILLISECONDS);
  });

  it("resumes at once when the limit is zero and nothing is lost, because there is no entry to wait for", () => {
    expect(budgetPause(EMPTY, { dailySpendWei: 100n, unrecoveredLossWei: 0n }, 10)).toEqual({
      kind: "loss-threshold",
      detail: "0 wei lost in the last 24 hours, the threshold is 0",
      resumesAtMilliseconds: 0,
    });
  });

  it("reads a state file that has a layout list but no delivery list, and gives it an empty one", () => {
    const before = runnerStateSchema.parse({ schemaVersion: 1, finished: {}, prerequisiteSpend: [{ id: "a", atMilliseconds: 1, wei: "5" }], prerequisiteLosses: [] });
    expect(before.deliverySpend).toEqual([]);
    expect(before.prerequisiteSpend).toHaveLength(1);
  });
});

describe("the rolling delivery spend", () => {
  it("adds a charge and replaces it with the actual cost at the receipt", () => {
    const reserved = withDeliveryCharge(EMPTY, { id: "batch", atMilliseconds: 0, wei: "900" });
    expect(windowDeliverySpendWei(reserved, 1)).toBe(900n);
    expect(windowDeliverySpendWei(withSettledDeliveryCharge(reserved, "batch", 400n), 1)).toBe(400n);
    expect(withSettledDeliveryCharge(reserved, "unknown", 1n)).toEqual(reserved);
  });

  it("drops entries older than 24 hours and counts the rest", () => {
    const budget = withDeliveryCharge(withDeliveryCharge(EMPTY, { id: "old", atMilliseconds: 0, wei: "70" }), { id: "new", atMilliseconds: SPEND_WINDOW_MILLISECONDS, wei: "5" });
    expect(windowDeliverySpendWei(budget, SPEND_WINDOW_MILLISECONDS)).toBe(5n);
    expect(pruneBudget(budget, SPEND_WINDOW_MILLISECONDS).deliverySpend.map((entry) => entry.id)).toEqual(["new"]);
  });

  it("never counts against the daily budget of layout calls, because the fee of a delivery repays it", () => {
    // Delivery spend far above the daily limit of 100 wei: layout spending is not paused by it.
    const budget = withDeliveryCharge(EMPTY, { id: "batch", atMilliseconds: 0, wei: "1000000" });
    expect(windowSpendWei(budget, 1)).toBe(0n);
    expect(budgetPause(budget, LIMITS, 1)).toBeNull();
  });
});
