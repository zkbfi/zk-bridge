import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { createWalletConfig, WagmiWalletProvider } from "../../src/wallet/wagmi-wallet";
import { useWallet, type WalletPort } from "../../src/wallet/wallet-port";

const wagmi = vi.hoisted(() => ({
  connection: {} as Record<string, unknown>,
  connectors: [] as unknown[],
  connectAsync: vi.fn(),
  disconnect: vi.fn(),
  switchChainAsync: vi.fn(),
  sendTransactionAsync: vi.fn(),
}));

// The real provider stays. Only the hooks that read and drive a browser wallet become controllable, because jsdom has no wallet.
vi.mock("wagmi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("wagmi")>()),
  useConnection: () => wagmi.connection,
  useConnectors: () => wagmi.connectors,
  useConnect: () => ({ connectAsync: wagmi.connectAsync }),
  useDisconnect: () => ({ disconnect: wagmi.disconnect }),
  useSwitchChain: () => ({ switchChainAsync: wagmi.switchChainAsync }),
  useSendTransaction: () => ({ sendTransactionAsync: wagmi.sendTransactionAsync }),
}));

const RPC_URLS = { 1: "https://eth.example.org", 369: "https://pls.example.org" } as const;
const HASH = `0x${"ab".repeat(32)}` as const;
const ACCOUNT = `0x${"12".repeat(20)}` as const;
const CONNECTOR = { id: "injected", name: "Browser Wallet" };

const captured: { port: WalletPort | null } = { port: null };
const Capture = (): ReactNode => {
  captured.port = useWallet();
  return null;
};
const mount = async (): Promise<WalletPort> => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <WagmiWalletProvider pair={FIXTURE_PAIR} rpcUrls={RPC_URLS}>
        <Capture />
      </WagmiWalletProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(captured.port).not.toBeNull());
  return captured.port!;
};

const connected = (chainId: number) => ({ status: "connected", address: ACCOUNT, chainId, connector: CONNECTOR });

beforeEach(() => {
  captured.port = null;
  wagmi.connection = { status: "disconnected", address: undefined, chainId: undefined, connector: undefined };
  wagmi.connectors = [CONNECTOR];
  wagmi.connectAsync.mockReset().mockResolvedValue(undefined);
  wagmi.disconnect.mockReset();
  wagmi.switchChainAsync.mockReset().mockResolvedValue(undefined);
  wagmi.sendTransactionAsync.mockReset().mockResolvedValue(HASH);
});

describe("createWalletConfig: the endpoints", () => {
  it("falls back to the valve.city demo RPC for a chain that has no endpoint in the page configuration", () => {
    const config = createWalletConfig(FIXTURE_PAIR, { 369: "https://pls.example.org" });
    expect(config.chains.map((chain) => chain.rpcUrls.default.http)[0]).toEqual([`https://one.valve.city/rpc/vk_demo/evm/${FIXTURE_PAIR.first.chainId}`]);
    expect(config.chains.map((chain) => chain.rpcUrls.default.http)[1]).toEqual(["https://pls.example.org"]);
  });
});

describe("the wallet port over wagmi: the state", () => {
  it("reports a wallet that is not connected, with no account, no chain and no name", async () => {
    const port = await mount();
    expect(port).toMatchObject({ status: "disconnected", account: null, chainId: null, walletName: null, walletAvailable: true, kind: "real" });
  });

  it.each(["connecting", "reconnecting"])("reports %s as connecting, and gives no chain and no name until the connection is complete", async (status) => {
    wagmi.connection = { status, address: ACCOUNT, chainId: 1, connector: CONNECTOR };
    const port = await mount();
    expect(port).toMatchObject({ status: "connecting", account: ACCOUNT, chainId: null, walletName: null });
  });

  it("reports the account, the chain and the name of a connected wallet", async () => {
    wagmi.connection = connected(369);
    const port = await mount();
    expect(port).toMatchObject({ status: "connected", account: ACCOUNT, chainId: 369, walletName: "Browser Wallet" });
  });

  it("reports that no wallet was found when the browser offers no connector", async () => {
    wagmi.connectors = [];
    const port = await mount();
    expect(port.walletAvailable).toBe(false);
  });
});

describe("the wallet port over wagmi: the actions", () => {
  it("connects through the first connector", async () => {
    const port = await mount();
    await port.connect();
    expect(wagmi.connectAsync).toHaveBeenCalledWith({ connector: CONNECTOR });
  });

  it("explains that no wallet exists, and does not try to connect, when the browser offers no connector", async () => {
    wagmi.connectors = [];
    const port = await mount();
    await expect(port.connect()).rejects.toThrow("No wallet was found in this browser. Install a wallet extension, then reload the page.");
    expect(wagmi.connectAsync).not.toHaveBeenCalled();
  });

  it("disconnects and switches chain on request", async () => {
    const port = await mount();
    port.disconnect();
    expect(wagmi.disconnect).toHaveBeenCalledTimes(1);
    await port.switchChain(369);
    expect(wagmi.switchChainAsync).toHaveBeenCalledWith({ chainId: 369 });
  });

  it("switches the wallet to the chain of the transaction first, then sends every field of it", async () => {
    wagmi.connection = connected(1);
    const port = await mount();
    const calls: string[] = [];
    wagmi.switchChainAsync.mockImplementation(async () => void calls.push("switch"));
    wagmi.sendTransactionAsync.mockImplementation(async () => {
      calls.push("send");
      return HASH;
    });
    const to = `0x${"34".repeat(20)}` as const;
    const hash = await port.sendTransaction({ chainId: 369, to, data: "0xdeadbeef", value: 7n, gas: 120_000n });
    expect(hash).toBe(HASH);
    expect(calls).toEqual(["switch", "send"]);
    expect(wagmi.switchChainAsync).toHaveBeenCalledWith({ chainId: 369 });
    expect(wagmi.sendTransactionAsync).toHaveBeenCalledWith({ chainId: 369, to, data: "0xdeadbeef", value: 7n, gas: 120_000n });
  });

  it("does not switch when the wallet is on the chain of the transaction", async () => {
    wagmi.connection = connected(369);
    const port = await mount();
    const to = `0x${"34".repeat(20)}` as const;
    await port.sendTransaction({ chainId: 369, to, data: "0x", value: 0n, gas: 21_000n });
    expect(wagmi.switchChainAsync).not.toHaveBeenCalled();
    expect(wagmi.sendTransactionAsync).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when the wallet refuses the chain switch", async () => {
    wagmi.connection = connected(1);
    const port = await mount();
    wagmi.switchChainAsync.mockRejectedValue(new Error("User rejected the request."));
    const to = `0x${"34".repeat(20)}` as const;
    await expect(port.sendTransaction({ chainId: 369, to, data: "0x", value: 0n, gas: 21_000n })).rejects.toThrow("User rejected the request.");
    expect(wagmi.sendTransactionAsync).not.toHaveBeenCalled();
  });
});

describe("useWallet", () => {
  it("fails with a clear message when no provider sits above the component", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Capture />)).toThrow("useWallet needs a WalletContext provider above it.");
    quiet.mockRestore();
    expect(screen.queryByText(/./)).toBeNull();
  });
});
