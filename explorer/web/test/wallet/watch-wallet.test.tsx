import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useWallet } from "../../src/wallet/wallet-port";
import { watchAddressOf, WatchWalletProvider } from "../../src/wallet/watch-wallet";

const DEPLOYER = "0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc";

describe("the dev-only ?watch= address", () => {
  it("is read only in a development build, and only as a valid address", () => {
    expect(watchAddressOf(`?watch=${DEPLOYER}`, true)).toBe(DEPLOYER);
    expect(watchAddressOf(`?watch=${DEPLOYER.toLowerCase()}`, true)).toBe(DEPLOYER);
    expect(watchAddressOf(`?watch=${DEPLOYER}`, false)).toBeNull();
    expect(watchAddressOf("?watch=0x123", true)).toBeNull();
    expect(watchAddressOf("", true)).toBeNull();
  });

  it("looks connected as that address and refuses to send", async () => {
    let port: ReturnType<typeof useWallet> | null = null;
    const Probe = () => {
      port = useWallet();
      return <span>{port.account}</span>;
    };
    render(
      <WatchWalletProvider account={DEPLOYER} chainId={11155111}>
        <Probe />
      </WatchWalletProvider>,
    );
    expect(screen.getByText(DEPLOYER)).toBeInTheDocument();
    expect(port!.status).toBe("connected");
    await expect(port!.sendTransaction({ chainId: 11155111, to: DEPLOYER, data: "0x", value: 0n, gas: 21000n })).rejects.toThrow(/watching/i);
    await expect(port!.watchAsset({ chainId: 11155111, address: DEPLOYER, symbol: "tFAU", decimals: 18 })).rejects.toThrow(/watching/i);
  });
});
