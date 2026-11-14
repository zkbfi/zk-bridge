import { describe, expect, it } from "vitest";
import { defaultRpcUrl } from "@terminal/config/default-rpc";
import { registryLayer } from "@terminal/data/connection-runtime";

type SharedPair = Parameters<typeof registryLayer>[0];

describe("the default RPC", () => {
  it("is rpc.zkb.fi for Ethereum, PulseChain and both testnets, with a public RPC behind it", () => {
    expect(defaultRpcUrl(1)).toBe("https://rpc.zkb.fi/1");
    expect(defaultRpcUrl(369)).toBe("https://rpc.zkb.fi/369");
    expect(defaultRpcUrl(11155111)).toBe("https://rpc.zkb.fi/11155111");
    expect(defaultRpcUrl(943)).toBe("https://rpc.zkb.fi/943");
    expect(defaultRpcUrl(8453)).toBeNull();
  });

  it("sits under everything else: the deployment's own RPC wins, and only a chain without one falls back", () => {
    const pair = { sides: [{ chainId: 1, rpcUrl: "" }, { chainId: 369, rpcUrl: "https://registry.example.org/pls" }] } as unknown as SharedPair;
    expect(registryLayer(pair, defaultRpcUrl).rpcUrls).toEqual({ 1: "https://rpc.zkb.fi/1", 369: "https://registry.example.org/pls" });
    expect(registryLayer(pair).rpcUrls).toEqual({ 1: null, 369: "https://registry.example.org/pls" });
  });
});
