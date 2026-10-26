import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { FIXTURE_ACCOUNT } from "@terminal/data/fixtures";
import { FIXTURE_TRANSACTION_HASH } from "@terminal/chain/chain-access";
import { FixtureWalletProvider } from "../../src/wallet/fixture-wallet";
import { useWallet, type WalletPort } from "../../src/wallet/wallet-port";

const captured: { port: WalletPort | null } = { port: null };
const Capture = (): ReactNode => {
  captured.port = useWallet();
  return null;
};
const current = (): WalletPort => captured.port!;

describe("FixtureWalletProvider", () => {
  it("starts disconnected, says that it is simulated, and reports no account and no chain", () => {
    render(<FixtureWalletProvider initialChainId={1}><Capture /></FixtureWalletProvider>);
    expect(current()).toMatchObject({ status: "disconnected", account: null, chainId: null, walletName: null, walletAvailable: true, kind: "simulated" });
  });

  it("reports the fixture account on the starting chain when it starts connected", () => {
    render(<FixtureWalletProvider initialChainId={369} startConnected><Capture /></FixtureWalletProvider>);
    expect(current()).toMatchObject({ status: "connected", account: FIXTURE_ACCOUNT, chainId: 369, walletName: "Simulated wallet" });
  });

  it("reports the account that the caller names", () => {
    const account = `0x${"12".repeat(20)}` as const;
    render(<FixtureWalletProvider initialChainId={1} account={account} startConnected><Capture /></FixtureWalletProvider>);
    expect(current().account).toBe(account);
  });

  it("connects and disconnects on request", async () => {
    render(<FixtureWalletProvider initialChainId={1}><Capture /></FixtureWalletProvider>);
    await act(async () => current().connect());
    expect(current().status).toBe("connected");
    act(() => current().disconnect());
    expect(current().status).toBe("disconnected");
    expect(current().account).toBeNull();
  });

  it("switches chain on request", async () => {
    render(<FixtureWalletProvider initialChainId={1} startConnected><Capture /></FixtureWalletProvider>);
    await act(async () => current().switchChain(369));
    expect(current().chainId).toBe(369);
  });

  it("sends nothing: it moves to the chain of the transaction and answers with the fixture hash", async () => {
    const onSend = vi.fn();
    render(<FixtureWalletProvider initialChainId={1} startConnected onSend={onSend}><Capture /></FixtureWalletProvider>);
    let hash: string | undefined;
    await act(async () => {
      hash = await current().sendTransaction({ chainId: 369, to: `0x${"34".repeat(20)}`, data: "0x", value: 0n, gas: 21_000n });
    });
    expect(hash).toBe(FIXTURE_TRANSACTION_HASH);
    expect(onSend).toHaveBeenCalledWith(FIXTURE_TRANSACTION_HASH);
    expect(current().chainId).toBe(369);
  });

  it("sends without a callback", async () => {
    render(<FixtureWalletProvider initialChainId={1} startConnected><Capture /></FixtureWalletProvider>);
    let hash: string | undefined;
    await act(async () => {
      hash = await current().sendTransaction({ chainId: 1, to: `0x${"34".repeat(20)}`, data: "0x", value: 0n, gas: 21_000n });
    });
    expect(hash).toBe(FIXTURE_TRANSACTION_HASH);
  });
});
