import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { Shell } from "../../src/app/Shell";
import { loadFeeCap, saveFeeCap } from "../../src/bridge/fee-cap";
import { autoFeePercent, capTooLarge, DEFAULT_AUTO_CAP_PERCENT, lowFeeOf } from "../../src/bridge/fee-guard";
import { connectedWallet, renderWithWallet } from "../app/support";

beforeEach(() => {
  window.localStorage.clear();
});

describe("the automatic fee", () => {
  it("is the larger of 0.1% of the amount and twice the anticipated cost", () => {
    // $10,000: 0.1% is $10, twice a $1.025 cost is $2.05; 0.1% wins.
    expect(autoFeePercent({ amountUsd: 10_000, costUsd: 1.025, capPercent: 1 })).toEqual({ percent: 0.1, capped: false });
    // $500: 0.1% is $0.50, twice the cost is $2.05 = 0.41%; the cost wins.
    expect(autoFeePercent({ amountUsd: 500, costUsd: 1.025, capPercent: 1 })).toEqual({ percent: 0.41, capped: false });
  });

  it("stops at the cap; the fee then sits under twice the cost and the low-fee warning stays", () => {
    // $100 with a $2 cost needs 4%; the 1% cap binds.
    const auto = autoFeePercent({ amountUsd: 100, costUsd: 2, capPercent: DEFAULT_AUTO_CAP_PERCENT });
    expect(auto).toEqual({ percent: 1, capped: true });
    expect(lowFeeOf({ feeUsd: (auto.percent / 100) * 100, costUsd: 2, belowBreakEven: false })).toBe(true);
  });

  it("recomputes with a lowered cap", () => {
    expect(autoFeePercent({ amountUsd: 500, costUsd: 1.025, capPercent: 0.25 })).toEqual({ percent: 0.25, capped: true });
  });

  it("is 0.1% without prices", () => {
    expect(autoFeePercent({ amountUsd: null, costUsd: null, capPercent: 1 })).toEqual({ percent: 0.1, capped: false });
  });
});

describe("a cap that is too large", () => {
  it("is one above the high-tip line for the amount", () => {
    expect(DEFAULT_AUTO_CAP_PERCENT).toBe(1);
    expect(capTooLarge(1, 50)).toBe(false);
    expect(capTooLarge(1.5, 50)).toBe(true);
    expect(capTooLarge(1, 316)).toBe(true);
    expect(capTooLarge(0.3, 316)).toBe(false);
    expect(capTooLarge(1, 5_000)).toBe(true);
    expect(capTooLarge(0.1, 5_000)).toBe(false);
  });
});

describe("the stored cap", () => {
  it("defaults to 1%, keeps a valid value in this browser, and refuses others", () => {
    expect(loadFeeCap()).toBe(1);
    expect(saveFeeCap("0.5")).toBeNull();
    expect(loadFeeCap()).toBe(0.5);
    expect(saveFeeCap("abc")).not.toBeNull();
    expect(saveFeeCap("0")).not.toBeNull();
    expect(saveFeeCap(null)).toBeNull();
    expect(loadFeeCap()).toBe(1);
  });
});

describe("the cap in the review", () => {
  it("always warns about a cap that is too large and lowers it in place", async () => {
    window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}?bridge.amount=0.01&tip.cap=2`);
    renderWithWallet(<Shell />, { wallet: connectedWallet() });
    const pill = await waitFor(() => {
      const found = screen.getAllByRole("button").find((button) => button.classList.contains("zb-go"));
      expect(found).toBeDefined();
      expect(found).not.toBeDisabled();
      return found!;
    }, { timeout: 3000 });
    await userEvent.click(pill);
    const review = await screen.findByRole("dialog", { name: "Review" });
    const warning = within(review).getByRole("group", { name: "Fee cap" });
    expect(warning).toHaveTextContent(/2%/);
    await userEvent.click(within(warning).getByRole("radio", { name: "0.5%" }));
    await waitFor(() => expect(window.location.hash).toMatch(/tip\.cap=0\.5/));
    expect(within(review).queryByRole("group", { name: "Fee cap" })).toBeNull();
  });
});
