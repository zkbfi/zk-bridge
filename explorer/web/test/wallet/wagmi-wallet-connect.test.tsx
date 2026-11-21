import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { connectErrorText, pickableWallets, WagmiWalletProvider } from "../../src/wallet/wagmi-wallet";
import { useWallet, type WalletPort } from "../../src/wallet/wallet-port";

const wagmi = vi.hoisted(() => ({
  connection: {} as Record<string, unknown>,
  connectors: [] as unknown[],
  connectAsync: vi.fn(),
  disconnect: vi.fn(),
  switchChainAsync: vi.fn(),
  sendTransactionAsync: vi.fn(),
  providerConfig: null as unknown,
}));
const appkit = vi.hoisted(() => ({ loadAppKit: vi.fn(), open: vi.fn(), dispose: vi.fn(), config: { marker: "appkit-config" } }));

vi.mock("wagmi", async (importOriginal) => {
  const original = await importOriginal<typeof import("wagmi")>();
  return {
    ...original,
    WagmiProvider: ({ config, children }: { config: unknown; children: ReactNode }) => {
      wagmi.providerConfig = config;
      // The stand-in AppKit configuration is not a real wagmi configuration: the hooks are mocked, so the children need no provider.
      return config === appkit.config ? <>{children}</> : <original.WagmiProvider config={config as never}>{children}</original.WagmiProvider>;
    },
    useConnection: () => wagmi.connection,
    useConnectors: () => wagmi.connectors,
    useConnect: () => ({ connectAsync: wagmi.connectAsync }),
    useDisconnect: () => ({ disconnect: wagmi.disconnect }),
    useSwitchChain: () => ({ switchChainAsync: wagmi.switchChainAsync }),
    useSendTransaction: () => ({ sendTransactionAsync: wagmi.sendTransactionAsync }),
    useWatchAsset: () => ({ watchAssetAsync: async () => true }),
  };
});
vi.mock("../../src/wallet/appkit", () => ({ loadAppKit: appkit.loadAppKit }));

const RPC_URLS = { 1: "https://eth.example.org", 369: "https://pls.example.org" } as const;
const PROJECT_ID = "0123456789abcdef0123456789abcdef";
const metamask = { uid: "u1", id: "io.metamask", name: "MetaMask", icon: "data:image/svg+xml,metamask" };
const rabby = { uid: "u2", id: "io.rabby", name: "Rabby Wallet" };
const generic = { uid: "u3", id: "injected", name: "Injected" };

const captured: { port: WalletPort | null } = { port: null };
const Capture = (): ReactNode => {
  captured.port = useWallet();
  return null;
};
const mount = async (projectId: string | null): Promise<WalletPort> => {
  render(
    <ChakraProvider value={defaultSystem}>
      <QueryClientProvider client={new QueryClient()}>
        <WagmiWalletProvider pair={FIXTURE_PAIR} rpcUrls={RPC_URLS} walletConnectProjectId={projectId}>
          <Capture />
        </WagmiWalletProvider>
      </QueryClientProvider>
    </ChakraProvider>,
  );
  await waitFor(() => expect(captured.port).not.toBeNull());
  return captured.port!;
};
const connectNow = async (): Promise<void> => {
  await act(async () => {
    await captured.port!.connect();
  });
};

beforeEach(() => {
  captured.port = null;
  wagmi.connection = { status: "disconnected", address: undefined, chainId: undefined, connector: undefined };
  wagmi.connectors = [];
  wagmi.connectAsync.mockReset().mockResolvedValue(undefined);
  appkit.open.mockReset();
  appkit.dispose.mockReset();
  appkit.loadAppKit.mockReset().mockResolvedValue({ config: appkit.config, open: appkit.open, dispose: appkit.dispose });
  window.localStorage.clear();
});
afterEach(() => window.localStorage.clear());

describe("the connect text", () => {
  it("says that a wallet is not in the browser, that the viewer declined, and otherwise the first line of the message", () => {
    expect(connectErrorText({ name: "ProviderNotFoundError" })).toBe("That wallet is not available in this browser. Install it, then reload this page.");
    expect(connectErrorText({ name: "UserRejectedRequestError" })).toBe("The wallet request was declined. Connect again to retry.");
    expect(connectErrorText({ code: 4001 })).toBe("The wallet request was declined. Connect again to retry.");
    expect(connectErrorText({ shortMessage: "Short.", message: "Long.\nMore." })).toBe("The wallet did not connect: Short.");
    expect(connectErrorText(new Error("First\nSecond"))).toBe("The wallet did not connect: First");
    expect(connectErrorText("plain")).toBe("The wallet did not connect: plain");
    expect(connectErrorText(null)).toBe("The wallet did not connect: null");
  });

  it("offers the announced wallets, and the generic injected one only when none announced itself", () => {
    expect(pickableWallets([generic, metamask] as never)).toEqual([metamask]);
    expect(pickableWallets([generic] as never)).toEqual([generic]);
    expect(pickableWallets([])).toEqual([]);
  });
});

