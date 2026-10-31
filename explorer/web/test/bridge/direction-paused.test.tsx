import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { Shell } from "../../src/app/Shell";
import { buildTestServices } from "../render";
import { connectedWallet, renderWithWallet } from "../app/support";

describe("a paused route", () => {
  it("is greyed in the route menu with its reason, and cannot be picked", async () => {
    window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}`);
    const base = buildTestServices();
    const dataSource = {
      ...base.dataSource,
      listPairs: async () => (await base.dataSource.listPairs()).map((entry) => (entry.pairId === FIXTURE_PAIR.id ? { ...entry, gates: { first: "open" as const, second: "stop" as const } } : entry)),
    };
    renderWithWallet(<Shell />, { wallet: connectedWallet(), services: { dataSource } });
    await userEvent.click(await screen.findByRole("button", { name: /^From .*Change the route/ }));
    const menu = screen.getByRole("menu", { name: "Route" });
    await waitFor(() => {
      const paused = within(menu).getAllByRole("menuitemradio").find((item) => item.getAttribute("aria-disabled") === "true" && /paused/.test(item.textContent ?? ""));
      expect(paused).toBeDefined();
      expect(paused?.textContent).toMatch(new RegExp(`paused: the gate on ${FIXTURE_PAIR.second.name} is closed`));
    });
  });
});
