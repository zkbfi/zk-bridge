import { describe, expect, it } from "vitest";
import { defaultRpcUrl } from "@terminal/config/default-rpc";
import { registryLayer } from "@terminal/data/connection-runtime";

type SharedPair = Parameters<typeof registryLayer>[0];

describe("the default RPC", () => {
  it("is a public RPC for Ethereum, PulseChain and both testnets, with the valve.city demo key behind it", () => {
    expect(defaultRpcUrl(1)).toBe("https://ethereum-rpc.publicnode.com");
    expect(defaultRpcUrl(369)).toBe("https://rpc.pulsechain.com");
    expect(defaultRpcUrl(11155111)).toBe("https://ethereum-sepolia-rpc.publicnode.com");
    expect(defaultRpcUrl(943)).toBe("https://rpc.v4.testnet.pulsechain.com");
    expect(defaultRpcUrl(8453)).toBeNull();
  });

  it("sits under everything else: the deployment's own RPC wins, and only a chain without one falls back", () => {
    const pair = { sides: [{ chainId: 1, rpcUrl: "" }, { chainId: 369, rpcUrl: "https://registry.example.org/pls" }] } as unknown as SharedPair;
    expect(registryLayer(pair, defaultRpcUrl).rpcUrls).toEqual({ 1: "https://ethereum-rpc.publicnode.com", 369: "https://registry.example.org/pls" });
    expect(registryLayer(pair).rpcUrls).toEqual({ 1: null, 369: "https://registry.example.org/pls" });
  });
});