describe("without a project id: the wallets in the browser", () => {
  it("connects at once with exactly one wallet", async () => {
    wagmi.connectors = [metamask];
    await mount(null);
    await connectNow();
    expect(wagmi.connectAsync).toHaveBeenCalledWith({ connector: metamask });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(appkit.loadAppKit).not.toHaveBeenCalled();
  });

  it("treats the generic injected connector as the one wallet when nothing announced itself", async () => {
    wagmi.connectors = [generic];
    await mount(null);
    await connectNow();
    expect(wagmi.connectAsync).toHaveBeenCalledWith({ connector: generic });
  });

  it("lists several wallets and connects the one that is picked", async () => {
    wagmi.connectors = [generic, metamask, rabby];
    const port = await mount(null);
    expect(port.walletAvailable).toBe(true);
    await connectNow();
    const dialog = screen.getByRole("dialog", { name: "Connect a wallet" });
    expect(wagmi.connectAsync).not.toHaveBeenCalled();
    const list = within(dialog).getByRole("list", { name: "Wallets in this browser" });
    expect(within(list).getAllByRole("button").map((button) => button.textContent)).toEqual(["MetaMask", "Rabby Wallet"]);
    await userEvent.click(within(list).getByRole("button", { name: "Rabby Wallet" }));
    expect(wagmi.connectAsync).toHaveBeenCalledWith({ connector: rabby });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows the message of a failed pick in the list and keeps the list open to try again", async () => {
    wagmi.connectors = [metamask, rabby];
    wagmi.connectAsync.mockRejectedValueOnce({ name: "UserRejectedRequestError" });
    await mount(null);
    await connectNow();
    await userEvent.click(screen.getByRole("button", { name: "MetaMask" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The wallet request was declined. Connect again to retry.");
    await userEvent.click(screen.getByRole("button", { name: "MetaMask" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("opens the list with the message when the only wallet fails, and never throws", async () => {
    wagmi.connectors = [metamask];
    wagmi.connectAsync.mockRejectedValueOnce(Object.assign(new Error("Provider not found."), { name: "ProviderNotFoundError" }));
    await mount(null);
    await expect(captured.port!.connect()).resolves.toBeUndefined();
    expect(await screen.findByRole("alert")).toHaveTextContent("That wallet is not available in this browser. Install it, then reload this page.");
  });

  it("lists where to install a wallet when there is none, with one line of what happens", async () => {
    const port = await mount(null);
    expect(port.walletAvailable).toBe(false);
    await connectNow();
    const dialog = screen.getByRole("dialog", { name: "Connect a wallet" });
    expect(within(dialog).getByText("Install a wallet, then reload this page to connect.")).toBeInTheDocument();
    const links = within(dialog).getAllByRole("link");
    expect(links.map((link) => [link.textContent?.replace("↗", ""), link.getAttribute("href")])).toEqual([
      ["MetaMask", "https://metamask.io/download/"],
      ["Rabby", "https://rabby.io/"],
      ["Coinbase Wallet", "https://www.coinbase.com/wallet/downloads"],
      ["Rainbow", "https://rainbow.me/download"],
    ]);
    expect(wagmi.connectAsync).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows no list for a wallet that is connected already", async () => {
    wagmi.connection = { status: "connected", address: `0x${"12".repeat(20)}`, chainId: 1, connector: metamask };
    await mount(null);
    await connectNow();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("with a project id: Reown AppKit", () => {
  it("does not load AppKit until the first Connect, then opens its modal with the chains of the pair and the page's transports", async () => {
    const port = await mount(PROJECT_ID);
    expect(port.walletAvailable).toBe(true);
    expect(appkit.loadAppKit).not.toHaveBeenCalled();
    await connectNow();
    expect(appkit.loadAppKit).toHaveBeenCalledTimes(1);
    const options = appkit.loadAppKit.mock.calls[0]![0] as { projectId: string; chains: { id: number }[]; transports: Record<number, unknown> };
    expect(options.projectId).toBe(PROJECT_ID);
    expect(options.chains.map((chain) => chain.id)).toEqual([1, 369]);
    expect(Object.keys(options.transports)).toEqual(["1", "369"]);
    expect(appkit.open).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(wagmi.providerConfig).toBe(appkit.config));
  });

  it("loads AppKit once and opens the same modal again on the next Connect", async () => {
    await mount(PROJECT_ID);
    await connectNow();
    await connectNow();
    expect(appkit.loadAppKit).toHaveBeenCalledTimes(1);
    expect(appkit.open).toHaveBeenCalledTimes(2);
  });

  it("loads AppKit at page load when the viewer connected here before, so the session returns", async () => {
    window.localStorage.setItem("wagmi.recentConnectorId", '"walletConnect"');
    await mount(PROJECT_ID);
    await waitFor(() => expect(appkit.loadAppKit).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(wagmi.providerConfig).toBe(appkit.config));
    expect(appkit.open).not.toHaveBeenCalled();
  });

  it("does not load AppKit at page load without a stored connection, or without a project id", async () => {
    await mount(PROJECT_ID);
    expect(appkit.loadAppKit).not.toHaveBeenCalled();
    window.localStorage.setItem("wagmi.recentConnectorId", '"injected"');
    render(
      <ChakraProvider value={defaultSystem}>
        <QueryClientProvider client={new QueryClient()}>
          <WagmiWalletProvider pair={FIXTURE_PAIR} rpcUrls={RPC_URLS}>
            <span>no id</span>
          </WagmiWalletProvider>
        </QueryClientProvider>
      </ChakraProvider>,
    );
    expect(appkit.loadAppKit).not.toHaveBeenCalled();
  });

  it("tolerates storage that cannot be read", async () => {
    // Replace the whole object: window.localStorage is jsdom's Storage under some Node versions and Node's own
    // (Node 25 and later) under others, and a spy on a method of either may never be reached. The call count below
    // proves the throwing read ran.
    const getItem = vi.fn(() => {
      throw new Error("blocked");
    });
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", { configurable: true, get: () => ({ getItem }) });
    try {
      await mount(PROJECT_ID);
      expect(getItem).toHaveBeenCalledWith("wagmi.recentConnectorId");
      expect(appkit.loadAppKit).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) Reflect.deleteProperty(window, "localStorage");
      else Object.defineProperty(window, "localStorage", original);
    }
  });

  it("falls back to the page's own list, with the reason, when AppKit cannot load, and tries again on the next Connect", async () => {
    wagmi.connectors = [metamask, rabby];
    appkit.loadAppKit.mockRejectedValueOnce(new Error("Failed to fetch dynamically imported module"));
    await mount(PROJECT_ID);
    await expect(captured.port!.connect()).resolves.toBeUndefined();
    expect(await screen.findByRole("alert")).toHaveTextContent("The wallet list could not load. The wallet did not connect: Failed to fetch dynamically imported module");
    expect(screen.getByRole("button", { name: "MetaMask" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await connectNow();
    expect(appkit.loadAppKit).toHaveBeenCalledTimes(2);
    expect(appkit.open).toHaveBeenCalledTimes(1);
  });

  it("swallows a failed background load at page load", async () => {
    window.localStorage.setItem("wagmi.recentConnectorId", '"walletConnect"');
    appkit.loadAppKit.mockRejectedValueOnce(new Error("offline"));
    await mount(PROJECT_ID);
    await waitFor(() => expect(appkit.loadAppKit).toHaveBeenCalledTimes(1));
    expect(wagmi.providerConfig).not.toBe(appkit.config);
  });

  it("stops following the page's theme when the provider unmounts", async () => {
    const view = render(
      <ChakraProvider value={defaultSystem}>
        <QueryClientProvider client={new QueryClient()}>
          <WagmiWalletProvider pair={FIXTURE_PAIR} rpcUrls={RPC_URLS} walletConnectProjectId={PROJECT_ID}>
            <Capture />
          </WagmiWalletProvider>
        </QueryClientProvider>
      </ChakraProvider>,
    );
    await act(async () => {
      await captured.port!.connect();
    });
    await waitFor(() => expect(wagmi.providerConfig).toBe(appkit.config));
    expect(appkit.dispose).not.toHaveBeenCalled();
    view.unmount();
    expect(appkit.dispose).toHaveBeenCalledTimes(1);
  });
});
