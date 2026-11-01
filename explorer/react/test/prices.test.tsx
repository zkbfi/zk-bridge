import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import { PULSEX_FACTORIES, STABLES, WPLS } from "@zkb/core";
import type { PoolReader, Reserves } from "@zkb/data";
import { PRICE_NOTE, loadPrices, nativePriceKey, samplePrices, tokenPriceKey, usePrices, type PriceSource, type PriceableToken } from "../src/index.js";

const [V1] = PULSEX_FACTORIES as [Address, ...Address[]];
const [USDC] = STABLES as [(typeof STABLES)[number], ...(typeof STABLES)[number][]];
const TOKEN: Address = "0x02DcdD04e3F455D838cd1249292C58f3B79e3C3C";
const E18 = 10n ** 18n;
const BLOCK = 23_000_000n;
const pair = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;

/** A reader over fixed pools at one block: PLS at $0.00003 through USDC, and TOKEN at 1 PLS = 1 TOKEN-unit pool. */
const reader = (block = BLOCK): PoolReader => {
  const pools: Record<string, { pair: Address; token: bigint; wpls: bigint }> = {
    [`${V1}:${USDC.address}`]: { pair: pair(2), token: 300_000n * 10n ** 6n, wpls: 10_000_000_000n * E18 },
    [`${V1}:${TOKEN}`]: { pair: pair(6), token: 1_000_000n * E18, wpls: 1_000_000_000n * E18 },
  };
  return {
    block,
    pairOf: async (factory, a) => pools[`${factory}:${a}`]?.pair ?? null,
    reservesOf: async (p): Promise<Reserves | null> => {
      const entry = Object.entries(pools).find(([, pool]) => pool.pair === p);
      if (entry === undefined) return null;
      const token = entry[0].split(":")[1] as Address;
      return { token0: token, reserve0: entry[1].token, reserve1: entry[1].wpls };
    },
    bridgedCopyOf: async () => null,
  };
};

const pairOfChains = { first: { chainId: 1 }, second: { chainId: 369 } };
const usdc: PriceableToken = { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6, side: "first", counterpart: null };
const minted: PriceableToken = { address: "0x1111111111111111111111111111111111111111", symbol: "zUSDC", decimals: 6, side: "second", counterpart: usdc.address, isBridgedCopy: true };
const local: PriceableToken = { address: TOKEN, symbol: "TKN", decimals: 18, side: "second", counterpart: null };

describe("the sample prices", () => {
  it("are USDC $1, ETH $3,000 and PLS $0.00003 at block 0, a bridged copy at its origin's price, and null for the rest", () => {
    const prices = samplePrices([usdc, minted, { ...usdc, address: "0x2222222222222222222222222222222222222222", symbol: "ODD" }], pairOfChains);
    expect(prices.get(tokenPriceKey(usdc))).toEqual({ usdE18: E18, block: 0n, pool: null });
    expect(prices.get(tokenPriceKey(minted))?.usdE18).toBe(E18);
    expect(prices.get("first:0x2222222222222222222222222222222222222222")).toBeNull();
    expect(prices.get(nativePriceKey(1))?.usdE18).toBe(3_000n * E18);
    expect(prices.get(nativePriceKey(369))?.usdE18).toBe(30_000_000_000_000n);
    expect(samplePrices([], { first: { chainId: 5 }, second: { chainId: 369 } }).get("native:5")).toBeNull();
  });

  it("do not take a native token that starts with Z for a copy, and give its copy the price of the origin", () => {
    const zrx: PriceableToken = { address: "0x3333333333333333333333333333333333333333", symbol: "ZRX", decimals: 18, side: "first", counterpart: null };
    const zrxCopy: PriceableToken = { address: "0x4444444444444444444444444444444444444444", symbol: "zZRX", decimals: 18, side: "second", counterpart: zrx.address, isBridgedCopy: true };
    const wethCopy: PriceableToken = { address: "0x5555555555555555555555555555555555555555", symbol: "zWETH", decimals: 18, side: "second", counterpart: null, isBridgedCopy: true };
    const prices = samplePrices([zrx, zrxCopy, wethCopy], pairOfChains);
    expect(prices.get(tokenPriceKey(zrx))).toBeNull();
    expect(prices.get(tokenPriceKey(zrxCopy))).toBeNull();
    expect(prices.get(tokenPriceKey(wethCopy))?.usdE18).toBe(3_000n * E18);
  });

  it("explain themselves in the tooltip", () => {
    expect(PRICE_NOTE).toMatch(/PulseX pools on PulseChain.*Display only/);
  });
});

describe("loadPrices", () => {
  it("prices a token and the native coins at the reader's block", async () => {
    const prices = await loadPrices([local], pairOfChains, reader());
    expect(prices.get(tokenPriceKey(local))).toMatchObject({ block: BLOCK });
    expect(prices.get(tokenPriceKey(local))!.usdE18).toBeGreaterThan(0n);
    expect(prices.get(nativePriceKey(369))).toMatchObject({ block: BLOCK });
  });

  it("gives null for every token when PLS has no price, and for a minted copy it asks about the origin", async () => {
    const none: PoolReader = { block: BLOCK, pairOf: async () => null, reservesOf: async () => null };
    const prices = await loadPrices([usdc, minted], pairOfChains, none);
    expect(prices.get(tokenPriceKey(usdc))).toBeNull();
    expect(prices.get(tokenPriceKey(minted))).toBeNull();
    const asked: Address[] = [];
    const watching: PoolReader = { ...reader(), bridgedCopyOf: async (token) => (asked.push(token), null) };
    await loadPrices([minted], pairOfChains, watching);
    expect(asked).toContain(usdc.address);
  });

  it("asks about the origin of a copy only, never of a native token whose symbol starts with Z", async () => {
    const origin = "0x3333333333333333333333333333333333333333" as Address;
    const zrxOnSecond: PriceableToken = { address: "0x6666666666666666666666666666666666666666", symbol: "ZRX", decimals: 18, side: "second", counterpart: origin };
    const asked: Address[] = [];
    const watching: PoolReader = { ...reader(), bridgedCopyOf: async (token) => (asked.push(token), null) };
    await loadPrices([zrxOnSecond], pairOfChains, watching);
    expect(asked).not.toContain(origin);
    const copyOfZrx: PriceableToken = { ...zrxOnSecond, symbol: "zZRX", isBridgedCopy: true };
    await loadPrices([copyOfZrx], pairOfChains, watching);
    expect(asked).toContain(origin);
  });

  it("prices a token on the first chain's side by its own chain", async () => {
    const prices = await loadPrices([{ ...local, side: "first" }], { first: { chainId: 369 }, second: { chainId: 1 } }, reader());
    expect(prices.get("first:" + TOKEN)).not.toBeUndefined();
  });
});

