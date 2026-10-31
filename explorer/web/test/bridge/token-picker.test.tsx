import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { TokenInfo } from "@terminal/model/types";
import { pickerRows, TokenPicker } from "../../src/bridge/TokenPicker";
import { connectedWallet, renderWithWallet } from "../app/support";

const token = (symbol: string, side: "first" | "second", address: string, counterpart: string | null = null): TokenInfo =>
  ({ symbol, side, address: address as `0x${string}`, decimals: 18, counterpart: counterpart as `0x${string}` | null });

const NATIVE = token("WETH", "second", "0x1000000000000000000000000000000000000001");
const OMNI = token("WETH", "second", "0x2000000000000000000000000000000000000002");
const USDC = token("USDC", "first", "0x3000000000000000000000000000000000000003");
const USED = token("DAI", "first", "0x4000000000000000000000000000000000000004");

describe("pickerRows", () => {
  it("lists only held, used or selected tokens until the user searches; a search covers every token", () => {
    const rows = pickerRows({ tokens: [USDC, USED, NATIVE], snapshots: [], used: new Set(["first:0x4000000000000000000000000000000000000004"]), query: "", tab: "all", selected: USDC });
    expect(rows.map((row) => row.symbol)).toEqual(["USDC", "DAI"]);
    expect(pickerRows({ tokens: [USDC, USED, NATIVE], snapshots: [], query: "weth", tab: "all", selected: USDC }).map((row) => row.symbol)).toEqual(["WETH"]);
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
