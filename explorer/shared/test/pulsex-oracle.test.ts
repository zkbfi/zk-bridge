import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import {
  MINIMUM_DEPTH_USD,
  nativeUsd,
  nearestBlockAt,
  OMNIBRIDGE_PULSECHAIN,
  poolReaderOver,
  PULSECHAIN_COPY_OF,
  PULSEX_FACTORIES,
  plsUsd,
  priceNumber,
  pricingAddress,
  resolvePricingAddress,
  STABLES,
  tokenUsd,
  usdText,
  WETH_ETHEREUM,
  WPLS,
  weightedMedian,
  type PoolReader,
  type Reserves,
} from "../src/pulsex-oracle.js";

const [V1, V2] = PULSEX_FACTORIES as [Address, Address];
const [USDC, DAI, USDT] = STABLES as [(typeof STABLES)[number], (typeof STABLES)[number], (typeof STABLES)[number]];
const TOKEN: Address = "0x02DcdD04e3F455D838cd1249292C58f3B79e3C3C";
const E18 = 10n ** 18n;
const BLOCK = 23_000_000n;

/** A reader over fixed pools at one block: key `<factory>:<token>` → [token reserve, WPLS reserve] in base units, and a pair address. */
const readerOf = (pools: Record<string, { readonly pair: Address; readonly token: bigint; readonly wpls: bigint }>, block = BLOCK, copies: Record<string, Address> = {}): PoolReader => ({
  block,
  pairOf: async (factory, a) => pools[`${factory}:${a}`]?.pair ?? null,
  reservesOf: async (pair): Promise<Reserves | null> => {
    const entry = Object.entries(pools).find(([, pool]) => pool.pair === pair);
    if (entry === undefined) return null;
    const [key, pool] = entry;
    // Put WPLS first in half the pools, so both orders are read.
    const token = key.split(":")[1] as Address;
    return BigInt(pair) % 2n === 0n ? { token0: token, reserve0: pool.token, reserve1: pool.wpls } : { token0: WPLS, reserve0: pool.wpls, reserve1: pool.token };
  },
  bridgedCopyOf: async (token) => copies[token.toLowerCase()] ?? null,
});
const pair = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;

describe("weightedMedian", () => {
  it("takes the value where half the weight is reached, ties in value broken by pool address, not input order", () => {
    expect(weightedMedian([{ value: 1n, weight: 1n, key: pair(1) }, { value: 2n, weight: 10n, key: pair(2) }, { value: 100n, weight: 1n, key: pair(3) }])).toBe(2n);
    expect(weightedMedian([])).toBeNull();
    expect(weightedMedian([{ value: 1n, weight: 0n, key: pair(1) }])).toBeNull();
    // Exactly half the weight on each side: the lower value.
    const a = { value: 5n, weight: 1n, key: pair(9) };
    const b = { value: 7n, weight: 1n, key: pair(1) };
    expect(weightedMedian([a, b])).toBe(5n);
    expect(weightedMedian([b, a])).toBe(5n);
    // Equal values: sorted by pool address, whatever the input order (and an address equal to itself keeps its place).
    const c = { value: 5n, weight: 3n, key: pair(4) };
    expect(weightedMedian([a, c, b, c])).toBe(5n);
    expect(weightedMedian([c, a, b])).toBe(5n);
  });
});

describe("PLS/USD", () => {
  it("is the depth-weighted median across the stablecoin pools of both factories, in integers, at the reader's block", async () => {
    const reader = readerOf({
      [`${V1}:${USDC.address}`]: { pair: pair(2), token: 300_000n * 10n ** 6n, wpls: 10_000_000_000n * E18 }, // $0.00003
      [`${V2}:${DAI.address}`]: { pair: pair(3), token: 200_000n * E18, wpls: 6_666_666_667n * E18 },
      [`${V2}:${USDT.address}`]: { pair: pair(4), token: 100n * 10n ** 6n, wpls: 1_000_000n * E18 }, // $0.0001, thin
    });
    expect(await plsUsd(reader)).toEqual({ usdE18: 30_000_000_000_000n, block: BLOCK, pool: pair(2) });
  });

  it("gives null when no stable pool exists", async () => {
    expect(await plsUsd(readerOf({}))).toBeNull();
  });
});

