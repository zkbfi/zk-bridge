/**
 * The pure maths of the PulseX price oracle (owner: "find an oracle. i think that the pulsex exchanges serve as good
 * oracles"). Prices never feed a signed amount: they show dollar values, pick the default fee and judge whether a tip
 * pays (`tip-verdict.ts`). This module takes pool reserves that were read and turns them into prices; the reads, through
 * the caller's client, and the state of each price are in `token-pricing.ts`.
 *
 * PLS/USD is the depth-weighted median of WPLS against the Omnibridge stablecoins (USDC, DAI, USDT) across PulseX v1 and
 * v2. A token's price is its deepest WPLS pool (at least $10k on the WPLS side, else no price) times PLS/USD. A token
 * minted by zkb.fi takes its origin's price; an Ethereum token is reversed out through the Omnibridge to its PulseChain
 * copy. Testnets show none.
 *
 * Deterministic: integers only (a price is USD per whole token x 1e18, `usdE18`; every division rounds down), every quote
 * carries the block it was read at, and ties (equal depth, equal value in the median) are broken by the lower pool
 * address, so input order never matters.
 */
import type { Address } from "viem";

/** The PulseX v1 and v2 factories on PulseChain. */
export const PULSEX_FACTORIES: readonly Address[] = ["0x1715a3E4A142d8b698131108995174F37aEBA10D", "0x29eA7545DEf87022BAdc76323F373EA1e707C523"];
/** Wrapped PLS. */
export const WPLS: Address = "0xA1077a294dDE1B09bB078844df40758a5D0f9a27";
/** The stablecoins that price PLS: the Omnibridge copies of USDC, DAI and USDT. */
export const STABLES: readonly { readonly address: Address; readonly decimals: number }[] = [
  { address: "0x15D38573d2feeb82e7ad5187aB8c1D52810B1f07", decimals: 6 }, // USDC from Ethereum
  { address: "0xefD766cCb38EaF1dfd701853BFCe31359239F305", decimals: 18 }, // DAI from Ethereum
  { address: "0x0Cb6F5a34ad42ec934882A05265A7d5F59b51A2f", decimals: 6 }, // USDT from Ethereum
];
/** The current Omnibridge mediator on PulseChain: `bridgedTokenAddress(ethereumToken)`. */
export const OMNIBRIDGE_PULSECHAIN: Address = "0x4fD0aaa7506f3d9cB8274bdB946Ec42A1b8751Ef";
/** WETH on Ethereum: ETH's price is its PulseChain copy's. */
export const WETH_ETHEREUM: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
/** The smallest WPLS-side depth, in dollars, a pool needs before its price is shown. */
export const MINIMUM_DEPTH_USD = 10_000;
/** Chains that show no prices. */
export const TESTNETS: ReadonlySet<number> = new Set([11155111, 943]);

/**
 * Known PulseChain copies of Ethereum tokens, used when a reader cannot ask the Omnibridge. A zkb.fi token whose origin
 * is on Ethereum maps through this (zWETH to WETH from Ethereum). Keys are lowercase Ethereum addresses.
 */
export const PULSECHAIN_COPY_OF: Readonly<Record<string, Address>> = {
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": "0x02DcdD04e3F455D838cd1249292C58f3B79e3C3C", // WETH
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "0x15D38573d2feeb82e7ad5187aB8c1D52810B1f07", // USDC
  "0x6b175474e89094c44da98b954eedeac495271d0f": "0xefD766cCb38EaF1dfd701853BFCe31359239F305", // DAI
  "0xdac17f958d2ee523a2206206994597c13d831ec7": "0x0Cb6F5a34ad42ec934882A05265A7d5F59b51A2f", // USDT
};

/** A pool's reserves, with which token is token0. */
export type Reserves = { readonly token0: Address; readonly reserve0: bigint; readonly reserve1: bigint };

/** A price: USD per whole token x 1e18, the block it was read at, and the pool it came from (null when derived). */
export type PriceQuote = { readonly usdE18: bigint; readonly block: bigint; readonly pool: Address | null };

/** A pool of a token against WPLS: its address and both reserves in base units. */
export type Pool = { readonly pair: Address; readonly token: bigint; readonly wpls: bigint };

/** A value with its weight and a tie-breaking key (a pool address), for {@link weightedMedian}. */
export type WeightedEntry = { readonly value: bigint; readonly weight: bigint; readonly key: Address };

const E18 = 10n ** 18n;
const lower = (address: Address): string => address.toLowerCase();
const byAddress = (a: Address, b: Address): number => (lower(a) < lower(b) ? -1 : lower(a) > lower(b) ? 1 : 0);

