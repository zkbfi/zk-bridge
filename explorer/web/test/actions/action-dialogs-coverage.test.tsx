import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ActionDialog } from "../../src/actions/ActionDialogs";
import { buildTestServices } from "../render";
import { connectedWallet, disconnectedWallet, renderWithWallet } from "../app/support";

describe("the action dialog without a wallet", () => {
  it("connects the wallet on the button", async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    renderWithWallet(<ActionDialog dialog="bridge" onClose={() => undefined} />, { wallet: disconnectedWallet({ connect }) });
    const dialog = await screen.findByRole("dialog", { name: "Bridge tokens" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect wallet" }));
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("disables the button when the browser has no wallet", async () => {
    renderWithWallet(<ActionDialog dialog="bridge" onClose={() => undefined} />, { wallet: disconnectedWallet({ walletAvailable: false }) });
    expect(await screen.findByRole("button", { name: "Connect wallet" })).toBeDisabled();
  });
});

describe("the action dialog with a wallet", () => {
  it("shows a loading line until the tokens arrive", async () => {
    const base = buildTestServices();
    renderWithWallet(<ActionDialog dialog="bridge" onClose={() => undefined} />, {
      wallet: connectedWallet(),
      services: { dataSource: { ...base.dataSource, listTokens: () => new Promise(() => undefined) } },
    });
    expect(await screen.findByText("Loading your balances and the fee rates…")).toBeInTheDocument();
    expect(screen.queryByRole("form")).toBeNull();
  });

  it("shows the bridge form of tokens for the bridge dialog", async () => {
    renderWithWallet(<ActionDialog dialog="bridge" onClose={() => undefined} />, { wallet: connectedWallet() });
    const form = await screen.findByRole("form", { name: "Bridge tokens" });
    expect(within(form).getByLabelText("Token")).toBeInTheDocument();
  });

  it("shows the bridge form of the native coin for the wrap dialog", async () => {
    renderWithWallet(<ActionDialog dialog="wrap" onClose={() => undefined} />, { wallet: connectedWallet() });
    const form = await screen.findByRole("form", { name: "Wrap the native coin" });
    expect(within(form).getByLabelText("Coin to wrap")).toBeInTheDocument();
  });

  it("shows the message form for the message dialog", async () => {
    renderWithWallet(<ActionDialog dialog="message" onClose={() => undefined} />, { wallet: connectedWallet() });
    expect(await screen.findByRole("form", { name: "Send a message" })).toBeInTheDocument();
  });

  it("shows the claim list for the claim dialog", async () => {
    renderWithWallet(<ActionDialog dialog="claim" onClose={() => undefined} />, { wallet: connectedWallet() });
    expect(await screen.findByRole("button", { name: "Claim USDC" })).toBeInTheDocument();
  });
});