describe("a token's price", () => {
  const pls = { usdE18: 30_000_000_000_000n, block: BLOCK, pool: pair(2) };
  it("uses the deepest WPLS pool across v1 and v2, carrying the block", async () => {
    const reader = readerOf({
      [`${V1}:${TOKEN}`]: { pair: pair(6), token: 10n * E18, wpls: 1_000_000_000n * E18 },
      [`${V2}:${TOKEN}`]: { pair: pair(7), token: 100n * E18, wpls: 12_000_000_000n * E18 },
    });
    // 120M PLS per token × $0.00003 = $3,600.
    expect(await tokenUsd(reader, TOKEN, 18, pls)).toEqual({ usdE18: 3_600n * E18, block: BLOCK, pool: pair(7) });
  });

  it("orders pools by depth whichever factory is deeper", async () => {
    const reader = readerOf({
      [`${V1}:${TOKEN}`]: { pair: pair(6), token: 100n * E18, wpls: 12_000_000_000n * E18 },
      [`${V2}:${TOKEN}`]: { pair: pair(7), token: 10n * E18, wpls: 1_000_000_000n * E18 },
    });
    expect((await tokenUsd(reader, TOKEN, 18, pls))?.pool).toBe(pair(6));
  });

  it("breaks a tie in depth by the lower pool address", async () => {
    const reader = readerOf({
      [`${V1}:${TOKEN}`]: { pair: pair(9), token: 10n * E18, wpls: 1_000_000_000n * E18 },
      [`${V2}:${TOKEN}`]: { pair: pair(8), token: 20n * E18, wpls: 1_000_000_000n * E18 },
    });
    expect((await tokenUsd(reader, TOKEN, 18, pls))?.pool).toBe(pair(8));
  });

  it("shows no price when the WPLS side is below the depth floor", async () => {
    const thinWpls = (BigInt(MINIMUM_DEPTH_USD) * E18 * E18) / pls.usdE18 - 1n;
    expect(await tokenUsd(readerOf({ [`${V2}:${TOKEN}`]: { pair: pair(6), token: E18, wpls: thinWpls } }), TOKEN, 18, pls)).toBeNull();
    expect(await tokenUsd(readerOf({}), TOKEN, 18, pls)).toBeNull();
    // A pair whose reserves cannot be read counts as no pool.
    expect(await tokenUsd({ block: BLOCK, pairOf: async () => pair(6), reservesOf: async () => null }, TOKEN, 18, pls)).toBeNull();
  });

  it("is PLS itself for WPLS, and refuses a PLS quote from another block", async () => {
    expect(await tokenUsd(readerOf({}), WPLS, 18, pls)).toEqual(pls);
    await expect(tokenUsd(readerOf({}, BLOCK + 1n), TOKEN, 18, pls)).rejects.toThrow(/block/);
  });

  it("gives a display number only through priceNumber", () => {
    expect(priceNumber({ usdE18: 1_500_000_000_000_000_000n, block: 1n, pool: null })).toBe(1.5);
  });
});

describe("where a token is priced", () => {
  it("prices a zkb.fi token by its origin, a PulseChain token by itself, and nothing on a testnet", () => {
    expect(pricingAddress({ chainId: 369, address: pair(17), origin: { chainId: 1, address: WETH_ETHEREUM } })).toBe(TOKEN);
    expect(pricingAddress({ chainId: 943, address: pair(17) })).toBeNull();
    expect(pricingAddress({ chainId: 369, address: WPLS })).toBe(WPLS);
    expect(pricingAddress({ chainId: 10, address: WPLS })).toBeNull();
  });

  it("reverses an Ethereum token out through the current Omnibridge to its PulseChain copy, read at the block", async () => {
    const copy = pair(77);
    const reader = readerOf({}, BLOCK, { [pair(55).toLowerCase()]: copy });
    expect(await resolvePricingAddress({ chainId: 1, address: pair(55) }, reader)).toBe(copy);
    // No copy on the Omnibridge: the known table, else nothing.
    expect(await resolvePricingAddress({ chainId: 1, address: WETH_ETHEREUM }, readerOf({}))).toBe(PULSECHAIN_COPY_OF[WETH_ETHEREUM.toLowerCase()]);
    expect(await resolvePricingAddress({ chainId: 1, address: pair(56) }, readerOf({}))).toBeNull();
    expect(await resolvePricingAddress({ chainId: 369, address: WPLS }, readerOf({}))).toBe(WPLS);
    expect(await resolvePricingAddress({ chainId: 11155111, address: pair(55) }, reader)).toBeNull();
    const { bridgedCopyOf: _drop, ...withoutCopies } = readerOf({});
    expect(await resolvePricingAddress({ chainId: 1, address: WETH_ETHEREUM }, withoutCopies)).toBe(TOKEN);
  });
});

describe("dollar text", () => {
  it("shows two decimals from $1, else three significant digits", () => {
    expect(usdText(1234.5)).toBe("1,234.50");
    expect(usdText(0.0000562)).toBe("0.0000562");
    expect(usdText(0.5)).toBe("0.5");
  });
});

