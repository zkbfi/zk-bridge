import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { Shell } from "../../src/app/Shell";
import { deliverySummary } from "../../src/bridge/DeliveryMenu";
import { connectedWallet, renderWithWallet } from "../app/support";

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}?bridge.amount=0.01`);
});

describe("deliverySummary", () => {
  it("reads Standard delivery until something differs", () => {
    expect(deliverySummary({})).toBe("Standard delivery");
    expect(deliverySummary({ tip: { mode: "percentage", percentText: "0.3" } })).toBe("Fast · tip 0.3%");
    expect(deliverySummary({ tip: { mode: "fixed" }, gasLimit: "500000" })).toBe("fixed tip · gas 500000");
    // A share from the tip drawer is the whole fee's, shown short.
    expect(deliverySummary({ tip: { mode: "percentage", percentText: "0.850000504" } })).toBe("fee 0.85%");
  });
});

describe("the delivery settings menu", () => {
  it("opens from the pill, offers speed and tip as pill segments, and Fast writes a 0.3% tip to the address", async () => {
    renderWithWallet(<Shell />, { wallet: connectedWallet() });
    await userEvent.click(await screen.findByRole("button", { name: /^Delivery settings/ }));
    const menu = screen.getByRole("group", { name: "Delivery settings" });
    expect(within(menu).getByRole("radiogroup", { name: "Speed" })).toBeInTheDocument();
    expect(within(menu).getByRole("radiogroup", { name: "Tip" })).toBeInTheDocument();
    expect(within(menu).getByRole("textbox", { name: /Gas limit/ })).toBeInTheDocument();
    expect(within(menu).getByRole("textbox", { name: /Relay router/ })).toBeInTheDocument();
    await userEvent.click(within(menu).getByRole("radio", { name: "Fast" }));
    await waitFor(() => expect(window.location.hash).toMatch(/tip\.percent=0\.3/));
    expect(screen.getByRole("button", { name: /^Delivery settings: Fast/ })).toBeInTheDocument();
  });
});

describe("the gas level on the gas can", () => {
  it("is the bars beside the can: each tap moves up a level, and Highest wraps back to Normal", async () => {
    renderWithWallet(<Shell />, { wallet: connectedWallet() });
    const bars = await screen.findByRole("button", { name: "Gas level: Normal. Change" });
    // No separate level picker anywhere.
    expect(screen.queryByRole("radiogroup", { name: "Gas level" })).toBeNull();
    await userEvent.click(bars);
    // The level raises the gas price ceiling (in every tip mode), not the gas multiplier.
    await waitFor(() => expect(screen.getByRole("button", { name: "Gas level: High. Change" })).toBeInTheDocument());
    expect(window.location.hash).toMatch(/tip\.ceiling=/);
    expect(window.location.hash).not.toMatch(/tip\.gas=/);
    await userEvent.click(screen.getByRole("button", { name: "Gas level: High. Change" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Gas level: Highest. Change" })).toBeInTheDocument());
    expect(document.querySelector('[data-fee="gas"] svg[data-level]')).toHaveAttribute("data-level", "3");
    await userEvent.click(screen.getByRole("button", { name: "Gas level: Highest. Change" }));
    await waitFor(() => expect(window.location.hash).not.toMatch(/tip\.ceiling=/));
    expect(screen.getByRole("button", { name: "Gas level: Normal. Change" })).toBeInTheDocument();
  });

  it("steps with the arrow keys when focused, without wrapping", async () => {
    renderWithWallet(<Shell />, { wallet: connectedWallet() });
    const bars = await screen.findByRole("button", { name: "Gas level: Normal. Change" });
    bars.focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(window.location.hash).not.toMatch(/tip\.ceiling=/);
    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Gas level: High. Change" })).toBeInTheDocument());
    await userEvent.keyboard("{ArrowUp}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Gas level: Highest. Change" })).toBeInTheDocument());
    await userEvent.keyboard("{ArrowUp}");
    expect(screen.getByRole("button", { name: "Gas level: Highest. Change" })).toBeInTheDocument();
    await userEvent.keyboard("{ArrowDown}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Gas level: High. Change" })).toBeInTheDocument());
  });
});
