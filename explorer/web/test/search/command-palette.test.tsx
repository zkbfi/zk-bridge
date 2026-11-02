import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { buildFixtureFeed, FIXTURE_NOW, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import { CommandPalette } from "../../src/search/CommandPalette";
import { viewResults, type SearchResult } from "../../src/search/search-model";
import { renderPage } from "../render";

const feedItem = buildFixtureFeed(FIXTURE_NOW)[3]!;

const open = (props: { readonly recent?: readonly SearchResult[]; readonly walletConnected?: boolean } = {}) => {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  renderPage(<CommandPalette recent={props.recent ?? []} walletConnected={props.walletConnected ?? false} onSelect={onSelect} onClose={onClose} />, { connected: false });
  return { onSelect, onClose, input: screen.getByRole("combobox") };
};

const options = (): HTMLElement[] => screen.queryAllByRole("option");
const groupTitles = (): string[] => screen.queryAllByRole("group").map((group) => group.firstElementChild?.textContent ?? "");

describe("the command palette", () => {
  it("is a combobox over a listbox with one labelled group per kind, and focus starts in the field", () => {
    const { input } = open();
    expect(input).toHaveFocus();
    expect(screen.getByRole("listbox", { name: "Results" })).toBeInTheDocument();
    expect(groupTitles()).toEqual(["Views", "Actions"]);
  });

  it("has a footer with the keys and quick links that open the same Settings and Docs as their result rows", async () => {
    const { onSelect } = open();
    const footer = document.querySelector(".zb-m-foot") as HTMLElement;
    expect(footer.querySelector(".zb-m-keys")?.getAttribute("aria-hidden")).toBe("true");
    expect([...footer.querySelectorAll("kbd")].map((key) => key.textContent)).toEqual(["↑", "↓", "↵", "esc"]);
    await userEvent.click(within(footer).getByRole("button", { name: "Settings" }));
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: "action:settings", jump: { type: "action", action: { name: "settings" } } }));
    await userEvent.click(within(footer).getByRole("button", { name: "Docs" }));
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: "view:docs" }));
  });

  it("shows recent results first when the field is empty", () => {
    open({ recent: [viewResults("eth-pls").find((result) => result.id === "view:audit")!] });
    expect(groupTitles()[0]).toBe("Recent");
    expect(within(screen.getAllByRole("group")[0]!).getByText("Audit")).toBeInTheDocument();
  });

  it("groups results by kind in a fixed order: views, tokens and actions match one query", async () => {
    const { input } = open();
    await userEvent.type(input, "t");
    await waitFor(() => expect(groupTitles().length).toBeGreaterThan(2));
    const titles = groupTitles();
    const expectedOrder = ["Transfers and messages", "Addresses", "Tokens", "Pairs", "Views", "Actions", "Docs"].filter((title) => titles.includes(title));
    expect(titles).toEqual(expectedOrder);
  });

  it("finds a token by symbol and by address on either chain", async () => {
    const { input } = open();
    await userEvent.type(input, "usdc");
    await waitFor(() => expect(within(screen.getAllByRole("group").find((group) => group.textContent?.startsWith("Tokens"))!).getAllByRole("option")).toHaveLength(2));
    await userEvent.clear(input);
    await userEvent.paste(FIXTURE_TOKENS[1]!.address.toLowerCase().slice(0, 12));
    await waitFor(() => expect(screen.getAllByRole("option").some((option) => option.textContent?.startsWith("zUSDC"))).toBe(true));
  });

  it("moves the highlight with the arrow keys and wraps, and keeps aria-activedescendant in step", async () => {
    const { input } = open();
    await userEvent.type(input, "a");
    await waitFor(() => expect(options().length).toBeGreaterThan(2));
    const selected = () => options().findIndex((option) => option.getAttribute("aria-selected") === "true");
    expect(selected()).toBe(0);
    await userEvent.keyboard("{ArrowDown}");
    expect(selected()).toBe(1);
    expect(input).toHaveAttribute("aria-activedescendant", options()[1]!.id);
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    expect(selected()).toBe(options().length - 1);
    await userEvent.keyboard("{Home}");
    expect(selected()).toBe(0);
    await userEvent.keyboard("{End}");
    expect(selected()).toBe(options().length - 1);
  });

  it("opens the highlighted result with Enter", async () => {
    const { input, onSelect } = open();
    await userEvent.type(input, "audit");
    await waitFor(() => expect(options()[0]).toHaveTextContent("Audit"));
    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "view:audit", jump: { type: "route", route: { name: "audit" } } }));
  });

  it("closes on Escape", async () => {
    const { onClose } = open();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  describe("jump targets", () => {
    const pick = async (query: string, title: RegExp) => {
      const { input, onSelect } = open();
      await userEvent.click(input);
      await userEvent.paste(query);
      const option = await screen.findByRole("option", { name: title });
      await userEvent.click(option);
      return onSelect.mock.calls[0]![0] as SearchResult;
    };

    it("a view leads to its route", async () => {
      expect((await pick("prover", /^Prover and costs/)).jump).toEqual({ type: "route", route: { name: "prover" } });
    });

    it("a pair leads to the pair view", async () => {
      expect((await pick("eth-pls", /^eth-pls/)).jump).toEqual({ type: "route", route: { name: "pair", pairId: "eth-pls", token: null } });
    });

    it("a token leads to the pair view filtered to that token", async () => {
      const usdc = FIXTURE_TOKENS[0]!;
      expect((await pick("usdc", /^USDC/)).jump).toEqual({ type: "route", route: { name: "pair", pairId: "eth-pls", token: usdc.address } });
    });

    it("an action starts that action", async () => {
      expect((await pick("bridge", /^Bridge tokens/)).jump).toEqual({ type: "action", action: { name: "bridge" } });
    });

    it("a chain switch names the chain", async () => {
      expect((await pick("switch pulsechain", /^Switch the wallet to PulseChain/)).jump).toEqual({ type: "action", action: { name: "switch-chain", chainId: 369 } });
    });

    it("a documentation heading leads to its page and heading", async () => {
      expect((await pick("data source", /^The data source of each number/)).jump).toEqual({ type: "route", route: { name: "docs", slug: "fees-explained", heading: "the-data-source-of-each-number" } });
    });

    it("a message identifier leads to the page of that transfer, through the indexer", async () => {
      const result = await pick(feedItem.id, /Transfer|Message/);
      expect(result.jump).toEqual({ type: "route", route: { name: "message", messageId: feedItem.id } });
    });

    it("a source transaction hash leads to the same transfer", async () => {
      const result = await pick(feedItem.sourceTransactionHash, /Transfer|Message/);
      expect(result.jump).toEqual({ type: "route", route: { name: "message", messageId: feedItem.id } });
      expect(result.subtitle).toContain("found by transaction");
    });

    it("a destination transaction hash leads to the same transfer", async () => {
      const delivered = buildFixtureFeed(FIXTURE_NOW).find((item) => item.destinationTransactionHash !== null)!;
      const result = await pick(delivered.destinationTransactionHash!, /Transfer|Message/);
      expect(result.jump).toEqual({ type: "route", route: { name: "message", messageId: delivered.id } });
    });

    it("an address leads to the page of that address, with no indexer read needed to list it", async () => {
      const result = await pick(`0x${"ab".repeat(20)}`, /^0x/);
      expect(result.jump).toEqual({ type: "route", route: { name: "address", address: expect.stringMatching(/^0x/) } });
    });
  });

  it("says so when the indexer knows no message with a hash", async () => {
    const { input } = open();
    await userEvent.click(input);
    await userEvent.paste(`0x${"77".repeat(32)}`);
    expect(await screen.findByText(/knows no message with this identifier or transaction hash/)).toBeInTheDocument();
  });
});
