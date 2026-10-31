import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { Shell } from "../../src/app/Shell";
import { connectedWallet, disconnectedWallet, renderWithWallet } from "../app/support";

// The owner (quotes 81–82): the bars beside the gas can are the gas level; tapping them moves every number "because a
// new level of fee spend has been consented to"; the tip must drive the fee; all of it works without a wallet.

beforeEach(() => {
  window.localStorage.clear();
});

const at = async (query: string, connected: boolean) => {
  window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}?${query}`);
  renderWithWallet(<Shell />, { wallet: connected ? connectedWallet() : disconnectedWallet() });
  await waitFor(() => expect(feeText()).toMatch(/\d/), { timeout: 3000 });
};

// The fee in the token, as the summary segment's label says it ("… Fee 0.193892 USDC (about $0.19) …").
const feeText = (): string => /Fee [\d.]+ \S+/.exec(document.querySelector('[data-fee="tip"]')?.getAttribute("aria-label") ?? "")?.[0] ?? "";
const output = (): string => document.querySelector(".zb-amount-out")?.textContent ?? "";
const pill = (): string => document.querySelector(".zb-go")?.textContent ?? "";
const breakdown = (): string => screen.getByRole("list", { name: "What the fee covers" }).textContent ?? "";
const row = (label: string): string => {
  const item = [...screen.getByRole("list", { name: "What the fee covers" }).querySelectorAll("li")].find((li) => li.firstElementChild?.textContent === label);
  return item?.lastElementChild?.textContent ?? "";
};
const openDrawer = async () => userEvent.click(screen.getByRole("button", { name: /^Delivery settings/ }));
const bars = (): HTMLElement => screen.getByRole("button", { name: /^Gas level: / });

describe.each([
  ["with a wallet", true],
  ["without a wallet (a stand-in receiver)", false],
])("the fee controls %s", (_name, connected) => {
  it("shows the fee, the gas bars and the tip once an amount is typed", async () => {
    await at("bridge.amount=50", connected);
    expect(feeText()).toMatch(/0\.193892/);
    expect(bars()).toHaveAccessibleName("Gas level: Normal. Change");
    await openDrawer();
    expect(screen.getByRole("slider", { name: "Tip" })).toBeInTheDocument();
    expect(row("Fee")).toBe("$0.19");
    expect(screen.getByText(/^Automatic ·/)).toBeInTheDocument();
  });

  it("moves every number when the bars move: the cost, the fee, the output and the breakdown, with the drawer kept open", async () => {
    await at("bridge.amount=50", connected);
    await openDrawer();
    const before = { fee: feeText(), out: output(), tip: row("Tip") };
    expect(breakdown()).not.toMatch(/gas level/);
    await userEvent.click(bars());
    await waitFor(() => expect(bars()).toHaveAccessibleName("Gas level: High. Change"));
    // The drawer stays open while the bars change.
    expect(screen.getByRole("list", { name: "What the fee covers" })).toBeInTheDocument();
    expect(row("High gas level")).toBe("+$0.01");
    expect(feeText()).not.toBe(before.fee);
    expect(output()).not.toBe(before.out);
    // The tip before gas stays where the curve put it: the level's cost is added on top.
    expect(row("Tip")).toBe(before.tip);
    await userEvent.click(bars());
    await waitFor(() => expect(bars()).toHaveAccessibleName("Gas level: Highest. Change"));
    expect(row("Highest gas level")).toBe("+$0.03");
    await userEvent.click(bars());
    await waitFor(() => expect(bars()).toHaveAccessibleName("Gas level: Normal. Change"));
    expect(feeText()).toBe(before.fee);
    expect(output()).toBe(before.out);
  });

  it("drives the fee, the breakdown, the output and the warnings with the tip, leaves automatic and comes back", async () => {
    await at("bridge.amount=500", connected);
    await openDrawer();
    const before = { fee: feeText(), out: output() };
    expect(pill()).toBe(connected ? "Bridge" : "Connect wallet");
    // 1% of $500 on top of the $0.025 cost: past the 0.2% high cap line.
    fireEvent.change(screen.getByRole("slider", { name: "Tip" }), { target: { value: "1" } });
    await waitFor(() => expect(row("Tip")).toBe("$5.00"));
    expect(row("Fee")).toBe("$5.02");
    expect(feeText()).not.toBe(before.fee);
    expect(output()).not.toBe(before.out);
    expect(window.location.hash).toMatch(/tip\.percent=1\.005/);
    expect(screen.getByText("Set by you · the automatic fee is off")).toBeInTheDocument();
    if (connected) expect(pill()).toBe("High cap %");
    await userEvent.click(screen.getByRole("button", { name: "Reset to recommended" }));
    await waitFor(() => expect(feeText()).toBe(before.fee));
    expect(output()).toBe(before.out);
    expect(window.location.hash).not.toMatch(/tip\.percent/);
    expect(screen.getByText(/^Automatic ·/)).toBeInTheDocument();
  });

  it("keeps a tip the user set when the bars move, and raises the fee by the level's cost", async () => {
    await at("bridge.amount=500&tip.mode=percentage&tip.percent=0.21", connected);
    await openDrawer();
    const before = { tip: row("Tip"), fee: feeText() };
    expect(row("Fee")).toBe("$1.05");
    await userEvent.click(bars());
    await waitFor(() => expect(row("High gas level")).toBe("+$0.01"));
    expect(row("Tip")).toBe(before.tip);
    expect(row("Fee")).toBe("$1.06");
    expect(window.location.hash).toMatch(/tip\.percent=0\.2125/);
    expect(screen.getByText("Set by you · the automatic fee is off")).toBeInTheDocument();
    // Round the levels and back: the same tip and fee in dollars, and the same fee after a second round (no drift).
    await userEvent.click(bars());
    await userEvent.click(bars());
    await waitFor(() => expect(bars()).toHaveAccessibleName("Gas level: Normal. Change"));
    expect(row("Tip")).toBe(before.tip);
    expect(row("Fee")).toBe("$1.05");
    const settled = feeText();
    for (let index = 0; index < 3; index += 1) await userEvent.click(bars());
    await waitFor(() => expect(bars()).toHaveAccessibleName("Gas level: Normal. Change"));
    expect(feeText()).toBe(settled);
  });
});

describe("the gas bars' tooltip", () => {
  it("says what the chosen level means in one line, and updates with it", async () => {
    await at("bridge.amount=50", true);
    await userEvent.hover(bars());
    // An anchor with a 15-minute range, never a multiplier (owner, quote 91).
    expect(screen.getByRole("tooltip")).toHaveTextContent(/^Normal gas: anchored at today's gas, the cost could land (?:between \$[\d.]+ and \$[\d.]+|about \$[\d.]+) over 15 min\. Tap for High\.$/);
    expect(screen.getByRole("tooltip").textContent).not.toMatch(/×|multipl/);
    await userEvent.click(bars());
    await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent(/^High gas: anchored at today's gas/));
  });
});

describe("the help buttons", () => {
  it("are one kind of button everywhere in the drawer, each named for what it explains, with its tooltip on tap", async () => {
    await at("bridge.amount=50", true);
    await openDrawer();
    const drawer = document.querySelector<HTMLElement>(".zb-drawer")!;
    const helps = within(drawer).getAllByRole("button", { name: /^About / });
    expect(helps.map((button) => button.getAttribute("aria-label"))).toEqual(["About Tip", "About Gas level", "About Automatic fee cap", "About Hard fee cap"]);
    for (const help of helps) expect(help).toHaveClass("zb-q");
    await userEvent.click(helps[2]!);
    expect(screen.getByRole("tooltip")).toHaveTextContent(/most the automatic fee may take/);
  });
});
