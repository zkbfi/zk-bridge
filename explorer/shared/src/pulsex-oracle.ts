/**
 * The price oracle (owner: "find an oracle. i think that the pulsex exchanges serve as good oracles"). Display only:
 * prices never feed amounts, tips or fees.
 *
 * PLS/USD is the depth-weighted median of WPLS against the Omnibridge stablecoins (USDC, DAI, USDT) across PulseX v1 and
 * v2. A token's price is its deepest WPLS pool (at least $10k on the WPLS side, else no price) times PLS/USD. A token
 * minted by zkb.fi takes its origin's price; an Ethereum token is reversed out through the current Omnibridge to its
 * PulseChain copy; ETH is WETH's copy. Testnets show none. Spec: "Price oracle: PulseX pools", "Determinism".
 *
 * Deterministic: integers only (a price is USD per whole token × 1e18, `usdE18`; every division rounds down), every read
 * is pinned to the reader's block and every quote carries it, and ties (equal depth, equal value in the median) are
 * broken by the lower pool address, so input order never matters.
 */
import type { Address } from "viem";

export const PULSEX_FACTORIES: readonly Address[] = ["0x1715a3E4A142d8b698131108995174F37aEBA10D", "0x29eA7545DEf87022BAdc76323F373EA1e707C523"];
export const WPLS: Address = "0xA1077a294dDE1B09bB078844df40758a5D0f9a27";
export const STABLES: readonly { readonly address: Address; readonly decimals: number }[] = [
  { address: "0x15D38573d2feeb82e7ad5187aB8c1D52810B1f07", decimals: 6 }, // USDC from Ethereum
  { address: "0xefD766cCb38EaF1dfd701853BFCe31359239F305", decimals: 18 }, // DAI from Ethereum
  { address: "0x0Cb6F5a34ad42ec934882A05265A7d5F59b51A2f", decimals: 6 }, // USDT from Ethereum
];
/** The current Omnibridge mediator on PulseChain (docs/pulsechain-amb-review.md): `bridgedTokenAddress(ethereumToken)`. */
export const OMNIBRIDGE_PULSECHAIN: Address = "0x4fD0aaa7506f3d9cB8274bdB946Ec42A1b8751Ef";
/** WETH on Ethereum: ETH's price is its PulseChain copy's. */
export const WETH_ETHEREUM: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
/** The smallest WPLS-side depth, in dollars, a pool needs before its price is shown. */
export const MINIMUM_DEPTH_USD = 10_000;
/** Chains that show no prices. */
export const TESTNETS: ReadonlySet<number> = new Set([11155111, 943]);

/**
 * Known PulseChain copies of Ethereum tokens, used when a reader cannot ask the Omnibridge. A zkb.fi token whose origin
 * is on Ethereum maps through this (zkbWETH → WETH from Ethereum).
 */
export const PULSECHAIN_COPY_OF: Readonly<Record<string, Address>> = {
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": "0x02DcdD04e3F455D838cd1249292C58f3B79e3C3C", // WETH
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "0x15D38573d2feeb82e7ad5187aB8c1D52810B1f07", // USDC
  "0x6b175474e89094c44da98b954eedeac495271d0f": "0xefD766cCb38EaF1dfd701853BFCe31359239F305", // DAI
  "0xdac17f958d2ee523a2206206994597c13d831ec7": "0x0Cb6F5a34ad42ec934882A05265A7d5F59b51A2f", // USDT
};

/** A pool's reserves, with which token is token0. */
export type Reserves = { readonly token0: Address; readonly reserve0: bigint; readonly reserve1: bigint };

/**
 * Reads PulseChain at one named block: the pair address of two tokens on a factory (null when none), its reserves, and
 * (optionally) the Omnibridge copy of an Ethereum token.
 */
export type PoolReader = {
  readonly block: bigint;
  readonly pairOf: (factory: Address, a: Address, b: Address) => Promise<Address | null>;
  readonly reservesOf: (pair: Address) => Promise<Reserves | null>;
  readonly bridgedCopyOf?: (ethereumToken: Address) => Promise<Address | null>;
};

/** A price: USD per whole token × 1e18, the block it was read at, and the pool it came from (null when derived). */
export type PriceQuote = { readonly usdE18: bigint; readonly block: bigint; readonly pool: Address | null };

const E18 = 10n ** 18n;
const lower = (address: Address): string => address.toLowerCase();
const byAddress = (a: Address, b: Address): number => (lower(a) < lower(b) ? -1 : lower(a) > lower(b) ? 1 : 0);

/** A pool of a token against WPLS: its address and both reserves in base units. */
type Pool = { readonly pair: Address; readonly token: bigint; readonly wpls: bigint };

/** The pools of a token against WPLS on both factories. */
const poolsOf = async (reader: PoolReader, token: Address): Promise<Pool[]> => {
  const found = await Promise.all(
    PULSEX_FACTORIES.map(async (factory): Promise<Pool | null> => {
      const pair = await reader.pairOf(factory, token, WPLS);
      const reserves = pair === null ? null : await reader.reservesOf(pair);
      if (pair === null || reserves === null) return null;
      const tokenIs0 = lower(reserves.token0) === lower(token);
      return { pair, token: tokenIs0 ? reserves.reserve0 : reserves.reserve1, wpls: tokenIs0 ? reserves.reserve1 : reserves.reserve0 };
    }),
  );
  return found.filter((pool): pool is Pool => pool !== null && pool.token > 0n && pool.wpls > 0n);
};

