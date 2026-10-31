import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import {
  MINIMUM_DEPTH_USD,
  PULSECHAIN_COPY_OF,
  plsQuoteOf,
  poolOf,
  pricingAddress,
  stablePoolEntry,
  tokenQuoteOf,
  weightedMedian,
  weightedMedianEntry,
  type Pool,
  type PriceQuote,
} from "../src/pulsex-pricing.js";

const E18 = 10n ** 18n;
const BLOCK = 23_000_000n;
const pair = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;
const TOKEN: Address = "0x02DcdD04e3F455D838cd1249292C58f3B79e3C3C";
const WPLS_ADDRESS: Address = "0xA1077a294dDE1B09bB078844df40758a5D0f9a27";

describe("poolOf", () => {
  it("orients the reserves around the token, whichever side it is", () => {
    expect(poolOf(pair(1), TOKEN, { token0: TOKEN, reserve0: 5n, reserve1: 7n })).toEqual({ pair: pair(1), token: 5n, wpls: 7n });
    expect(poolOf(pair(1), TOKEN, { token0: WPLS_ADDRESS, reserve0: 7n, reserve1: 5n })).toEqual({ pair: pair(1), token: 5n, wpls: 7n });
    expect(poolOf(pair(1), TOKEN.toLowerCase() as Address, { token0: TOKEN, reserve0: 5n, reserve1: 7n })?.token).toBe(5n);
  });

  it("returns null when either side is empty", () => {
    expect(poolOf(pair(1), TOKEN, { token0: TOKEN, reserve0: 0n, reserve1: 7n })).toBeNull();
    expect(poolOf(pair(1), TOKEN, { token0: TOKEN, reserve0: 5n, reserve1: 0n })).toBeNull();
  });
});

describe("weightedMedian", () => {
  it("takes the value where half the weight is reached, ties in value broken by pool address, not input order", () => {
    expect(weightedMedian([{ value: 1n, weight: 1n, key: pair(1) }, { value: 2n, weight: 10n, key: pair(2) }, { value: 100n, weight: 1n, key: pair(3) }])).toBe(2n);
    expect(weightedMedian([])).toBeNull();
    expect(weightedMedian([{ value: 1n, weight: 0n, key: pair(1) }])).toBeNull();
    const a = { value: 5n, weight: 1n, key: pair(9) };
    const b = { value: 7n, weight: 1n, key: pair(1) };
    expect(weightedMedian([a, b])).toBe(5n);
    expect(weightedMedian([b, a])).toBe(5n);
    const c = { value: 5n, weight: 3n, key: pair(4) };
    expect(weightedMedian([a, c, b, c])).toBe(5n);
    expect(weightedMedian([c, a, b])).toBe(5n);
    expect(weightedMedianEntry([c, a])).toBe(c);
    // Equal values and equal addresses in either letter case keep their place.
    const upper = { value: 5n, weight: 1n, key: "0x00000000000000000000000000000000000000AB" as Address };
    const lowerCase = { value: 5n, weight: 1n, key: "0x00000000000000000000000000000000000000ab" as Address };
    expect(weightedMedianEntry([upper, lowerCase])).toBe(upper);
    // Equal values: the lower address first.
    expect(weightedMedianEntry([{ value: 5n, weight: 1n, key: pair(2) }, { value: 5n, weight: 1n, key: pair(1) }])?.key).toBe(pair(1));
  });
});

describe("the PLS/USD quote", () => {
  it("is the median of the stable pools, a 6 decimal and an 18 decimal one weighted in whole dollars", () => {
    // 1,000,000 PLS against 50 USDC (6 decimals): $0.00005 per PLS.
    const usdc = stablePoolEntry({ pair: pair(1), token: 50_000_000n, wpls: 1_000_000n * E18 }, 6);
    expect(usdc).toEqual({ value: 50_000_000_000_000n, weight: 50n * E18, key: pair(1) });
    // The same price in DAI (18 decimals).
    const dai = stablePoolEntry({ pair: pair(2), token: 50n * E18, wpls: 1_000_000n * E18 }, 18);
    expect(dai.value).toBe(usdc.value);
    expect(plsQuoteOf([usdc, dai], BLOCK)).toEqual({ usdE18: 50_000_000_000_000n, block: BLOCK, pool: pair(1) });
  });

  it("is null without a stable pool", () => {
    expect(plsQuoteOf([], BLOCK)).toBeNull();
  });
});

