import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { TokenInfo } from "@terminal/model/types";
import { isFirstBridge, resolveCustomToken, type Erc20Reader } from "../../src/bridge/custom-token";
import { TokenPicker } from "../../src/bridge/TokenPicker";
import { verdictOf } from "../../src/bridge/verdict";
import { connectedWallet, renderWithWallet } from "../app/support";

const UNKNOWN = "0x9999999999999999999999999999999999999999";
const KNOWN: TokenInfo = { address: "0x3000000000000000000000000000000000000003", symbol: "USDC", decimals: 6, side: "first", counterpart: "0x3000000000000000000000000000000000000004" };

const reader = (answers: Record<string, unknown>): Erc20Reader => async (_address, fn) => {
  if (!(fn in answers)) throw new Error("reverted");
  return answers[fn];
};

describe("resolveCustomToken", () => {
  it("reads a pasted ERC-20's symbol, name and decimals", async () => {
    expect(await resolveCustomToken(UNKNOWN, "first", reader({ symbol: "FROG", name: "Frog Coin", decimals: 18 }))).toMatchObject({ symbol: "FROG", name: "Frog Coin", decimals: 18, side: "first", counterpart: null, custom: true });
  });

  it("refuses a contract that does not answer as an ERC-20, odd symbols and odd decimals", async () => {
    expect(await resolveCustomToken(UNKNOWN, "first", reader({}))).toBeNull();
    expect(await resolveCustomToken(UNKNOWN, "first", reader({ symbol: "<script>".repeat(10), decimals: 18 }))).toBeNull();
    expect(await resolveCustomToken(UNKNOWN, "first", reader({ symbol: "OK", decimals: 99 }))).toBeNull();
    expect(await resolveCustomToken("not an address", "first", reader({ symbol: "OK", decimals: 6 }))).toBeNull();
  });
});

describe("the first-bridge warning", () => {
  const ready = { connected: true, draft: { status: "ready" as const, reason: null }, amountEntered: true, overBalance: false, symbol: "FROG", paused: null, tipBelowBreakEven: false };

  it("warns, overridably, for a token zkb.fi has never bridged", () => {
    const custom = { ...KNOWN, address: UNKNOWN as `0x${string}`, symbol: "FROG" };
    expect(isFirstBridge(custom, [KNOWN], false)).toBe(true);
    const verdict = verdictOf({ ...ready, firstBridge: true });
    expect(verdict).toMatchObject({ kind: "warn", label: "First time this token is bridged · keep the amount low" });
    expect(verdict.detail).toMatch(/deploys its counterpart/);
  });

  it("does not warn for a known token", () => {
    expect(isFirstBridge(KNOWN, [KNOWN], false)).toBe(false);
    expect(verdictOf({ ...ready, firstBridge: false }).kind).toBe("go");
  });

  it("gives an Omnibridge copy its own double-wrap warning instead", () => {
    expect(isFirstBridge({ ...KNOWN, address: UNKNOWN as `0x${string}` }, [KNOWN], true)).toBe(false);
    expect(verdictOf({ ...ready, omnibridge: true, firstBridge: true }).label).toMatch(/Omnibridge · wraps twice/);
  });
});

describe("pasting an unknown address in the picker", () => {
  it("reads it on-chain and offers it as a row to pick", async () => {
    const resolveCustom = vi.fn(async () => ({ address: UNKNOWN as `0x${string}`, symbol: "FROG", decimals: 18, side: "first" as const, counterpart: null }));
    const onPick = vi.fn();
    renderWithWallet(<TokenPicker tokens={[KNOWN]} selected={KNOWN} snapshots={[]} resolveCustom={resolveCustom} onPick={onPick} onClose={vi.fn()} />, { wallet: connectedWallet() });
    await userEvent.type(screen.getByRole("combobox", { name: "Search tokens" }), UNKNOWN);
    const row = await screen.findByRole("option", { name: /FROG/ });
    expect(resolveCustom).toHaveBeenCalledWith(UNKNOWN, "first");
    await userEvent.click(row);
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ symbol: "FROG" }));
  });

  it("says when the address is not a token", async () => {
    renderWithWallet(<TokenPicker tokens={[KNOWN]} selected={KNOWN} snapshots={[]} resolveCustom={async () => null} onPick={vi.fn()} onClose={vi.fn()} />, { wallet: connectedWallet() });
    await userEvent.type(screen.getByRole("combobox", { name: "Search tokens" }), UNKNOWN);
    await waitFor(() => expect(screen.getByText("Not a token")).toBeInTheDocument());
  });
});
