/**
 * The price oracle (owner: "find an oracle. i think that the pulsex exchanges serve as good oracles"). Display only:
 * prices never feed amounts, tips or fees.
 *
 * PLS/USD is the depth-weighted median of WPLS against the Omnibridge stablecoins (USDC, DAI, USDT) across PulseX v1 and
 * v2. A token's price is its deepest WPLS pool (at least $10k on the WPLS side, else no price) times PLS/USD. A token
 * minted by zkb.fi takes its origin's price; testnets show none. Spec: "Price oracle: PulseX pools".
 */
import type { Address } from "viem";

export const PULSEX_FACTORIES: readonly Address[] = ["0x1715a3E4A142d8b698131108995174F37aEBA10D", "0x29eA7545DEf87022BAdc76323F373EA1e707C523"];
export const WPLS: Address = "0xA1077a294dDE1B09bB078844df40758a5D0f9a27";
export const STABLES: readonly { readonly address: Address; readonly decimals: number }[] = [
  { address: "0x15D38573d2feeb82e7ad5187aB8c1D52810B1f07", decimals: 6 }, // USDC from Ethereum
  { address: "0xefD766cCb38EaF1dfd701853BFCe31359239F305", decimals: 18 }, // DAI from Ethereum
  { address: "0x0Cb6F5a34ad42ec934882A05265A7d5F59b51A2f", decimals: 6 }, // USDT from Ethereum
];
/** The smallest WPLS-side depth, in dollars, a pool needs before its price is shown. */
export const MINIMUM_DEPTH_USD = 10_000;
/** Chains that show no prices. */
export const TESTNETS: ReadonlySet<number> = new Set([11155111, 943]);

/**
 * Where an Ethereum token's price is read on PulseChain: its Omnibridge copy there. A zkb.fi token whose origin is on
 * Ethereum maps through this (zkbWETH → WETH from Ethereum).
 */
export const PULSECHAIN_COPY_OF: Readonly<Record<string, Address>> = {
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": "0x02DcdD04e3F455D838cd1249292C58f3B79e3C3C", // WETH
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "0x15D38573d2feeb82e7ad5187aB8c1D52810B1f07", // USDC
  "0x6b175474e89094c44da98b954eedeac495271d0f": "0xefD766cCb38EaF1dfd701853BFCe31359239F305", // DAI
  "0xdac17f958d2ee523a2206206994597c13d831ec7": "0x0Cb6F5a34ad42ec934882A05265A7d5F59b51A2f", // USDT
};

/** A pool's reserves, with which token is token0. */
export type Reserves = { readonly token0: Address; readonly reserve0: bigint; readonly reserve1: bigint };

/** Reads pools: the pair address of two tokens on a factory (null when none), and its reserves. */
export type PoolReader = {
  readonly pairOf: (factory: Address, a: Address, b: Address) => Promise<Address | null>;
  readonly reservesOf: (pair: Address) => Promise<Reserves | null>;
};

const toNumber = (value: bigint, decimals: number): number => Number(value) / 10 ** decimals;

/** The reserves of `token` and of WPLS in a pool, as whole units. */
const sides = (reserves: Reserves, token: Address, decimals: number): { readonly token: number; readonly wpls: number } => {
  const tokenIs0 = reserves.token0.toLowerCase() === token.toLowerCase();
  return {
    token: toNumber(tokenIs0 ? reserves.reserve0 : reserves.reserve1, decimals),
    wpls: toNumber(tokenIs0 ? reserves.reserve1 : reserves.reserve0, 18),
  };
};

/** The pools of a token against WPLS on both factories. */
const poolsOf = async (reader: PoolReader, token: Address, decimals: number) => {
  const found = await Promise.all(
    PULSEX_FACTORIES.map(async (factory) => {
      const pair = await reader.pairOf(factory, token, WPLS);
      const reserves = pair === null ? null : await reader.reservesOf(pair);
      return reserves === null ? null : sides(reserves, token, decimals);
    }),
  );
  return found.filter((pool): pool is { token: number; wpls: number } => pool !== null && pool.token > 0 && pool.wpls > 0);
};

/**
 * The weighted median of values.
 *
 * @param entries Each value with its weight.
 */
export const weightedMedian = (entries: readonly { readonly value: number; readonly weight: number }[]): number | null => {
  const sorted = [...entries].filter((entry) => entry.weight > 0 && Number.isFinite(entry.value)).sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, entry) => sum + entry.weight, 0);
  if (total === 0) return null;
  let running = 0;
  for (const entry of sorted) {
    running += entry.weight;
    if (running >= total / 2) return entry.value;
  }
  return sorted.at(-1)!.value;
};

/** PLS in dollars: the depth-weighted median over the stablecoin pools of both factories, or null. */
export const plsUsd = async (reader: PoolReader): Promise<number | null> => {
  const entries = (await Promise.all(STABLES.map(async (stable) => (await poolsOf(reader, stable.address, stable.decimals)).map((pool) => ({ value: pool.token / pool.wpls, weight: pool.token }))))).flat();
  return weightedMedian(entries);
};

/**
 * A PulseChain token's price in dollars: its deepest WPLS pool times PLS/USD, when the WPLS side is worth at least
 * {@link MINIMUM_DEPTH_USD}; else null.
 */
export const tokenUsd = async (reader: PoolReader, token: Address, decimals: number, pls: number): Promise<number | null> => {
  if (token.toLowerCase() === WPLS.toLowerCase()) return pls;
  const pools = await poolsOf(reader, token, decimals);
  const deepest = pools.sort((a, b) => b.wpls - a.wpls)[0];
  if (deepest === undefined || deepest.wpls * pls < MINIMUM_DEPTH_USD) return null;
  return (deepest.wpls / deepest.token) * pls;
};

/**
 * The PulseChain token whose pools price a token: itself on PulseChain; on Ethereum, its Omnibridge copy; a zkb.fi token
 * takes its origin's. Null on a testnet or when there is no known copy.
 *
 * @param token The token's chain, address, and origin (chain and address) when zkb.fi minted it.
 */
export const pricingAddress = (token: { readonly chainId: number; readonly address: Address; readonly origin?: { readonly chainId: number; readonly address: Address } | null }): Address | null => {
  const subject = token.origin ?? { chainId: token.chainId, address: token.address };
  if (TESTNETS.has(token.chainId) || TESTNETS.has(subject.chainId)) return null;
  if (subject.chainId === 369) return subject.address;
  if (subject.chainId === 1) return PULSECHAIN_COPY_OF[subject.address.toLowerCase()] ?? null;
  return null;
};

/** A dollar value as text, for display: "1,234.56", or small values with significant digits. */
export const usdText = (value: number): string =>
  value >= 1 ? value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : value.toPrecision(3).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
