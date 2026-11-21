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

describe("the sending chain", () => {
  // rc17: after a flip from Sepolia's native coin to PulseChain, the picker still offered SepETH for the new direction.
  const coins = nativeTokensOf(FIXTURE_PAIR);
  const eth = coins.find((coin) => coin.side === "first")!;
  const pls = coins.find((coin) => coin.side === "second")!;
  const symbols = (): readonly string[] => screen.getAllByRole("option").map((option) => option.querySelector("b")?.textContent ?? "");

  it("opens on the sending chain's tab, so every row offered is a token of the current direction", () => {
    renderWithWallet(<TokenPicker tokens={[USDC, NATIVE, ...coins]} selected={pls} snapshots={[]} onPick={vi.fn()} onClose={vi.fn()} />, { wallet: connectedWallet() });
    expect(screen.getByRole("tab", { selected: true })).toHaveAttribute("aria-label", FIXTURE_PAIR.second.name);
    expect(symbols()).toEqual(["WETH", pls.symbol]);
    expect(screen.getByRole("option", { selected: true }).querySelector("b")?.textContent).toBe(pls.symbol);
  });

  it("the all-chains tab lists both chains, each row for its own chain, and only the sending chain's token is selected", async () => {
    const onPick = vi.fn();
    renderWithWallet(<TokenPicker tokens={[USDC, NATIVE, ...coins]} selected={pls} snapshots={[]} onPick={onPick} onClose={vi.fn()} />, { wallet: connectedWallet() });
    await userEvent.click(screen.getByRole("tab", { name: "All chains" }));
    expect(screen.getAllByRole("option", { selected: true })).toHaveLength(1);
    expect(symbols()).toEqual(expect.arrayContaining([eth.symbol, pls.symbol]));
    await userEvent.click(screen.getAllByRole("option").find((option) => option.querySelector("b")?.textContent === eth.symbol)!);
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ side: "first", symbol: eth.symbol }));
  });

  it("keeps the selected token listed by its chain and address, not only by identity", () => {
    const copy = { ...USDC };
    const rows = pickerRows({ tokens: [USDC, NATIVE], snapshots: [okSnapshot("first"), okSnapshot("second")], query: "", tab: "all", selected: copy });
    expect(rows.map((row) => row.symbol)).toEqual(["USDC"]);
  });
});

describe("the Omnibridge mark", () => {
  it("is a bridge icon after the symbol whose tooltip explains the double wrap and jumps to the native token", async () => {
    renderWithWallet(
      <TokenPicker tokens={[USDC, NATIVE, OMNI]} selected={NATIVE} snapshots={[]} used={new Set(["second:0x2000000000000000000000000000000000000002"])} omnibridgeNativeOf={(candidate) => (candidate === OMNI ? NATIVE : null)} onPick={vi.fn()} onClose={vi.fn()} />,
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

describe("the mint action of a row", () => {
  const coins = nativeTokensOf(FIXTURE_PAIR);
  it("shows no action unless the screen gives both the test and the handler", () => {
    renderWithWallet(<TokenPicker tokens={[USDC, ...coins]} selected={USDC} snapshots={[]} onMint={vi.fn()} onPick={vi.fn()} onClose={vi.fn()} />, { wallet: connectedWallet() });
    expect(screen.queryByRole("button", { name: /^Mint 1,000/ })).toBeNull();
  });
});

