import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { Shell } from "../../src/app/Shell";
import { DEFAULT_AUTO_CAP_PERCENT, loadFeeCap, saveFeeCap } from "../../src/bridge/fee-cap";
import { connectedWallet, renderWithWallet } from "../app/support";

beforeEach(() => {
  window.localStorage.clear();
});

describe("the stored cap", () => {
  it("defaults to 1%, keeps a valid value in this browser, and refuses others", () => {
    expect(DEFAULT_AUTO_CAP_PERCENT).toBe(1);
    expect(loadFeeCap()).toBe(1);
    expect(saveFeeCap("0.5")).toBeNull();
    expect(loadFeeCap()).toBe(0.5);
    expect(saveFeeCap("abc")).not.toBeNull();
    expect(saveFeeCap("0")).not.toBeNull();
    expect(saveFeeCap(null)).toBeNull();
    expect(loadFeeCap()).toBe(1);
  });
});

const openReview = async (query: string) => {
  window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}?${query}`);
  renderWithWallet(<Shell />, { wallet: connectedWallet() });
  const pill = await waitFor(() => {
    const found = screen.getAllByRole("button").find((button) => button.classList.contains("zb-go"));
    expect(found).toBeDefined();
    expect(found).not.toBeDisabled();
    expect(found!.textContent).not.toBe("Check the transfer");
    return found!;
  }, { timeout: 3000 });
  await waitFor(() => expect(document.querySelector(".zb-fees")?.textContent).toMatch(/\d/), { timeout: 3000 });
  await userEvent.click(pill);
  return screen.findByRole("dialog", { name: "Review" });
};

describe("the cap in the review", () => {
  // PulseChain → Ethereum at the sample prices: $1,000 of zkbUSDC, delivery about $5.06 on Ethereum.
  const GAS_BASED = "dir=second-to-first&bridge.amount=1000&tip.mode=gas-multiplier&tip.price=3000";

  it("warns High cap % for a gas-based fee whose cap would leave too much if gas rises, shows the drift, and lowers the cap in place", async () => {
    const review = await openReview(GAS_BASED);
    expect(within(review).getByText("Can drift").nextSibling).toHaveTextContent(/now, up to .* if gas rises to the Normal ceiling/);
    const warning = within(review).getByRole("group", { name: "Fee cap" });
    expect(warning).toHaveTextContent(/High cap %/);
    expect(warning).toHaveTextContent(/1% cap/);
    await userEvent.click(within(warning).getByRole("radio", { name: "0.5%" }));
    await waitFor(() => expect(window.location.hash).toMatch(/tip\.cap=0\.5/));
    expect(within(review).queryByRole("group", { name: "Fee cap" })).toBeNull();
    // The cap limits what the signed terms allow: the drift now stops at 0.5% of $1,000.
    expect(within(review).getByText("Can drift").nextSibling).toHaveTextContent(/up to \$5\.00 if gas rises/);
  });

  it("never warns about the cap for a fee fixed at signing (the default share)", async () => {
    const review = await openReview("dir=second-to-first&bridge.amount=1000&tip.cap=2");
    expect(within(review).queryByRole("group", { name: "Fee cap" })).toBeNull();
    expect(within(review).queryByText("Can drift")).toBeNull();
  });

  it("saves this bridge's cap as the default with the floppy button", async () => {
    const review = await openReview(GAS_BASED);
    const warning = within(review).getByRole("group", { name: "Fee cap" });
    await userEvent.click(within(warning).getByRole("radio", { name: "0.25%" }));
    await waitFor(() => expect(window.location.hash).toMatch(/tip\.cap=0\.25/));
    expect(loadFeeCap()).toBe(1);
    // At 0.25% the warning closes (the capped fee no longer covers the cost); the drawer's cap slider has the button.
    expect(within(review).queryByRole("group", { name: "Fee cap" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Close|Back/ }));
    await userEvent.click(screen.getAllByRole("button").find((button) => button.getAttribute("data-fee") === "tip")!);
    await userEvent.click(await screen.findByRole("button", { name: "Save 0.25% as your default cap" }));
    await waitFor(() => expect(loadFeeCap()).toBe(0.25));
    await waitFor(() => expect(window.location.hash).not.toMatch(/tip\.cap=/));
  });
});
