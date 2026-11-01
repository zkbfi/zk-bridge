import { describe, expect, it } from "vitest";
import { CHAIN_METADATA, chainNameOf, explorerLinks, nativeSymbolOfChain } from "../src/chain-metadata.js";

describe("chain metadata", () => {
  const hash = `0x${"ab".repeat(32)}`;
  const urls = (chainId: number, kind: "tx" | "block" | "address", id: string) => explorerLinks(chainId, kind, id).map((link) => link.url);

  it("names the native coin of each chain, undefined for an unknown chain", () => {
    expect([1, 11155111, 369, 943].map(nativeSymbolOfChain)).toEqual(["ETH", "SepETH", "PLS", "v4tPLS"]);
    expect(nativeSymbolOfChain(5)).toBeUndefined();
  });

  it("names each chain for the pages", () => {
    expect([1, 11155111, 369, 943].map(chainNameOf)).toEqual(["Ethereum", "Sepolia", "PulseChain", "PulseChain testnet v4"]);
    expect(chainNameOf(5)).toBeUndefined();
  });

  it("builds path URLs for Etherscan and hash router URLs for PulseChain scans, one per explorer", () => {
    expect(urls(11155111, "tx", hash)).toEqual([`https://sepolia.etherscan.io/tx/${hash}`]);
    expect(urls(943, "block", "7")).toEqual(["https://scan.v4.testnet.pulsechain.com/#/block/7", "https://otter-testnet-pulsechain.g4mm4.io/block/7"]);
    expect(explorerLinks(5, "tx", hash)).toEqual([]);
    expect(Object.keys(CHAIN_METADATA).map(Number).sort((a, b) => a - b)).toEqual([1, 369, 943, 11155111]);
  });
});