describe("a token's quote", () => {
  const pls: PriceQuote = { usdE18: E18 / 100n, block: BLOCK, pool: pair(9) }; // $0.01 per PLS
  const pool = (n: number, token: bigint, wpls: bigint): Pool => ({ pair: pair(n), token, wpls });

  it("takes the deepest pool by WPLS side, and prices by the reserves ratio", () => {
    // 2,000,000 PLS = $20,000 deep; 1000 whole tokens: 2000 PLS each = $20 a token.
    const quote = tokenQuoteOf([pool(1, 100n * E18, 200_000n * E18), pool(2, 1000n * E18, 2_000_000n * E18)], 18, pls, BLOCK);
    expect(quote).toEqual({ usdE18: 20n * E18, block: BLOCK, pool: pair(2) });
  });

  it("scales by the token's decimals", () => {
    const quote = tokenQuoteOf([pool(1, 1000n * 10n ** 6n, 2_000_000n * E18)], 6, pls, BLOCK);
    expect(quote?.usdE18).toBe(20n * E18);
  });

  it("breaks equal depth by the lower pool address, whatever the order", () => {
    const first = pool(1, 1000n * E18, 2_000_000n * E18);
    const second = pool(2, 500n * E18, 2_000_000n * E18);
    expect(tokenQuoteOf([second, first], 18, pls, BLOCK)?.pool).toBe(pair(1));
    expect(tokenQuoteOf([first, second], 18, pls, BLOCK)?.pool).toBe(pair(1));
  });

  it("orders by depth whichever way the list comes", () => {
    const deep = pool(1, 1000n * E18, 3_000_000n * E18);
    const shallow = pool(2, 1000n * E18, 2_000_000n * E18);
    const mid = pool(3, 1000n * E18, 2_500_000n * E18);
    for (const list of [[deep, shallow, mid], [shallow, deep, mid], [mid, shallow, deep], [shallow, mid, deep], [deep, mid, shallow], [mid, deep, shallow]]) {
      expect(tokenQuoteOf(list, 18, pls, BLOCK)?.pool).toBe(pair(1));
    }
  });

  it("does not sort the caller's list", () => {
    const list = [pool(1, 1n * E18, 100n * E18), pool(2, 1n * E18, 200n * E18)];
    tokenQuoteOf(list, 18, pls, BLOCK);
    expect(list.map((entry) => entry.pair)).toEqual([pair(1), pair(2)]);
  });

  it("gives no price for no pool, or a pool under the minimum depth", () => {
    expect(tokenQuoteOf([], 18, pls, BLOCK)).toBeNull();
    const shallow = pool(1, 1n * E18, 999_999n * E18); // $9,999.99
    expect(tokenQuoteOf([shallow], 18, pls, BLOCK)).toBeNull();
    const exact = pool(1, 1n * E18, 1_000_000n * E18); // exactly $10,000
    expect(MINIMUM_DEPTH_USD).toBe(10_000);
    expect(tokenQuoteOf([exact], 18, pls, BLOCK)).not.toBeNull();
  });
});

describe("pricingAddress", () => {
  const WETH_ETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

  it("is the address itself on PulseChain", () => {
    expect(pricingAddress({ chainId: 369, address: TOKEN })).toBe(TOKEN);
  });

  it("maps an Ethereum token through the known table, in any letter case", () => {
    expect(pricingAddress({ chainId: 1, address: WETH_ETH })).toBe(PULSECHAIN_COPY_OF[WETH_ETH.toLowerCase()]);
    expect(pricingAddress({ chainId: 1, address: "0x1111111111111111111111111111111111111111" })).toBeNull();
  });

  it("takes the origin of a minted token", () => {
    expect(pricingAddress({ chainId: 369, address: pair(5), origin: { chainId: 1, address: WETH_ETH } })).toBe(PULSECHAIN_COPY_OF[WETH_ETH.toLowerCase()]);
    expect(pricingAddress({ chainId: 1, address: pair(5), origin: { chainId: 369, address: TOKEN } })).toBe(TOKEN);
    expect(pricingAddress({ chainId: 1, address: pair(5), origin: null })).toBeNull();
  });

  it("is null on a testnet, or on a chain it does not know", () => {
    expect(pricingAddress({ chainId: 943, address: TOKEN })).toBeNull();
    expect(pricingAddress({ chainId: 11155111, address: WETH_ETH })).toBeNull();
    expect(pricingAddress({ chainId: 369, address: TOKEN, origin: { chainId: 943, address: TOKEN } })).toBeNull();
    expect(pricingAddress({ chainId: 56, address: TOKEN })).toBeNull();
  });
});
