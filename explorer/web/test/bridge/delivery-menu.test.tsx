import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { Shell } from "../../src/app/Shell";
import { deliverySummary, gasLevelOf } from "../../src/bridge/DeliveryMenu";
import { connectedWallet, renderWithWallet } from "../app/support";

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}?bridge.amount=0.01`);
});

describe("deliverySummary and gasLevelOf", () => {
  it("reads Standard delivery until something differs", () => {
    expect(deliverySummary({})).toBe("Standard delivery");
    expect(deliverySummary({ tip: { mode: "percentage", percentText: "0.3" } })).toBe("Fast · tip 0.3%");
    expect(deliverySummary({ tip: { mode: "fixed" }, gasLimit: "500000" })).toBe("fixed tip · gas 500000");
  });

  it("maps the gas multiplier to the bars", () => {
    expect([gasLevelOf(undefined), gasLevelOf("1.5"), gasLevelOf("2")]).toEqual([1, 2, 3]);
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
  it("opens from the gas can and picks a higher level", async () => {
    renderWithWallet(<Shell />, { wallet: connectedWallet() });
    const can = await waitFor(() => {
      const found = document.querySelector<HTMLButtonElement>('button[data-fee="gas"]');
      expect(found).not.toBeNull();
      return found!;
    });
    await userEvent.click(can);
    await userEvent.click(screen.getByRole("radio", { name: /Highest/ }));
    await waitFor(() => expect(window.location.hash).toMatch(/tip\.gas=2/));
  });
});
