/**
 * The price oracle (owner: "find an oracle. i think that the pulsex exchanges serve as good oracles"). The reads and
 * the price states are `@zkb/core` (`token-pricing.ts`), the one price source of the dapp, the backend and the runner;
 * this module keeps their old import path and adds the display helpers and the block search of the indexer.
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
import {
  MINIMUM_DEPTH_USD,
  OMNIBRIDGE_PULSECHAIN,
  PULSECHAIN_COPY_OF,
  PULSEX_FACTORIES,
  STABLES,
  TESTNETS,
  WETH_ETHEREUM,
  WPLS,
  nativeUsd,
  plsUsd,
  poolReaderOver,
  pricingAddress,
  resolvePricingAddress,
  tokenUsd,
  weightedMedian,
  type ContractCaller,
  type NativePriceSource,
  type PoolReader,
  type PriceQuote,
  type Reserves,
} from "@zkb/core";

// The price maths and the pool reads moved to @zkb/core (`pulsex-pricing.ts`, `token-pricing.ts`), the one price source
// of the dapp, the backend and the runner; they keep their old path here.
export { MINIMUM_DEPTH_USD, OMNIBRIDGE_PULSECHAIN, PULSECHAIN_COPY_OF, PULSEX_FACTORIES, STABLES, TESTNETS, WETH_ETHEREUM, WPLS, nativeUsd, plsUsd, poolReaderOver, pricingAddress, resolvePricingAddress, tokenUsd, weightedMedian };
export type { ContractCaller, NativePriceSource, PoolReader, PriceQuote, Reserves };

/** A price as a number, for display only. */
export const priceNumber = (quote: PriceQuote): number => Number(quote.usdE18) / 1e18;

/**
 * A dollar value as text, for display: two decimals from one cent ("1,234.56", "0.50"; under $1 cut, not rounded), and
 * under a cent three significant digits ("0.0000562"), which the page then shows with the leading-zeros rule.
 */
export const usdText = (value: number): string => {
  if (value >= 1) return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (value >= 0.01) return value.toFixed(6).slice(0, -4);
  return value.toPrecision(3).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
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
