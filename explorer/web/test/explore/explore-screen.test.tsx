import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { Shell } from "../../src/app/Shell";
import { connectedWallet, renderWithWallet } from "../app/support";

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "#/explore");
});

describe("Explore's top", () => {
  it("leads with the search band, then browse rows with live counts, the map, the numbers, the light clients, the feed and the services", async () => {
    const { container } = renderWithWallet(<Shell />, { wallet: connectedWallet() });
    expect(await screen.findByRole("searchbox", { name: "Search Explore" })).toBeInTheDocument();
    const proofs = await screen.findByRole("link", { name: /Proofs\s*light-client updates/ });
    // The recorded indexer answer has one light-client update.
    await waitFor(() => expect(proofs.querySelector(".zb-tile-n")).toHaveTextContent("1"));
    for (const title of ["Transfers & messages", "Tokens", "Addresses", "Contracts", "Gates & escrow", "Costs", "Releases"]) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
    expect(container.querySelector(".zb-xmap svg")).not.toBeNull();
    expect(screen.getByText("Median time")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Light clients/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Latest transfers/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Services/ })).toBeInTheDocument();
    // Icons on the orange map sit on a plate.
    expect(container.querySelectorAll(".zb-xmap .zb-tok-icon.zb-on-accent")).toHaveLength(2);
  });

  it("says what it recognised and groups the results, the match underlined", async () => {
    renderWithWallet(<Shell />, { wallet: connectedWallet() });
    const band = await screen.findByRole("searchbox", { name: "Search Explore" });
    await userEvent.type(band, "0x4663c8c2");
    expect(await screen.findByText(/Partial hash or address · 2 found/)).toBeInTheDocument();
    const proofs = await screen.findByRole("heading", { name: /Proofs/ });
    expect(proofs).toBeInTheDocument();
    const marks = document.querySelectorAll("mark.zb-match");
    expect(marks.length).toBeGreaterThan(0);
    expect(marks[0]).toHaveTextContent("0x4663c8c2");
    expect(window.location.hash).toBe("#/explore?q=0x4663c8c2");
  });

  it("browses one kind: the proofs, routed as chain icons, with a one-word status and the chevron last", async () => {
    window.history.replaceState(null, "", "#/explore/browse/proofs");
    renderWithWallet(<Shell />, { wallet: connectedWallet() });
    const row = await screen.findByRole("link", { name: /Proof #1/ });
    expect(row).toHaveAttribute("href", "#/explore/proof/11155111/1");
    expect(within(row).getByText("posted")).toHaveClass("zb-xstatus");
    expect(row.lastElementChild).toHaveClass("zb-chev");
    expect(row.querySelector(".zb-xroute")).not.toBeNull();
  });
});