/**
 * The weighted median of values: sorted by value, then by key (pool address), it is the first value at which the running
 * weight reaches half the total (so with weight split evenly, the lower value).
 *
 * @param entries Each value with its weight and key.
 */
export const weightedMedian = <T extends { readonly value: bigint; readonly weight: bigint; readonly key: Address }>(entries: readonly T[]): T["value"] | null => weightedMedianEntry(entries)?.value ?? null;

const weightedMedianEntry = <T extends { readonly value: bigint; readonly weight: bigint; readonly key: Address }>(entries: readonly T[]): T | null => {
  const sorted = entries.filter((entry) => entry.weight > 0n).sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : byAddress(a.key, b.key)));
  const total = sorted.reduce((sum, entry) => sum + entry.weight, 0n);
  let running = 0n;
  for (const entry of sorted) {
    running += entry.weight;
    if (2n * running >= total) return entry;
  }
  return null;
};

/**
 * PLS in dollars at the reader's block: the median of each stable pool's price, weighted by its stable side (in whole
 * dollars, at 18 decimals), or null.
 */
export const plsUsd = async (reader: PoolReader): Promise<PriceQuote | null> => {
  const entries = (
    await Promise.all(
      STABLES.map(async (stable) =>
        (await poolsOf(reader, stable.address)).map((pool) => ({
          value: (pool.token * E18 * E18) / (10n ** BigInt(stable.decimals) * pool.wpls),
          weight: pool.token * 10n ** BigInt(18 - stable.decimals),
          key: pool.pair,
        })),
      ),
    )
  ).flat();
  const median = weightedMedianEntry(entries);
  return median === null ? null : { usdE18: median.value, block: reader.block, pool: median.key };
};

/**
 * A PulseChain token's price: its deepest WPLS pool (ties to the lower pool address) times PLS/USD, when the WPLS side is
 * worth at least {@link MINIMUM_DEPTH_USD}; else null.
 *
 * @throws When the PLS quote was read at another block than the reader's.
 */
export const tokenUsd = async (reader: PoolReader, token: Address, decimals: number, pls: PriceQuote): Promise<PriceQuote | null> => {
  if (pls.block !== reader.block) throw new Error(`the PLS price is from block ${pls.block}, the reader reads block ${reader.block}`);
  if (lower(token) === lower(WPLS)) return pls;
  const deepest = (await poolsOf(reader, token)).sort((a, b) => (a.wpls > b.wpls ? -1 : a.wpls < b.wpls ? 1 : byAddress(a.pair, b.pair)))[0];
  if (deepest === undefined || deepest.wpls * pls.usdE18 < BigInt(MINIMUM_DEPTH_USD) * E18 * E18) return null;
  return { usdE18: (deepest.wpls * 10n ** BigInt(decimals) * pls.usdE18) / (deepest.token * E18), block: reader.block, pool: deepest.pair };
};

/** A price as a number, for display only. */
export const priceNumber = (quote: PriceQuote): number => Number(quote.usdE18) / 1e18;

/**
 * The PulseChain token whose pools price a token, from the known table: itself on PulseChain; on Ethereum, its known
 * Omnibridge copy; a zkb.fi token takes its origin's. Null on a testnet or when there is no known copy. Prefer
 * {@link resolvePricingAddress}, which asks the Omnibridge at the reader's block.
 *
 * @param token The token's chain, address, and origin (chain and address) when zkb.fi minted it.
 */
export const pricingAddress = (token: { readonly chainId: number; readonly address: Address; readonly origin?: { readonly chainId: number; readonly address: Address } | null }): Address | null => {
  const subject = token.origin ?? { chainId: token.chainId, address: token.address };
  if (TESTNETS.has(token.chainId) || TESTNETS.has(subject.chainId)) return null;
  if (subject.chainId === 369) return subject.address;
  if (subject.chainId === 1) return PULSECHAIN_COPY_OF[lower(subject.address)] ?? null;
  return null;
};

/**
 * The PulseChain token whose pools price a token, reversing an Ethereum token out through the current Omnibridge
 * (`bridgedTokenAddress` at the reader's block); the known table when the reader cannot ask or the bridge has no copy.
 */
export const resolvePricingAddress = async (
  token: { readonly chainId: number; readonly address: Address; readonly origin?: { readonly chainId: number; readonly address: Address } | null },
  reader: PoolReader,
): Promise<Address | null> => {
  const subject = token.origin ?? { chainId: token.chainId, address: token.address };
  if (subject.chainId === 1 && !TESTNETS.has(token.chainId)) {
    const copy = reader.bridgedCopyOf === undefined ? null : await reader.bridgedCopyOf(subject.address);
    if (copy !== null) return copy;
  }
  return pricingAddress(token);
};

