import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { TokenInfo } from "@terminal/model/types";
import type { ChainSnapshotResult } from "@terminal/chain/live-reads";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { TokenPicker } from "../../src/bridge/TokenPicker";
import { connectedWallet, renderWithWallet } from "../app/support";

const token = (symbol: string, address: string, side: "first" | "second" = "first"): TokenInfo => ({ symbol, side, address: address as `0x${string}`, decimals: 18, counterpart: null });
const A = token("AAA", "0x1000000000000000000000000000000000000001");
const B = token("BBB", "0x2000000000000000000000000000000000000002");
const C = token("CCC", "0x3000000000000000000000000000000000000003");
const UNKNOWN = "0x9999999999999999999999999999999999999999";

const render = (props: Partial<Parameters<typeof TokenPicker>[0]> = {}) => {
  const onPick = vi.fn();
  const onClose = vi.fn();
  renderWithWallet(<TokenPicker tokens={[A, B, C]} selected={A} snapshots={[]} onPick={onPick} onClose={onClose} {...props} />, { wallet: connectedWallet() });
  return { onPick, onClose };
};
const activeSymbol = (): string | undefined => screen.getAllByRole("option").find((option) => option.getAttribute("data-active") === "true")?.querySelector("b")?.textContent ?? undefined;

describe("the picker keys", () => {
  it("moves the active row with the arrow keys, wrapping at both ends, and picks it on Enter", async () => {
    const { onPick } = render();
    const search = screen.getByRole("combobox", { name: "Search tokens" });
    await userEvent.click(search);
    expect(activeSymbol()).toBe("AAA");
    await userEvent.keyboard("{ArrowDown}");
    expect(activeSymbol()).toBe("BBB");
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    expect(activeSymbol()).toBe("CCC");
    await userEvent.keyboard("{ArrowDown}");
    expect(activeSymbol()).toBe("AAA");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onPick).toHaveBeenCalledWith(B);
    await userEvent.keyboard("a");
    expect(onPick).toHaveBeenCalledOnce();
  });

  it("does nothing on Enter when no row matches, and the arrows stay put", async () => {
    const { onPick } = render();
    await userEvent.type(screen.getByRole("combobox"), "zzz{ArrowDown}{Enter}");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("follows the pointer and picks on a click, and closes from the close square", async () => {
    const { onPick, onClose } = render();
    await userEvent.hover(screen.getByRole("option", { name: /CCC/ }));
    expect(activeSymbol()).toBe("CCC");
    await userEvent.click(screen.getByRole("option", { name: /BBB/ }));
    expect(onPick).toHaveBeenCalledWith(B);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows the balance of a token the wallet holds, and none when unknown", () => {
    const held: ChainSnapshotResult = { status: "ok", snapshot: { chain: FIXTURE_PAIR.first, nativeBalance: 0n, positions: [{ token: B, balance: 5n * 10n ** 18n }] } as never };
    render({ snapshots: [held], used: new Set([`first:${A.address}`]), selected: B });
    const rows = screen.getAllByRole("option");
    expect(rows.map((row) => row.querySelector("b")?.textContent)).toEqual(["AAA", "BBB"]);
    expect(rows[1]!.querySelector(".zb-token-balance")?.textContent).toBe("5");
    expect(rows[1]).toHaveAttribute("aria-selected", "true");
  });
});

describe("the Omnibridge mark from the keyboard", () => {
  it("opens its tooltip on Enter, closes on a second Enter or click, and ignores other keys", async () => {
    render({ omnibridgeNativeOf: (candidate) => (candidate === B ? A : null) });
    const mark = screen.getByRole("button", { name: "Came over the Omnibridge" });
    act(() => mark.focus());
    await userEvent.keyboard("x");
    expect(screen.queryByRole("tooltip")).toBeNull();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tooltip"));
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByRole("tooltip")).toBeNull();
    await userEvent.click(mark);
    await userEvent.click(mark);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

describe("a pasted address that is in no list", () => {
  const custom = (): TokenInfo => ({ ...token("FROG", UNKNOWN), custom: true }) as TokenInfo;

  it("says Reading while the chain answers, then lists the token, on the sending chain when the tab is all chains", async () => {
    let answer: (found: TokenInfo | null) => void = () => undefined;
    const resolveCustom = vi.fn(() => new Promise<TokenInfo | null>((resolve) => { answer = resolve; }));
    const { onPick } = render({ resolveCustom, selected: A });
    await userEvent.click(screen.getByRole("tab", { name: "All chains" }));
    await userEvent.type(screen.getByRole("combobox"), UNKNOWN);
    expect(await screen.findByText("Reading…")).toBeInTheDocument();
    expect(resolveCustom).toHaveBeenLastCalledWith(UNKNOWN, "first");
    await act(async () => answer(custom()));
    expect(await screen.findByRole("option", { name: /FROG/ })).toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ symbol: "FROG" }));
  });

  it("reads on the tab's chain, says Not a token when the chain does not know it, and ignores an answer that comes after the text changed", async () => {
    const answers: ((found: TokenInfo | null) => void)[] = [];
    const resolveCustom = vi.fn(() => new Promise<TokenInfo | null>((resolve) => answers.push(resolve)));
    render({ resolveCustom });
    await userEvent.click(screen.getByRole("tab", { name: FIXTURE_PAIR.second.name }));
    const search = screen.getByRole("combobox");
    await userEvent.type(search, UNKNOWN);
    expect(resolveCustom).toHaveBeenLastCalledWith(UNKNOWN, "second");
    await userEvent.clear(search);
    await act(async () => answers[0]!(custom()));
    expect(screen.queryByRole("option", { name: /FROG/ })).toBeNull();
    expect(screen.queryByText("Reading…")).toBeNull();
    await userEvent.type(search, UNKNOWN);
    await act(async () => answers.at(-1)!(null));
    await waitFor(() => expect(screen.getByText("Not a token")).toBeInTheDocument());
  });

  it("does not read an address the lists already hold", async () => {
    const resolveCustom = vi.fn(async () => null);
    render({ resolveCustom });
    await userEvent.type(screen.getByRole("combobox"), A.address);
    expect(resolveCustom).not.toHaveBeenCalled();
  });
});
