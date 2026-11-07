import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { TokenInfo } from "@terminal/model/types";
import { pickerRows, TokenPicker } from "../../src/bridge/TokenPicker";
import type { ChainSnapshotResult } from "@terminal/chain/live-reads";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { nativeTokensOf } from "../../src/bridge/bridge-model";
import { connectedWallet, renderWithWallet } from "../app/support";

const token = (symbol: string, side: "first" | "second", address: string, counterpart: string | null = null): TokenInfo =>
  ({ symbol, side, address: address as `0x${string}`, decimals: 18, counterpart: counterpart as `0x${string}` | null });

const NATIVE = token("WETH", "second", "0x1000000000000000000000000000000000000001");
const OMNI = token("WETH", "second", "0x2000000000000000000000000000000000000002");
const USDC = token("USDC", "first", "0x3000000000000000000000000000000000000003");
const USED = token("DAI", "first", "0x4000000000000000000000000000000000000004");

const okSnapshot = (side: "first" | "second"): ChainSnapshotResult => ({
  status: "ok",
  snapshot: { chain: side === "first" ? FIXTURE_PAIR.first : FIXTURE_PAIR.second, nativeBalance: 0n, positions: [] },
});

describe("pickerRows", () => {
  it("lists only held, used or selected tokens until the user searches; a search covers every token", () => {
    const snapshots = [okSnapshot("first"), okSnapshot("second")];
    const rows = pickerRows({ tokens: [USDC, USED, NATIVE], snapshots, used: new Set(["first:0x4000000000000000000000000000000000000004"]), query: "", tab: "all", selected: USDC });
    expect(rows.map((row) => row.symbol)).toEqual(["USDC", "DAI"]);
    expect(pickerRows({ tokens: [USDC, USED, NATIVE], snapshots, query: "weth", tab: "all", selected: USDC }).map((row) => row.symbol)).toEqual(["WETH"]);
  });

  it("always lists the native coin of each chain, even when the balances are known and zero", () => {
    const coin = (side: "first" | "second") => nativeTokensOf(FIXTURE_PAIR).find((candidate) => candidate.side === side)!;
    const rows = pickerRows({ tokens: [USDC, coin("first"), coin("second")], snapshots: [okSnapshot("first"), okSnapshot("second")], query: "", tab: "all", selected: USDC });
    expect(rows).toEqual([USDC, coin("first"), coin("second")]);
  });

  it("lists a chain's bridgeable tokens while its balances are unknown (loading or failed), and only that chain's", () => {
    const failed: ChainSnapshotResult = { status: "error", chain: FIXTURE_PAIR.first, message: "429" };
    const tokens = [USDC, USED, NATIVE];
    expect(pickerRows({ tokens, snapshots: [failed, okSnapshot("second")], query: "", tab: "all", selected: NATIVE }).map((row) => row.symbol)).toEqual(["USDC", "DAI", "WETH"]);
    expect(pickerRows({ tokens, snapshots: [], query: "", tab: "all", selected: NATIVE }).map((row) => row.symbol)).toEqual(["USDC", "DAI", "WETH"]);
    // The first chain's balances are known (none held), the second chain's failed: its token still shows.
    const failedSecond: ChainSnapshotResult = { status: "error", chain: FIXTURE_PAIR.second, message: "429" };
    expect(pickerRows({ tokens, snapshots: [okSnapshot("first"), failedSecond], query: "", tab: "all", selected: USDC }).map((row) => row.symbol)).toEqual(["USDC", "WETH"]);
  });
});

describe("the Omnibridge mark", () => {
  it("is a bridge icon after the symbol whose tooltip explains the double wrap and jumps to the native token", async () => {
    renderWithWallet(
      <TokenPicker tokens={[USDC, NATIVE, OMNI]} selected={USDC} snapshots={[]} used={new Set(["second:0x2000000000000000000000000000000000000002"])} omnibridgeNativeOf={(candidate) => (candidate === OMNI ? NATIVE : null)} onPick={vi.fn()} onClose={vi.fn()} />,
      { wallet: connectedWallet() },
    );
    const mark = screen.getByRole("button", { name: "Came over the Omnibridge" });
    expect(mark.textContent).toBe("");
    await userEvent.click(mark);
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent(/wraps it a second time/);
    await userEvent.click(within(tip).getByRole("button", { name: /Use native WETH/ }));
    expect(screen.getByRole("tab", { selected: true })).toHaveAttribute("aria-label", expect.stringMatching(/./));
    const active = screen.getAllByRole("option").find((option) => option.getAttribute("data-active") === "true");
    expect(active?.textContent).toContain("WETH");
  });

  it("shows the unit price under the symbol, with the leading-zeros rule", () => {
    renderWithWallet(<TokenPicker tokens={[USDC]} selected={USDC} snapshots={[]} priceOf={() => "0.000028"} onPick={vi.fn()} onClose={vi.fn()} />, { wallet: connectedWallet() });
    expect(screen.getByRole("option").querySelector("sub")?.textContent).toBe("4");
  });
});
