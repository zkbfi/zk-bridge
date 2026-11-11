import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { createWalletConfig } from "../../src/wallet/wagmi-wallet";
import { useWallet } from "../../src/wallet/wallet-port";
import { WatchWalletProvider } from "../../src/wallet/watch-wallet";

const DEPLOYER = "0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc";

describe("createWalletConfig: a chain with no endpoint and no public default", () => {
  it("uses the local node for that chain, and the configured endpoint for the other", () => {
    const local = { ...FIXTURE_PAIR, first: { ...FIXTURE_PAIR.first, chainId: 31337, name: "Local" } };
    const config = createWalletConfig(local, { [FIXTURE_PAIR.second.chainId]: "https://pls.example.org" });
    expect(config.chains.map((chain) => chain.id)).toEqual([31337, FIXTURE_PAIR.second.chainId]);
    expect(config.chains[0]!.rpcUrls.default.http).toEqual(["http://127.0.0.1:8545"]);
    expect(config.chains[1]!.rpcUrls.default.http).toEqual(["https://pls.example.org"]);
  });
});

describe("the watching wallet", () => {
  it("connects, disconnects and switches chains without doing anything, and without a failure", async () => {
    let port: ReturnType<typeof useWallet> | null = null;
    const Probe = () => {
      port = useWallet();
      return <span>{port.walletName}</span>;
    };
    render(
      <WatchWalletProvider account={DEPLOYER} chainId={1}>
        <Probe />
      </WatchWalletProvider>,
    );
    expect(screen.getByText("Watching (development)")).toBeInTheDocument();
    await expect(port!.connect()).resolves.toBeUndefined();
    expect(port!.disconnect()).toBeUndefined();
    await expect(port!.switchChain(369)).resolves.toBeUndefined();
    expect(port!.status).toBe("connected");
    expect(port!.chainId).toBe(1);
  });
});