describe("usePrices", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 50; turn += 1) await vi.advanceTimersByTimeAsync(0);
  };
  const flush = () => act(settle);

  it("reads nothing without a source or without tokens", async () => {
    const { result } = renderHook(() => usePrices({ tokens: [usdc], pair: pairOfChains, source: null }));
    await flush();
    expect(result.current).toEqual({ data: undefined, error: null, isError: false, isFetching: false });
    const poolReader = vi.fn();
    const empty = renderHook(() => usePrices({ tokens: [], pair: pairOfChains, source: { mode: "live", id: "a", poolReader } }));
    await flush();
    expect(empty.result.current.data).toBeUndefined();
    expect(poolReader).not.toHaveBeenCalled();
  });

  it("says while a read is out, so a host can count the requests in flight", async () => {
    let release: (value: Awaited<ReturnType<typeof reader>>) => void = () => undefined;
    const poolReader = vi.fn(() => new Promise<Awaited<ReturnType<typeof reader>>>((resolve) => (release = resolve)));
    const source: PriceSource = { mode: "live", id: "rpc-f", poolReader };
    const { result } = renderHook(() => usePrices({ tokens: [local], pair: pairOfChains, source }));
    await flush();
    expect(result.current.isFetching).toBe(true);
    release(await reader());
    await flush();
    expect(result.current.isFetching).toBe(false);
    expect(result.current.data).toBeDefined();
  });

  it("gives the sample prices of the sample source", async () => {
    const { result } = renderHook(() => usePrices({ tokens: [usdc], pair: pairOfChains, source: { mode: "sample" } }));
    await flush();
    expect(result.current.data?.get(tokenPriceKey(usdc))?.usdE18).toBe(E18);
  });

  it("reads through the host's pool reader now and every 30 s, and stops when unmounted", async () => {
    const poolReader = vi.fn(async () => reader());
    const source: PriceSource = { mode: "live", id: "rpc-a", poolReader };
    const { result, unmount } = renderHook(() => usePrices({ tokens: [local], pair: pairOfChains, source }));
    await flush();
    expect(result.current.data?.get(tokenPriceKey(local))?.block).toBe(BLOCK);
    expect(poolReader).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(poolReader).toHaveBeenCalledTimes(2);
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(poolReader).toHaveBeenCalledTimes(2);
  });

  it("keeps the last good prices when a later read fails, and says so", async () => {
    let fail = false;
    const poolReader = vi.fn(async () => {
      if (fail) throw new Error("rpc down");
      return reader();
    });
    const { result } = renderHook(() => usePrices({ tokens: [local], pair: pairOfChains, source: { mode: "live", id: "rpc-a", poolReader }, refreshMilliseconds: 1_000 }));
    await flush();
    const good = result.current.data;
    expect(good).toBeDefined();
    fail = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(result.current.data).toBe(good);
    expect(result.current.isError).toBe(true);
    expect(String(result.current.error)).toMatch(/rpc down/);
    fail = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(result.current.isError).toBe(false);
  });

  it("starts again for another endpoint, showing no price of the old one, and reports a first failure without data", async () => {
    const good = vi.fn(async () => reader());
    const bad = vi.fn(async (): Promise<PoolReader> => { throw new Error("nope"); });
    const { result, rerender } = renderHook(({ source }: { source: PriceSource }) => usePrices({ tokens: [local], pair: pairOfChains, source }), {
      initialProps: { source: { mode: "live", id: "a", poolReader: good } as PriceSource },
    });
    await flush();
    expect(result.current.data).toBeDefined();
    rerender({ source: { mode: "live", id: "b", poolReader: bad } });
    expect(result.current.data).toBeUndefined();
    await flush();
    expect(result.current.data).toBeUndefined();
    expect(result.current.isError).toBe(true);
  });

  it("ignores an answer that comes after the hook moved on", async () => {
    let release: (value: PoolReader) => void = () => undefined;
    const slow = vi.fn(() => new Promise<PoolReader>((resolve) => { release = resolve; }));
    const failing = vi.fn(() => new Promise<PoolReader>((_, reject) => { release = () => reject(new Error("late")); }));
    const first = renderHook(() => usePrices({ tokens: [local], pair: pairOfChains, source: { mode: "live", id: "s", poolReader: slow } }));
    await flush();
    first.unmount();
    await act(async () => { release(reader()); await settle(); });
    const second = renderHook(() => usePrices({ tokens: [local], pair: pairOfChains, source: { mode: "live", id: "f", poolReader: failing } }));
    await flush();
    second.unmount();
    await act(async () => { release(reader()); await settle(); });
    expect(second.result.current.isError).toBe(false);
  });
});
