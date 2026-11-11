import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { DirectionMenu } from "../../src/bridge/DirectionMenu";
import type { Services } from "../../src/app/services";
import { buildTestServices } from "../render";
import { disconnectedWallet, renderWithWallet } from "../app/support";

const known = (...entries: Array<[string, boolean]>): Services["knownPairs"] => entries.map(([id, configured]) => ({ id, label: id, configured, active: id === FIXTURE_PAIR.id }));

const open = (options: { readonly pairs: Services["knownPairs"]; readonly gates?: { first: "open" | "stop" | "sealed"; second: "open" | "stop" | "sealed" } }) => {
  const base = buildTestServices();
  const dataSource = {
    ...base.dataSource,
    listPairs: async () => (await base.dataSource.listPairs()).map((entry) => (options.gates === undefined ? entry : { ...entry, gates: options.gates })),
  };
  const onPick = vi.fn();
  const onClose = vi.fn();
  renderWithWallet(<DirectionMenu current={{ pairId: FIXTURE_PAIR.id, dir: "first-to-second" }} onPick={onPick} onClose={onClose} />, {
    wallet: disconnectedWallet(),
    services: { dataSource, knownPairs: options.pairs },
  });
  return { onPick, onClose, menu: screen.getByRole("menu", { name: "Route" }) };
};

describe("the route menu", () => {
  it("lists a pair's two directions, skips a pair it has no chains for, and puts the testnet pair under its own heading", () => {
    const { menu } = open({ pairs: known(["sepolia-pls943", true], ["mystery", true], [FIXTURE_PAIR.id, true]) });
    const groups = within(menu).getAllByRole("group").map((group) => group.getAttribute("aria-label"));
    // Mainnet first, then the testnet group; the unknown pair has no group at all.
    expect(groups).toEqual(["Ethereum ⇄ PulseChain", "Testnet: Sepolia ⇄ PulseChain v4"]);
    expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(4);
    expect(within(menu).getByText("Testnet")).toBeInTheDocument();
  });

  it("starts on the current route, lit, and Arrow keys move through the open routes and wrap; Escape closes", async () => {
    const { menu, onClose } = open({ pairs: known([FIXTURE_PAIR.id, true], ["sepolia-pls943", true]) });
    const items = within(menu).getAllByRole("menuitemradio");
    await waitFor(() => expect(items[0]).toHaveFocus());
    expect(items[0]).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{ArrowDown}");
    expect(items[1]).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    expect(items[3]).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(items[0]).toHaveFocus();
    await userEvent.keyboard("a");
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("greys a route whose source gate is sealed or stopped, with the reason, and picking it does nothing; an open one picks", async () => {
    const { menu, onPick } = open({ pairs: known([FIXTURE_PAIR.id, true]), gates: { first: "sealed", second: "open" } });
    const [forward, back] = within(menu).getAllByRole("menuitemradio");
    await waitFor(() => expect(forward).toHaveAttribute("aria-disabled", "true"));
    expect(forward).toHaveTextContent("paused: the gate on Ethereum is closed");
    await userEvent.click(forward!);
    expect(onPick).not.toHaveBeenCalled();
    await userEvent.click(back!);
    expect(onPick).toHaveBeenCalledWith({ pairId: FIXTURE_PAIR.id, dir: "second-to-first" });
  });

  it("greys a pair with no deployment as not deployed yet, and takes no focus when every route is greyed", async () => {
    const { menu } = open({ pairs: known(["sepolia-pls943", false]) });
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items.map((item) => item.getAttribute("aria-disabled"))).toEqual(["true", "true"]);
    for (const item of items) expect(item).toHaveTextContent("not deployed yet");
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.keyboard("{ArrowUp}");
    expect(menu).toBeInTheDocument();
  });

  it("greys a route whose source gate is stopped, naming the source chain", async () => {
    const { menu } = open({ pairs: known([FIXTURE_PAIR.id, true]), gates: { first: "open", second: "stop" } });
    const back = within(menu).getAllByRole("menuitemradio")[1]!;
    await waitFor(() => expect(back).toHaveAttribute("aria-disabled", "true"));
    expect(back).toHaveTextContent("paused: the gate on PulseChain is closed");
  });
});
