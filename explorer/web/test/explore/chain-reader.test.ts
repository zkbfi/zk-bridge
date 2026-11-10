import { renderHook } from "@testing-library/react";
import { custom, encodeAbiParameters, getAddress, type Hex } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { method: string; params: unknown }[] = [];
let answers: Record<string, unknown> = {};

vi.mock("../../src/app/rpc-transport", () => ({
  rpcTransport: () =>
    custom({
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        calls.push({ method, params });
        return answers[method];
      },
    }),
}));

let services: unknown;
vi.mock("../../src/app/services", () => ({ useServices: () => services }));

import { chainReaderFor, explorerLinksOf, explorerUrl, useChainReader } from "../../src/explore/chain-reader";

const ADDRESS = "0x00000000000000000000000000000000000000aa" as const;

beforeEach(() => {
  calls.length = 0;
  answers = {};
});

describe("chainReaderFor", () => {
  it("reads an account's balance, nonce and whether it holds code", async () => {
    answers = { eth_getBalance: "0x10", eth_getTransactionCount: "0x3", eth_getCode: "0x6001" };
    expect(await chainReaderFor("http://rpc").account(ADDRESS)).toEqual({ balance: 16n, nonce: 3, isContract: true });
  });

  it("calls an address without code an externally owned account", async () => {
    answers = { eth_getBalance: "0x0", eth_getTransactionCount: "0x0", eth_getCode: "0x" };
    expect((await chainReaderFor("http://rpc").account(ADDRESS)).isContract).toBe(false);
  });

  it("calls an address whose code is undefined an externally owned account", async () => {
    answers = { eth_getBalance: "0x0", eth_getTransactionCount: "0x0", eth_getCode: undefined };
    expect((await chainReaderFor("http://rpc").account(ADDRESS)).isContract).toBe(false);
  });

  it("reads a block by number", async () => {
    answers = { eth_getBlockByNumber: { number: "0x5", hash: "0x" + "11".repeat(32), transactions: [], timestamp: "0x1" } };
    const block = await chainReaderFor("http://rpc").block(5n);
    expect(block.number).toBe(5n);
    expect(calls[0]).toEqual({ method: "eth_getBlockByNumber", params: ["0x5", false] });
  });

  it("reads the verifier of a light client", async () => {
    answers = { eth_call: encodeAbiParameters([{ type: "address" }], [ADDRESS]) };
    expect(await chainReaderFor("http://rpc").verifier("0x00000000000000000000000000000000000000bb")).toBe(getAddress(ADDRESS));
  });

  it("reads a transaction together with its receipt", async () => {
    const hash = ("0x" + "ab".repeat(32)) as Hex;
    answers = {
      eth_getTransactionByHash: { hash, from: ADDRESS, to: ADDRESS, input: "0x", nonce: "0x1", value: "0x0", gas: "0x5208", type: "0x0", gasPrice: "0x1", blockNumber: "0x5", blockHash: "0x" + "11".repeat(32), transactionIndex: "0x0", v: "0x1b", r: "0x1", s: "0x1" },
      eth_getTransactionReceipt: { transactionHash: hash, status: "0x1", blockNumber: "0x5", blockHash: "0x" + "11".repeat(32), transactionIndex: "0x0", from: ADDRESS, to: ADDRESS, cumulativeGasUsed: "0x5208", gasUsed: "0x5208", effectiveGasPrice: "0x1", logs: [], logsBloom: "0x" + "00".repeat(256), type: "0x0", contractAddress: null },
    };
    const { tx, receipt } = await chainReaderFor("http://rpc").transaction(hash);
    expect(tx.hash).toBe(hash);
    expect(receipt.status).toBe("success");
  });
});

describe("useChainReader", () => {
  const base = { configuration: { dataMode: "live", rpcUrls: {} as Record<number, string> }, connection: null };

  it("gives no reader on the sample page", () => {
    services = { ...base, configuration: { ...base.configuration, dataMode: "fixture" } };
    expect(renderHook(() => useChainReader()).result.current(1)).toBeNull();
  });

  it("gives a reader for a chain with a default RPC", () => {
    services = base;
    expect(renderHook(() => useChainReader()).result.current(1)).not.toBeNull();
  });

  it("gives no reader for a chain without any RPC", () => {
    services = base;
    expect(renderHook(() => useChainReader()).result.current(424242)).toBeNull();
  });

  it("prefers the configured RPC, and the connection's RPC over both", () => {
    services = { ...base, configuration: { ...base.configuration, rpcUrls: { 424242: "http://configured" } } };
    expect(renderHook(() => useChainReader()).result.current(424242)).not.toBeNull();
    services = { ...base, connection: { resolved: () => ({ rpcUrls: { 424242: { value: "http://connection" } } }) } };
    expect(renderHook(() => useChainReader()).result.current(424242)).not.toBeNull();
  });
});

describe("explorer links", () => {
  it("lists the explorer pages of a chain and names the main one", () => {
    expect(explorerLinksOf(1, "tx", "0xabc").length).toBeGreaterThan(0);
    expect(explorerUrl(1, "tx", "0xabc")).toContain("0xabc");
  });

  it("has no main explorer for an unknown chain", () => {
    expect(explorerUrl(424242, "tx", "0xabc")).toBeUndefined();
  });
});
