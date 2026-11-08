import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { Shell } from "../../src/app/Shell";
import { loadFeeCap, loadHardCap } from "../../src/bridge/fee-cap";
import { connectedWallet, renderWithWallet } from "../app/support";
import { tokenQuery } from "./token-link";

beforeEach(() => {
  window.localStorage.clear();
});

const goPill = (): HTMLButtonElement => screen.getAllByRole("button").find((button) => button.classList.contains("zb-go")) as HTMLButtonElement;

describe("the hard cap on the bridge screen", () => {
  const at = async (query: string) => {
    window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}?${tokenQuery(query)}`);
    renderWithWallet(<Shell />, { wallet: connectedWallet() });
    await waitFor(() => expect(document.querySelector('[data-fee="tip"]')?.getAttribute("aria-label")).toMatch(/Fee \d/), { timeout: 3000 });
  };

  it("blocks the Bridge pill when the tip pushes the fee above 2%, says why with the numbers, and raises the cap in one tap", async () => {
    await at("bridge.amount=500&tip.mode=percentage&tip.percent=2.37");
    await waitFor(() => expect(goPill()).toHaveTextContent("Fee above your 2% cap"));
    expect(goPill()).toBeDisabled();
    expect(goPill().getAttribute("data-kind")).toBe("blocked");
    expect(document.querySelector(".zb-verdict")).toHaveTextContent(/The fee is .+, more than your 2% hard cap \(.+\)\. Raise the cap to 2\.4% to go on/);
    await userEvent.click(screen.getByRole("button", { name: "Raise cap to 2.4%" }));
    // Raised, the block gives way to the one warning left (a high share).
    await waitFor(() => expect(goPill()).not.toBeDisabled());
    expect(goPill()).toHaveTextContent("High cap %");
    // Raised for this visit; the floppy in the drawer keeps it.
    expect(loadHardCap()).toBe(2);
    await userEvent.click(screen.getAllByRole("button").find((button) => button.getAttribute("data-fee") === "tip")!);
    await userEvent.click(await screen.findByRole("button", { name: "Save 2.4% as your hard cap" }));
    expect(loadHardCap()).toBe(2.4);
  });

  it("puts the block ahead of every fee warning", async () => {
    await at("bridge.amount=500&tip.mode=percentage&tip.percent=5");
    await waitFor(() => expect(goPill()).toHaveTextContent("Fee above your 2% cap"));
    expect(goPill()).not.toHaveTextContent("High cap %");
  });

  it("shows both caps in the drawer with the fee's span on the track, and the automatic cap follows the hard cap down", async () => {
    await at("bridge.amount=500&tip.cap=1.5");
    await userEvent.click(screen.getAllByRole("button").find((button) => button.getAttribute("data-fee") === "tip")!);
    const auto = screen.getByRole("slider", { name: "Automatic fee cap" });
    const hard = screen.getByRole("slider", { name: "Hard fee cap" });
    expect(auto).toHaveValue("1.5");
    expect(hard).toHaveValue("2");
    expect(auto).toHaveAttribute("max", "2");
    expect(screen.getAllByRole("img", { name: /^The fee: [\d.]+% of the amount$/ }).length).toBe(2);
    fireEvent.change(hard, { target: { value: "0.5" } });
    await waitFor(() => expect(screen.getByRole("slider", { name: "Automatic fee cap" })).toHaveValue("0.5"));
    expect(window.location.hash).toMatch(/tip\.cap=0\.5/);
    // The exact input sits against its unit, and refuses more than the hard cap.
    const exact = screen.getByRole("textbox", { name: "Automatic fee cap, exact" });
    expect(exact).toHaveValue("0.5");
    expect(exact.nextElementSibling).toHaveTextContent("%");
    await userEvent.clear(exact);
    await userEvent.type(exact, "0.9");
    expect(screen.getByText(/At most your 0\.5% hard cap/)).toHaveAttribute("role", "alert");
  });
});

const openReview = async (query: string) => {
  window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}?${tokenQuery(query)}`);
  renderWithWallet(<Shell />, { wallet: connectedWallet() });
  const pill = await waitFor(() => {
    const found = screen.getAllByRole("button").find((button) => button.classList.contains("zb-go"));
    expect(found).toBeDefined();
    expect(found).not.toBeDisabled();
    expect(found!.textContent).not.toBe("Check the transfer");
    return found!;
  }, { timeout: 3000 });
  await waitFor(() => expect(document.querySelector('[data-fee="tip"]')?.getAttribute("aria-label")).toMatch(/Fee \d/), { timeout: 3000 });
  await userEvent.click(pill);
  return screen.findByRole("dialog", { name: "Review" });
};

describe("the cap in the review", () => {
  // PulseChain → Ethereum at the sample prices: $1,000 of zUSDC, delivery about $5.06 on Ethereum.
  const GAS_BASED = `dir=second-to-first&bridge.amount=1000&tip.mode=gas-multiplier&tip.price=3000`;

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
    const review = await openReview(`dir=second-to-first&bridge.amount=1000&tip.cap=2`);
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
