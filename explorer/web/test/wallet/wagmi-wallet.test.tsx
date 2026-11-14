import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { createWalletConfig, WagmiWalletProvider } from "../../src/wallet/wagmi-wallet";
import { useWallet } from "../../src/wallet/wallet-port";

const RPC_URLS = { 1: "https://eth.example.org", 369: "https://pls.example.org" } as const;

describe("createWalletConfig", () => {
  it("has one chain per side of the pair, with the public endpoints of the page", () => {
    const config = createWalletConfig(FIXTURE_PAIR, RPC_URLS);
    expect(config.chains.map((chain) => chain.id)).toEqual([1, 369]);
    expect(config.chains.map((chain) => chain.nativeCurrency.symbol)).toEqual(["ETH", "PLS"]);
  });

  it("registers the generic injected connector only when the page has window.ethereum, and never WalletConnect", () => {
    expect(createWalletConfig(FIXTURE_PAIR, RPC_URLS).connectors.map((connector) => connector.type)).toEqual([]);
    (window as { ethereum?: unknown }).ethereum = {};
    try {
      expect(createWalletConfig(FIXTURE_PAIR, RPC_URLS).connectors.map((connector) => connector.type)).toEqual(["injected"]);
    } finally {
      delete (window as { ethereum?: unknown }).ethereum;
    }
  });
});

describe("WagmiWalletProvider", () => {
  const Probe = () => {
    const wallet = useWallet();
    return (
      <p data-testid="probe">
        {wallet.kind} {wallet.status} {wallet.account ?? "no account"}
      </p>
    );
  };

  it("settles as disconnected and real, and holds no account until the viewer connects", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WagmiWalletProvider pair={FIXTURE_PAIR} rpcUrls={RPC_URLS}>
          <Probe />
        </WagmiWalletProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("real disconnected no account"));
  });
});
