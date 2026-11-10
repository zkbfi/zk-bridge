import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFixtureExploreSource } from "../../src/explore/explore-fixture";
import { Shell } from "../../src/app/Shell";
import { connectedWallet, renderWithWallet } from "../app/support";
import { buildTestServices } from "../render";
import { FIXTURE_TOKENS } from "@terminal/data/fixtures";
import type { FeedItem } from "@terminal/model/types";

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "#/explore");
});

describe("Explore's top", () => {
  it("leads with the search band, then browse rows with live counts, the map, the numbers, the light clients, the feed and the services", async () => {
    const { container } = renderWithWallet(<Shell />, { wallet: connectedWallet() });
    expect(await screen.findByRole("combobox", { name: "Search Explore" })).toBeInTheDocument();
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

  it("shows the delivery fee under a latest transfer that a delivery router delivered", async () => {
    const base = buildTestServices();
    const token = FIXTURE_TOKENS[0]!;
    const unit = 10n ** BigInt(token.decimals);
    const now = Math.floor(Date.now() / 1000);
    const delivered = {
      id: `0x${"05".repeat(32)}`,
      kind: "token",
      direction: "first-to-second",
      status: "delivered",
      sender: "0x52908400098527886E0F7030069857D2E4169EE7",
      recipient: "0x52908400098527886E0F7030069857D2E4169EE7",
      token,
      amount: (123n * unit) / 10n,
      sentAt: now - 3600,
      deliveredAt: now - 3000,
      sourceTransactionHash: `0x${"11".repeat(32)}`,
      destinationTransactionHash: `0x${"22".repeat(32)}`,
      delivery: { token, fee: (123n * unit) / 10_000n, received: (122_877n * unit) / 10_000n },
    } as FeedItem;
    renderWithWallet(<Shell />, { wallet: connectedWallet(), services: { dataSource: { ...base.dataSource, getFeed: async () => ({ items: [delivered], hasMore: false }) } } });
    expect(await screen.findByText(/^12\.3 \S+ sent · 0\.0123 \S+ fee \(0\.1%\) · 12\.2877 \S+ received$/)).toBeInTheDocument();
  });

  it("puts the in-flight orbits, one loop for the pair, after the search band and before the browse rows", async () => {
    const { container } = renderWithWallet(<Shell />, { wallet: connectedWallet() });
    const heading = await screen.findByRole("heading", { name: /In flight/ });
    const browse = screen.getByRole("heading", { name: /Browse/ });
    expect(heading.compareDocumentPosition(browse) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelectorAll("svg.zb-orb-svg[role=group]")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Show as a list" })).toBeInTheDocument();
  });

  it("says what it recognised and groups the results, the match underlined", async () => {
    renderWithWallet(<Shell />, { wallet: connectedWallet() });
    const band = await screen.findByRole("combobox", { name: "Search Explore" });
    await userEvent.type(band, "0x4663c8c2");
    expect(await screen.findByText(/Partial hash or address · 2 found/)).toBeInTheDocument();
    const proofs = await screen.findByRole("heading", { name: /Proofs/ });
    expect(proofs).toBeInTheDocument();
    const marks = document.querySelectorAll("mark.zb-match");
    expect(marks.length).toBeGreaterThan(0);
    expect(marks[0]).toHaveTextContent("0x4663c8c2");
    expect(window.location.hash).toBe("#/explore?q=0x4663c8c2");
  });

  it("finds an old update by its whole transaction hash in the indexer's history, not only among the latest ones", async () => {
    const base = createFixtureExploreSource();
    const [recorded] = await base.proofs();
    const hash = `0x${"cd".repeat(32)}` as const;
    const findProofs = vi.fn(async () => [{ ...recorded!, number: 4_321, transactionHash: hash }]);
    renderWithWallet(<Shell />, { wallet: connectedWallet(), services: { explore: { ...base, proofs: async () => [], findProofs } } });
    await userEvent.type(await screen.findByRole("combobox", { name: "Search Explore" }), hash.toUpperCase().replace("0X", "0x"));
    expect(await screen.findByRole("link", { name: /Proof #4321/ })).toBeInTheDocument();
    expect(findProofs).toHaveBeenCalledWith({ transactionHash: hash });
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

describe("Explore's search shortcuts", () => {
  const open = async () => {
    renderWithWallet(<Shell />, { wallet: connectedWallet() });
    const band = await screen.findByRole("combobox", { name: "Search Explore" });
    await userEvent.click(band);
    return band;
  };

  it("shows no hint chips under the empty box", async () => {
    const { container } = renderWithWallet(<Shell />, { wallet: connectedWallet() });
    await screen.findByRole("combobox", { name: "Search Explore" });
    expect(container.querySelector(".zb-xkind")).toBeNull();
    expect(screen.queryByText(/64 hex/)).toBeNull();
  });

  it("opens a listbox of real destinations when the empty box gets focus, closed until then", async () => {
    renderWithWallet(<Shell />, { wallet: connectedWallet() });
    const band = await screen.findByRole("combobox", { name: "Search Explore" });
    expect(band).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).toBeNull();
    await userEvent.click(band);
    const list = await screen.findByRole("listbox", { name: "Shortcuts" });
    expect(band).toHaveAttribute("aria-expanded", "true");
    expect(band).toHaveAttribute("aria-controls", list.id);
    const options = within(list).getAllByRole("option");
    expect(options.length).toBeGreaterThan(0);
    for (const group of within(list).getAllByRole("group")) expect(group).toHaveAccessibleName();
    expect(within(list).getByText("Light clients")).toBeInTheDocument();
  });

  it("moves with the arrow keys, opens with Enter and closes with Escape", async () => {
    const band = await open();
    const list = await screen.findByRole("listbox");
    const options = within(list).getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowDown}");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(band).toHaveAttribute("aria-activedescendant", options[1]!.id);
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    expect(options.at(-1)).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    await userEvent.keyboard("{ArrowDown}");
    expect(await screen.findByRole("listbox")).toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(window.location.hash).not.toBe("#/explore"));
    expect(window.location.hash).toMatch(/^#\/explore\//);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("opens the row that is clicked", async () => {
    await open();
    const option = within(await screen.findByRole("listbox")).getAllByRole("option")[0]!;
    await userEvent.hover(option);
    await userEvent.click(option);
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/explore\//));
  });

  it("closes when the user types, and the normal results take over", async () => {
    const band = await open();
    await screen.findByRole("listbox");
    await userEvent.keyboard("0x4663c8c2");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(band).toHaveAttribute("aria-expanded", "false");
    expect(await screen.findByText(/Partial hash or address · 2 found/)).toBeInTheDocument();
    expect(window.location.hash).toBe("#/explore?q=0x4663c8c2");
  });

  it("closes when focus leaves the box, and keeps the focus when a row is pressed", async () => {
    await open();
    await screen.findByRole("listbox");
    await userEvent.click(screen.getByRole("button", { name: "Clear the search" }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await userEvent.click(document.body);
    await userEvent.tab();
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