describe("the native coin's price", () => {
  const stable = { [`${V1}:${USDC.address}`]: { pair: pair(2), token: 3_000n * 10n ** 6n, wpls: 100_000n * E18 } }; // PLS $0.03
  it("prices PLS from PulseX at the reader's block", async () => {
    expect(await nativeUsd(readerOf(stable), 369)).toEqual({ usdE18: 30_000_000_000_000_000n, block: BLOCK, pool: pair(2), source: "pulsex-pls-usd" });
  });

  it("prices ETH by WETH from Ethereum on PulseX, through a PulseChain reader", async () => {
    const reader = readerOf({ ...stable, [`${V2}:${TOKEN}`]: { pair: pair(6), token: 10n * E18, wpls: 1_000_000n * E18 } }, BLOCK, { [WETH_ETHEREUM.toLowerCase()]: TOKEN });
    // 100,000 PLS per WETH × $0.03 = $3,000.
    expect(await nativeUsd(reader, 1)).toEqual({ usdE18: 3_000n * E18, block: BLOCK, pool: pair(6), source: "pulsex-weth-copy" });
  });

  it("gives none on testnets or other chains, and none when no pool answers", async () => {
    expect(await nativeUsd(readerOf(stable), 943)).toBeNull();
    expect(await nativeUsd(readerOf(stable), 11155111)).toBeNull();
    expect(await nativeUsd(readerOf(stable), 1)).toBeNull(); // no WETH pool
    expect(await nativeUsd(readerOf({}), 369)).toBeNull();
    expect(await nativeUsd(readerOf({}), 1)).toBeNull();
  });
});

describe("the PulseChain block nearest a timestamp", () => {
  // Blocks every 10 s from block 100 at t = 1,000.
  const chain = { latest: async () => ({ number: 200n, timestamp: 2_000n }), timestampOf: async (block: bigint) => 1_000n + (block - 100n) * 10n };
  it("finds the block with the nearest timestamp, a tie going to the earlier block", async () => {
    expect(await nearestBlockAt(1_500n, chain, 100n)).toBe(150n);
    expect(await nearestBlockAt(1_504n, chain, 100n)).toBe(150n);
    expect(await nearestBlockAt(1_505n, chain, 100n)).toBe(150n);
    expect(await nearestBlockAt(1_506n, chain, 100n)).toBe(151n);
  });
  it("clamps to the first and the latest block", async () => {
    expect(await nearestBlockAt(10n, chain, 100n)).toBe(100n);
    expect(await nearestBlockAt(9_999n, chain, 100n)).toBe(200n);
  });
});

describe("the pool reader over a contract caller", () => {
  const calls: { functionName: string; blockNumber?: bigint }[] = [];
  const caller = (failing = false) => ({
    readContract: async (call: { address: Address; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }): Promise<unknown> => {
      calls.push({ functionName: call.functionName, ...(call.blockNumber === undefined ? {} : { blockNumber: call.blockNumber }) });
      if (failing) throw new Error("reverted");
      if (call.functionName === "getPair") return call.address === V1 ? pair(2) : "0x0000000000000000000000000000000000000000";
      if (call.functionName === "bridgedTokenAddress") return call.address === OMNIBRIDGE_PULSECHAIN ? TOKEN : pair(0);
      if (call.functionName === "token0") return USDC.address;
      return [3_000n * 10n ** 6n, 100_000n * E18, 0];
    },
  });

  it("reads every call at its block", async () => {
    calls.length = 0;
    const reader = poolReaderOver(caller(), BLOCK);
    expect(reader.block).toBe(BLOCK);
    expect(await reader.pairOf(V1, USDC.address, WPLS)).toBe(pair(2));
    expect(await reader.pairOf(V2, USDC.address, WPLS)).toBeNull();
    expect(await reader.reservesOf(pair(2))).toEqual({ token0: USDC.address, reserve0: 3_000n * 10n ** 6n, reserve1: 100_000n * E18 });
    expect(await reader.bridgedCopyOf!(WETH_ETHEREUM)).toBe(TOKEN);
    expect(calls.every((call) => call.blockNumber === BLOCK)).toBe(true);
  });

  it("reads a failing call as no pool and no copy", async () => {
    const broken = poolReaderOver(caller(true), BLOCK);
    expect(await broken.pairOf(V1, USDC.address, WPLS)).toBeNull();
    expect(await broken.reservesOf(V1)).toBeNull();
    expect(await broken.bridgedCopyOf!(WETH_ETHEREUM)).toBeNull();
  });

  it("reads a zero copy address as none", async () => {
    const reader = poolReaderOver({ readContract: async () => "0x0000000000000000000000000000000000000000" }, BLOCK);
    expect(await reader.bridgedCopyOf!(WETH_ETHEREUM)).toBeNull();
  });
});
