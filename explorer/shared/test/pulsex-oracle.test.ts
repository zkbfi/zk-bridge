import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { MINIMUM_DEPTH_USD, nativeUsd, poolReaderOver, PULSEX_FACTORIES, plsUsd, pricingAddress, STABLES, tokenUsd, WPLS, weightedMedian, type PoolReader, type Reserves } from "../src/pulsex-oracle.js";

const [V1, V2] = PULSEX_FACTORIES as [Address, Address];
const [USDC, DAI, USDT] = STABLES;
const TOKEN: Address = "0x02DcdD04e3F455D838cd1249292C58f3B79e3C3C";

/** A reader over fixed pools: key `<factory>:<token>` → [token amount, WPLS amount] in whole units. */
const readerOf = (pools: Record<string, readonly [number, number, number]>): PoolReader => {
  const keys = Object.keys(pools);
  const pairAddress = (index: number): Address => `0x${(index + 1).toString(16).padStart(40, "0")}` as Address;
  return {
    pairOf: async (factory, a) => {
      const index = keys.indexOf(`${factory}:${a}`);
      return index < 0 ? null : pairAddress(index);
    },
    reservesOf: async (pair): Promise<Reserves | null> => {
      const index = keys.findIndex((_, at) => pairAddress(at).toLowerCase() === pair.toLowerCase());
      if (index < 0) return null;
      const key = keys[index]!;
      const [tokenAmount, wplsAmount, decimals] = pools[key]!;
      const token = key.split(":")[1] as Address;
      return { token0: token, reserve0: BigInt(Math.round(tokenAmount * 10 ** Math.min(decimals, 12))) * 10n ** BigInt(Math.max(0, decimals - 12)), reserve1: BigInt(Math.round(wplsAmount)) * 10n ** 18n };
    },
  };
};

describe("weightedMedian", () => {
  it("takes the value where half the weight is reached", () => {
    expect(weightedMedian([{ value: 1, weight: 1 }, { value: 2, weight: 10 }, { value: 100, weight: 1 }])).toBe(2);
    expect(weightedMedian([])).toBeNull();
  });
});

describe("PLS/USD", () => {
  it("is the depth-weighted median across the stablecoin pools of both factories; a thin outlier does not move it", async () => {
    const reader = readerOf({
      [`${V1}:${USDC!.address}`]: [300_000, 10_000_000_000, 6], // 0.00003
      [`${V2}:${DAI!.address}`]: [200_000, 6_666_666_667, 18], // 0.00003
      [`${V2}:${USDT!.address}`]: [100, 1_000_000, 6], // 0.0001, thin
    });
    expect(await plsUsd(reader)).toBeCloseTo(0.00003, 8);
  });
});

describe("a token's price", () => {
  it("uses the deepest WPLS pool across v1 and v2", async () => {
    const reader = readerOf({
      [`${V1}:${TOKEN}`]: [10, 1_000_000_000, 18], // 100M PLS per token, shallow side
      [`${V2}:${TOKEN}`]: [100, 12_000_000_000, 18], // deeper
    });
    expect(await tokenUsd(reader, TOKEN, 18, 0.00003)).toBeCloseTo((12_000_000_000 / 100) * 0.00003, 6);
  });

  it("shows no price when the WPLS side is below the depth floor", async () => {
    const thinWpls = (MINIMUM_DEPTH_USD / 0.00003) * 0.5;
    const reader = readerOf({ [`${V2}:${TOKEN}`]: [1, thinWpls, 18] });
    expect(await tokenUsd(reader, TOKEN, 18, 0.00003)).toBeNull();
  });

  it("prices a zkb.fi token by its origin (zkbWETH → WETH from Ethereum), and shows nothing on a testnet", () => {
    expect(pricingAddress({ chainId: 369, address: "0x1111111111111111111111111111111111111111", origin: { chainId: 1, address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" } })).toBe(TOKEN);
    expect(pricingAddress({ chainId: 943, address: "0x1111111111111111111111111111111111111111" })).toBeNull();
    expect(pricingAddress({ chainId: 369, address: WPLS })).toBe(WPLS);
  });
});

describe("the native coin's price and the pool reader over a contract caller", () => {
  const caller = (pools: Record<string, readonly [bigint, bigint]>, failing = false) => ({
    readContract: async (call: { address: Address; functionName: string; args?: readonly unknown[] }): Promise<unknown> => {
      if (failing) throw new Error("reverted");
      if (call.functionName === "getPair") {
        const [a] = call.args as [Address, Address];
        return call.address === V1 && pools[a] !== undefined ? `0x${a.slice(-38)}aa` : "0x0000000000000000000000000000000000000000";
      }
      const stable = Object.keys(pools).find((key) => `0x${key.slice(-38)}aa` === call.address)!;
      if (call.functionName === "token0") return stable;
      const [token, wpls] = pools[stable]!;
      return [token, wpls, 0];
    },
  });

  it("prices PLS from PulseX on PulseChain, at whatever block the caller reads", async () => {
    const reader = poolReaderOver(caller({ [USDC!.address]: [3_000_000_000n, 100_000n * 10n ** 18n] }));
    expect(await nativeUsd(reader, 369)).toEqual({ usd: expect.closeTo(0.03, 9), source: "pulsex-pls-usd" });
  });

  it("gives no price on testnets or Ethereum, and none when no pool answers", async () => {
    const reader = poolReaderOver(caller({ [USDC!.address]: [3_000_000_000n, 100_000n * 10n ** 18n] }));
    expect(await nativeUsd(reader, 943)).toBeNull();
    expect(await nativeUsd(reader, 11155111)).toBeNull();
    expect(await nativeUsd(reader, 1)).toBeNull();
    expect(await nativeUsd(poolReaderOver(caller({})), 369)).toBeNull();
    const broken = poolReaderOver(caller({}, true));
    expect(await broken.pairOf(V1, USDC!.address, WPLS)).toBeNull();
    expect(await broken.reservesOf(V1)).toBeNull();
  });
});
