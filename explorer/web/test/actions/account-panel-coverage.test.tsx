import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FIXTURE_ACCOUNT, FIXTURE_PAIR } from "@terminal/data/fixtures";
import { AccountPanel } from "../../src/actions/AccountPanel";
import { buildFixtureContext } from "../helpers";
import { connectedWallet, disconnectedWallet, renderWithWallet } from "../app/support";

const panel = (wallet = connectedWallet(), snapshots: Parameters<typeof AccountPanel>[0]["snapshots"] = undefined, snapshotError: string | null = null) =>
  renderWithWallet(<AccountPanel pair={FIXTURE_PAIR} snapshots={snapshots} snapshotError={snapshotError} />, { wallet });

describe("the account panel of a connected wallet", () => {
  it("shows no simulated notice for a real wallet, and names the wallet and the chain", () => {
    panel();
    expect(screen.queryByText(/Simulated wallet/)).toBeNull();
    expect(screen.getByText("Test wallet is connected")).toBeInTheDocument();
    expect(screen.getByText(FIXTURE_ACCOUNT)).toBeInTheDocument();
    expect(screen.getByText("The wallet is on Ethereum.")).toBeInTheDocument();
  });

  it("calls the wallet Wallet when it reports no name", () => {
    panel(connectedWallet({ walletName: null }));
    expect(screen.getByText("Wallet is connected")).toBeInTheDocument();
  });

  it("says that the chain of the wallet is not in the pair, and offers both chains", () => {
    panel(connectedWallet({ chainId: 56 }));
    expect(screen.getByText("The wallet is on chain 56, which is not in this pair.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch to Ethereum" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Switch to PulseChain" })).toBeEnabled();
  });

  it("disables the switch to the chain that the wallet is on, and switches to the other one", async () => {
    const switchChain = vi.fn().mockResolvedValue(undefined);
    panel(connectedWallet({ switchChain }));
    expect(screen.getByRole("button", { name: "Switch to Ethereum" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Switch to PulseChain" }));
    expect(switchChain).toHaveBeenCalledWith(FIXTURE_PAIR.second.chainId);
    expect(switchChain).toHaveBeenCalledTimes(1);
  });

  it("disconnects the wallet", async () => {
    const disconnect = vi.fn();
    panel(connectedWallet({ disconnect }));
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("shows the simulated notice for a simulated wallet", () => {
    panel(connectedWallet({ kind: "simulated" }));
    expect(screen.getByText("Simulated wallet. Nothing reaches a chain.")).toBeInTheDocument();
  });
});

describe("the balances in the account panel", () => {
  it("shows the failure of the balance read", () => {
    panel(connectedWallet(), undefined, "the endpoint timed out");
    expect(screen.getByText("Balances did not load: the endpoint timed out")).toBeInTheDocument();
  });

  it("shows the failure of one chain and the balances of the other", async () => {
    const { context } = await buildFixtureContext();
    const ok = (context.snapshots ?? []).find((result) => result.status === "ok" && result.snapshot.chain.side === "second")!;
    panel(connectedWallet(), [{ status: "error", chain: FIXTURE_PAIR.first, message: "no endpoint for Ethereum" }, ok]);
    expect(screen.getByText("Ethereum: no endpoint for Ethereum")).toBeInTheDocument();
    expect(screen.queryByTestId("balances-1")).toBeNull();
    expect(within(screen.getByTestId("balances-369")).getByText("PLS")).toBeInTheDocument();
  });

  it("shows no balances while the wallet is not connected, even when snapshots exist", async () => {
    const { context } = await buildFixtureContext();
    panel(disconnectedWallet(), context.snapshots ?? undefined, "ignored");
    expect(screen.queryByTestId("balances-1")).toBeNull();
    expect(screen.queryByText(/Balances did not load/)).toBeNull();
  });
});

describe("the account panel of a wallet that is not connected", () => {
  it("connects the wallet on the button", async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    panel(disconnectedWallet({ connect }));
    const button = screen.getByRole("button", { name: "Connect wallet" });
    expect(button).toBeEnabled();
    expect(screen.queryByText("No wallet was found in this browser.")).toBeNull();
    await userEvent.click(button);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("disables the button while the wallet connects", () => {
    panel(disconnectedWallet({ status: "connecting" }));
    expect(screen.getByRole("button", { name: "Connecting…" })).toBeDisabled();
  });

  it("keeps the button on when the browser has no wallet, and says that Connect lists where to get one", async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    panel(disconnectedWallet({ walletAvailable: false, connect }));
    const button = screen.getByRole("button", { name: "Connect wallet" });
    expect(button).toBeEnabled();
    expect(screen.getByText("No wallet was found in this browser. Connect lists where to get one.")).toBeInTheDocument();
    await userEvent.click(button);
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
