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
import {
  MINIMUM_DEPTH_USD,
  OMNIBRIDGE_PULSECHAIN,
  PULSECHAIN_COPY_OF,
  PULSEX_FACTORIES,
  STABLES,
  TESTNETS,
  WETH_ETHEREUM,
  WPLS,
  plsQuoteOf,
  poolOf,
  pricingAddress,
  stablePoolEntry,
  tokenQuoteOf,
  weightedMedian,
  type Pool,
  type PriceQuote,
  type PricedToken,
  type Reserves,
} from "@zkb/core";

// The constants, the types and the pure price maths moved to @zkb/core; they keep their old path here.
export { MINIMUM_DEPTH_USD, OMNIBRIDGE_PULSECHAIN, PULSECHAIN_COPY_OF, PULSEX_FACTORIES, STABLES, TESTNETS, WETH_ETHEREUM, WPLS, pricingAddress, weightedMedian };
export type { PriceQuote, Reserves };

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

const lower = (address: Address): string => address.toLowerCase();

/** The pools of a token against WPLS on both factories. */
const poolsOf = async (reader: PoolReader, token: Address): Promise<Pool[]> => {
  const found = await Promise.all(
    PULSEX_FACTORIES.map(async (factory): Promise<Pool | null> => {
      const pair = await reader.pairOf(factory, token, WPLS);
      if (pair === null) return null;
      const reserves = await reader.reservesOf(pair);
      if (reserves === null) return null;
      return poolOf(pair, token, reserves);
    }),
  );
  return found.filter((pool): pool is Pool => pool !== null);
};

/**
 * PLS in dollars at the reader's block: the median of each stable pool's price, weighted by its stable side (in whole
 * dollars, at 18 decimals), or null.
 */
export const plsUsd = async (reader: PoolReader): Promise<PriceQuote | null> =>
  plsQuoteOf(
    (await Promise.all(STABLES.map(async (stable) => (await poolsOf(reader, stable.address)).map((pool) => stablePoolEntry(pool, stable.decimals))))).flat(),
    reader.block,
  );

/**
 * A PulseChain token's price: its deepest WPLS pool (ties to the lower pool address) times PLS/USD, when the WPLS side is
 * worth at least {@link MINIMUM_DEPTH_USD}; else null.
 *
 * @throws When the PLS quote was read at another block than the reader's.
 */
export const tokenUsd = async (reader: PoolReader, token: Address, decimals: number, pls: PriceQuote): Promise<PriceQuote | null> => {
  if (pls.block !== reader.block) throw new Error(`the PLS price is from block ${pls.block}, the reader reads block ${reader.block}`);
  if (lower(token) === lower(WPLS)) return pls;
  return tokenQuoteOf(await poolsOf(reader, token), decimals, pls, reader.block);
};

/** A price as a number, for display only. */
export const priceNumber = (quote: PriceQuote): number => Number(quote.usdE18) / 1e18;

/**
 * The PulseChain token whose pools price a token, reversing an Ethereum token out through the current Omnibridge
 * (`bridgedTokenAddress` at the reader's block); the known table when the reader cannot ask or the bridge has no copy.
 */
export const resolvePricingAddress = async (
  token: PricedToken,
  reader: PoolReader,
): Promise<Address | null> => {
  const subject = token.origin ?? { chainId: token.chainId, address: token.address };
  if (subject.chainId === 1 && !TESTNETS.has(token.chainId)) {
    const copy = reader.bridgedCopyOf === undefined ? null : await reader.bridgedCopyOf(subject.address);
    if (copy !== null) return copy;
  }
  return pricingAddress(token);
};

/**
 * A dollar value as text, for display: two decimals from one cent ("1,234.56", "0.50"; under $1 cut, not rounded), and
 * under a cent three significant digits ("0.0000562"), which the page then shows with the leading-zeros rule.
 */
export const usdText = (value: number): string => {
  if (value >= 1) return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (value >= 0.01) return value.toFixed(6).slice(0, -4);
  return value.toPrecision(3).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
};

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
    const result = await client.readContract({ ...call, blockNumber: block }).catch(() => ZERO_ADDRESS);
    return typeof result !== "string" || lower(result as Address) === ZERO_ADDRESS ? null : (result as Address);
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
