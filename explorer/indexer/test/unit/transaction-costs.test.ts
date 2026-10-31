import { describe, expect, it, vi } from "vitest";
import { PULSEX_FACTORIES, STABLES, WETH_ETHEREUM, WPLS } from "@zk-bridge/shared";
import { transactionCosts } from "../../ponder.schema";
import { nativePriceAt, recordTransactionCost } from "../../src/lib/transaction-costs";
import { createContext, createEvent, hashOf } from "./support/handler-fixtures";

const E18 = 10n ** 18n;
const USDC = STABLES[0]!.address;
const WETH_COPY = "0x02DcdD04e3F455D838cd1249292C58f3B79e3C3C";

/** A PulseChain caller with one USDC pool (PLS at $0.03) and one WETH pool (100,000 PLS a WETH), recording each block read. */
const pulsechainCaller = (blocks: bigint[] = []) => ({
  readContract: async (call: { address: string; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }): Promise<unknown> => {
    blocks.push(call.blockNumber ?? -1n);
    if (call.functionName === "getPair") {
      const [token] = call.args as [string];
      if (call.address !== PULSEX_FACTORIES[0]) return "0x0000000000000000000000000000000000000000";
      return token === USDC ? "0x00000000000000000000000000000000000000e1" : token === WETH_COPY ? "0x00000000000000000000000000000000000000e2" : "0x0000000000000000000000000000000000000000";
    }
    if (call.functionName === "bridgedTokenAddress") return WETH_COPY;
    const isUsdc = call.address === "0x00000000000000000000000000000000000000e1";
    if (call.functionName === "token0") return isUsdc ? USDC : WETH_COPY;
    return isUsdc ? [3_000n * 10n ** 6n, 100_000n * E18, 0] : [10n * E18, 1_000_000n * E18, 0];
  },
});

describe("the native coin's price for a transaction", () => {
  it("reads PLS on PulseChain through the chain's own client at the transaction's block", async () => {
    const blocks: bigint[] = [];
    const price = await nativePriceAt({ chainId: 369, blockNumber: 500n, timestamp: 1_000n, chainCaller: pulsechainCaller(blocks) }, null);
    expect(price).toEqual({ usdE18: 30_000_000_000_000_000n, block: 500n, pool: "0x00000000000000000000000000000000000000e1", source: "pulsex-pls-usd" });
    expect(new Set(blocks)).toEqual(new Set([500n]));
  });

  it("reads ETH on PulseChain at the block nearest the Ethereum transaction's time", async () => {
    const blocks: bigint[] = [];
    const clock = { latest: async () => ({ number: 900n, timestamp: 9_000n }), timestampOf: async (block: bigint) => block * 10n };
    const price = await nativePriceAt({ chainId: 1, blockNumber: 7n, timestamp: 4_004n, chainCaller: pulsechainCaller() }, { caller: pulsechainCaller(blocks), clock, firstBlock: 0n });
    expect(price).toMatchObject({ usdE18: 3_000n * E18, block: 400n, source: "pulsex-weth-copy" });
    expect(new Set(blocks)).toEqual(new Set([400n]));
    expect(WETH_ETHEREUM).toBeDefined();
  });

  it("has no price on testnets, without PulseChain access, or when a read fails", async () => {
    expect(await nativePriceAt({ chainId: 943, blockNumber: 1n, timestamp: 1n, chainCaller: pulsechainCaller() }, null)).toBeNull();
    expect(await nativePriceAt({ chainId: 1, blockNumber: 1n, timestamp: 1n, chainCaller: pulsechainCaller() }, null)).toBeNull();
    const broken = { latest: async () => Promise.reject(new Error("down")), timestampOf: async () => 0n };
    expect(await nativePriceAt({ chainId: 1, blockNumber: 1n, timestamp: 1n, chainCaller: pulsechainCaller() }, { caller: pulsechainCaller(), clock: broken, firstBlock: 0n })).toBeNull();
    expect(WPLS).toBeDefined();
  });
});

describe("recording a transaction's cost", () => {
  it("stores the receipt's cost once per transaction, with its dollars", async () => {
    const { database, context } = createContext(369);
    const event = createEvent({}, { transaction: { hash: hashOf("ab"), from: "0x00" }, transactionReceipt: { gasUsed: 200_000n, effectiveGasPrice: 10n ** 15n } });
    await recordTransactionCost({ ...context, client: pulsechainCaller() } as never, event as never, null);
    await recordTransactionCost({ ...context, client: pulsechainCaller() } as never, event as never, null);
    expect(database.rows(transactionCosts)).toEqual([
      { chainId: 369, transactionHash: hashOf("ab"), blockNumber: 100n, timestamp: 1_000n, gasUsed: 200_000n, effectiveGasPrice: 10n ** 15n, costWei: 200n * E18, usdPerNativeE18: 30_000_000_000_000_000n, priceBlock: 100n, priceSource: "pulsex-pls-usd", costUsd: 6_000_000_000_000_000_000n },
    ]);
  });

  it("stores the wei with no dollars when no price is found", async () => {
    const { database, context } = createContext(943);
    await recordTransactionCost(context as never, createEvent({}) as never, null);
    expect(database.rows(transactionCosts)[0]).toMatchObject({ chainId: 943, costWei: 63_000n, costUsd: null, priceSource: null });
  });

  it("uses the PulseChain access of the pair by default: its RPC's latest block and block times", async () => {
    vi.resetModules();
    const getBlock = vi.fn(async (query?: { blockNumber: bigint }) => ({ number: query?.blockNumber ?? 900n, timestamp: (query?.blockNumber ?? 900n) * 10n }));
    vi.doMock("viem", async (original) => ({ ...(await original<typeof import("viem")>()), createPublicClient: () => ({ getBlock, readContract: async () => undefined }) }));
    const { pulsechainAccess } = await import("../../src/lib/transaction-costs");
    const access = pulsechainAccess();
    expect(access).not.toBeNull();
    expect(pulsechainAccess()).toBe(access);
    expect(await access!.clock.latest()).toEqual({ number: 900n, timestamp: 9_000n });
    expect(await access!.clock.timestampOf(5n)).toBe(50n);
    vi.doUnmock("viem");
  });

  it("has no PulseChain access when the pair has no PulseChain side", async () => {
    vi.resetModules();
    const { pair } = await import("../../src/lib/pair");
    vi.doMock("../../src/lib/pair", () => ({ pair: { ...pair, sides: pair.sides.filter((side) => side.chainId !== 369) } }));
    const { pulsechainAccess } = await import("../../src/lib/transaction-costs");
    expect(pulsechainAccess()).toBeNull();
    expect(pulsechainAccess()).toBeNull();
    vi.doUnmock("../../src/lib/pair");
  });
});
