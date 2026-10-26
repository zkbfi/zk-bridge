import { describe, expect, it } from "vitest";
import { budgetPause, pruneBudget, SPEND_WINDOW_MILLISECONDS, windowSpendWei, withCharge, withLoss, withSettledCharge } from "../../src/runner/spend-budget.ts";
import { INITIAL_RUNNER_STATE, runnerStateSchema } from "../../src/runner/state.ts";

const EMPTY = { prerequisiteSpend: [], prerequisiteLosses: [] };
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
});