/**
 * Orients a pair's reserves around one token: its side and the WPLS side. Null when either side is empty.
 *
 * @param pair The pair's address.
 * @param token The token whose pool this is (the other side is WPLS).
 * @param reserves The pair's reserves.
 */
export const poolOf = (pair: Address, token: Address, reserves: Reserves): Pool | null => {
  const tokenIs0 = lower(reserves.token0) === lower(token);
  const pool = { pair, token: tokenIs0 ? reserves.reserve0 : reserves.reserve1, wpls: tokenIs0 ? reserves.reserve1 : reserves.reserve0 };
  return pool.token > 0n && pool.wpls > 0n ? pool : null;
};

/**
 * The weighted median of values: sorted by value, then by key (pool address), it is the first entry at which the running
 * weight reaches half the total (so with weight split evenly, the lower value). Entries with no weight are ignored.
 *
 * @param entries Each value with its weight and key.
 * @returns The entry, or null when there is none with weight.
 */
export const weightedMedianEntry = <T extends WeightedEntry>(entries: readonly T[]): T | null => {
  const sorted = entries.filter((entry) => entry.weight > 0n).sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : byAddress(a.key, b.key)));
  const total = sorted.reduce((sum, entry) => sum + entry.weight, 0n);
  let running = 0n;
  for (const entry of sorted) {
    running += entry.weight;
    if (2n * running >= total) return entry;
  }
  return null;
};

/** The value of {@link weightedMedianEntry}, or null. */
export const weightedMedian = <T extends WeightedEntry>(entries: readonly T[]): T["value"] | null => weightedMedianEntry(entries)?.value ?? null;

/**
 * One stable pool as an entry of the PLS/USD median: the price of one WPLS in dollars (x 1e18), weighted by its stable side
 * in whole dollars (18 decimals).
 *
 * @param pool The pool of the stablecoin against WPLS.
 * @param stableDecimals The decimals of the stablecoin.
 */
export const stablePoolEntry = (pool: Pool, stableDecimals: number): WeightedEntry => ({
  value: (pool.token * E18 * E18) / (10n ** BigInt(stableDecimals) * pool.wpls),
  weight: pool.token * 10n ** BigInt(18 - stableDecimals),
  key: pool.pair,
});

/**
 * PLS in dollars at a block: the weighted median of the stable pools' entries, or null when there are none.
 *
 * @param entries The entries from {@link stablePoolEntry}, one per stable pool.
 * @param block The block the pools were read at.
 */
export const plsQuoteOf = (entries: readonly WeightedEntry[], block: bigint): PriceQuote | null => {
  const median = weightedMedianEntry(entries);
  return median === null ? null : { usdE18: median.value, block, pool: median.key };
};

/**
 * A token's price from its WPLS pools: the deepest pool (WPLS side; ties to the lower pool address) times PLS/USD, when the
 * WPLS side is worth at least {@link MINIMUM_DEPTH_USD}; else null. The caller checks that `pls` was read at `block`.
 *
 * @param pools The token's pools against WPLS.
 * @param decimals The token's decimals.
 * @param pls The PLS/USD quote.
 * @param block The block the pools were read at.
 */
export const tokenQuoteOf = (pools: readonly Pool[], decimals: number, pls: PriceQuote, block: bigint): PriceQuote | null => {
  const deepest = [...pools].sort((a, b) => (a.wpls > b.wpls ? -1 : a.wpls < b.wpls ? 1 : byAddress(a.pair, b.pair)))[0];
  if (deepest === undefined || deepest.wpls * pls.usdE18 < BigInt(MINIMUM_DEPTH_USD) * E18 * E18) return null;
  return { usdE18: (deepest.wpls * 10n ** BigInt(decimals) * pls.usdE18) / (deepest.token * E18), block, pool: deepest.pair };
};

/** A token as the pricing address needs it: its chain, address, and origin (chain and address) when zkb.fi minted it. */
export type PricedToken = { readonly chainId: number; readonly address: Address; readonly origin?: { readonly chainId: number; readonly address: Address } | null };

/**
 * The PulseChain token whose pools price a token, from the known table: itself on PulseChain; on Ethereum, its known
 * Omnibridge copy; a zkb.fi token takes its origin's. Null on a testnet or when there is no known copy.
 *
 * @param token The token's chain, address, and origin when zkb.fi minted it.
 */
export const pricingAddress = (token: PricedToken): Address | null => {
  const subject = token.origin ?? { chainId: token.chainId, address: token.address };
  if (TESTNETS.has(token.chainId) || TESTNETS.has(subject.chainId)) return null;
  if (subject.chainId === 369) return subject.address;
  if (subject.chainId === 1) return PULSECHAIN_COPY_OF[lower(subject.address)] ?? null;
  return null;
};