/** A dollar value as text, for display: "1,234.56", or small values with significant digits. */
export const usdText = (value: number): string =>
  value >= 1 ? value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : value.toPrecision(3).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");

/** Where a native coin's dollar price came from. */
export type NativePriceSource = "pulsex-pls-usd" | "pulsex-weth-copy";

/**
 * A native coin's dollar price at the reader's PulseChain block, with its source; null where there is no real price
 * (testnets, never invented). PLS is PLS/USD; ETH is WETH from Ethereum (its Omnibridge copy) on PulseX. For a past
 * Ethereum transaction, pin the reader to the PulseChain block nearest its timestamp ({@link nearestBlockAt}).
 *
 * @param reader PulseChain pools, read at one block.
 * @param chainId The chain whose coin paid.
 */
export const nativeUsd = async (reader: PoolReader, chainId: number): Promise<(PriceQuote & { readonly source: NativePriceSource }) | null> => {
  if (chainId !== 369 && chainId !== 1) return null;
  const pls = await plsUsd(reader);
  if (pls === null) return null;
  if (chainId === 369) return { ...pls, source: "pulsex-pls-usd" };
  // WETH is in the known table, so it always resolves.
  const weth = (await resolvePricingAddress({ chainId: 1, address: WETH_ETHEREUM }, reader)) as Address;
  const quote = await tokenUsd(reader, weth, 18, pls);
  return quote === null ? null : { ...quote, source: "pulsex-weth-copy" };
};

/** Reads block timestamps: the latest block, and the timestamp of any block. */
export type BlockClock = {
  readonly latest: () => Promise<{ readonly number: bigint; readonly timestamp: bigint }>;
  readonly timestampOf: (block: bigint) => Promise<bigint>;
};

/**
 * The block whose timestamp is nearest a time, by binary search between `firstBlock` and the latest block; a tie goes
 * to the earlier block. Used to price a past Ethereum cost at the matching PulseChain block.
 *
 * @param timestamp The time, in seconds.
 * @param clock The chain's blocks.
 * @param firstBlock The earliest block to consider.
 */
export const nearestBlockAt = async (timestamp: bigint, clock: BlockClock, firstBlock: bigint): Promise<bigint> => {
  const latest = await clock.latest();
  if (timestamp >= latest.timestamp) return latest.number;
  let low = firstBlock;
  let high = latest.number;
  if (timestamp <= (await clock.timestampOf(low))) return low;
  // Invariant: timestampOf(low) < timestamp ≤ timestampOf(high).
  while (high - low > 1n) {
    const middle = (low + high) / 2n;
    if ((await clock.timestampOf(middle)) < timestamp) low = middle;
    else high = middle;
  }
  const below = timestamp - (await clock.timestampOf(low));
  const above = (await clock.timestampOf(high)) - timestamp;
  return above < below ? high : low;
};

const FACTORY_ABI = [{ type: "function", name: "getPair", stateMutability: "view", inputs: [{ name: "", type: "address" }, { name: "", type: "address" }], outputs: [{ name: "", type: "address" }] }] as const;
const PAIR_ABI = [
  { type: "function", name: "getReserves", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint112" }, { name: "", type: "uint112" }, { name: "", type: "uint32" }] },
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
] as const;
const OMNIBRIDGE_ABI = [{ type: "function", name: "bridgedTokenAddress", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "address" }] }] as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** The one call a pool reader needs: viem's `readContract` (a public client, or Ponder's client). */
export type ContractCaller = {
  readonly readContract: (call: { readonly address: Address; readonly abi: readonly unknown[]; readonly functionName: string; readonly args?: readonly unknown[]; readonly blockNumber?: bigint }) => Promise<unknown>;
};

/**
 * A pool reader over a contract caller, every call pinned to `block`. A call that fails reads as no pool or no copy.
 *
 * @param client The caller (on PulseChain).
 * @param block The block to read at.
 */
export const poolReaderOver = (client: ContractCaller, block: bigint): PoolReader => {
  const address = async (call: Parameters<ContractCaller["readContract"]>[0]): Promise<Address | null> => {
    const result = (await client.readContract({ ...call, blockNumber: block }).catch(() => ZERO_ADDRESS)) as Address;
    return lower(result) === ZERO_ADDRESS ? null : result;
  };
  return {
    block,
    pairOf: (factory, a, b) => address({ address: factory, abi: FACTORY_ABI, functionName: "getPair", args: [a, b] }),
    reservesOf: async (pair) => {
      try {
        const [reserves, token0] = await Promise.all([client.readContract({ address: pair, abi: PAIR_ABI, functionName: "getReserves", blockNumber: block }), client.readContract({ address: pair, abi: PAIR_ABI, functionName: "token0", blockNumber: block })]);
        const [reserve0, reserve1] = reserves as readonly [bigint, bigint, number];
        return { token0: token0 as Address, reserve0, reserve1 };
      } catch {
        return null;
      }
    },
    bridgedCopyOf: (token) => address({ address: OMNIBRIDGE_PULSECHAIN, abi: OMNIBRIDGE_ABI, functionName: "bridgedTokenAddress", args: [token] }),
  };
};
