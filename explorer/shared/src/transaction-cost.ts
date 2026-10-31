/**
 * What a transaction cost, in the chain's coin and in dollars, for the message page's step costs (owner: "note the
 * eth/native transaction costs, not just the gas, and we should also look up the usd cost"). Pure: the price is read by
 * the caller at a named block (`nativeUsd` in `pulsex-oracle.ts`) and passed in.
 */
import type { Hex } from "viem";
import { usdMicroOf } from "./fee-rules.js";
import type { NativePriceSource, PriceQuote } from "./pulsex-oracle.js";

/** One transaction's cost, as the indexer stores it. */
export type TransactionCostRow = {
  readonly chainId: number;
  readonly transactionHash: Hex;
  readonly blockNumber: bigint;
  readonly timestamp: bigint;
  readonly gasUsed: bigint;
  readonly effectiveGasPrice: bigint;
  /** gasUsed × effectiveGasPrice, in wei of the chain's coin. */
  readonly costWei: bigint;
  /** One coin in USD × 1e18, or null without a price. */
  readonly usdPerNativeE18: bigint | null;
  /** The PulseChain block the price was read at, or null. */
  readonly priceBlock: bigint | null;
  readonly priceSource: NativePriceSource | null;
  /** The cost in micro-dollars, rounded down, or null. */
  readonly costMicroUsd: bigint | null;
};

/**
 * A transaction's cost row from its receipt and the coin's price.
 *
 * @param input The transaction, its gas, and the price (null on testnets or when no pool answered).
 */
export const transactionCostRow = (input: {
  readonly chainId: number;
  readonly transactionHash: Hex;
  readonly blockNumber: bigint;
  readonly timestamp: bigint;
  readonly gasUsed: bigint;
  readonly effectiveGasPrice: bigint;
  readonly price: (PriceQuote & { readonly source: NativePriceSource }) | null;
}): TransactionCostRow => {
  const { price, ...rest } = input;
  const costWei = input.gasUsed * input.effectiveGasPrice;
  return {
    ...rest,
    costWei,
    usdPerNativeE18: price?.usdE18 ?? null,
    priceBlock: price?.block ?? null,
    priceSource: price?.source ?? null,
    costMicroUsd: price === null ? null : usdMicroOf(costWei, 18, price.usdE18),
  };
};

/** A transaction's cost in an API answer: integers as decimal strings. */
export type CostView = {
  readonly chainId: number;
  readonly transactionHash: Hex;
  readonly gasUsed: string;
  readonly effectiveGasPrice: string;
  readonly costWei: string;
  /** One coin in USD × 1e18. */
  readonly usdPerNative: string | null;
  readonly costMicroUsd: string | null;
  readonly priceBlock: string | null;
  readonly priceSource: NativePriceSource | null;
};

/** The step costs of one message: its send, its delivery, and the proof (shared by the messages it covered). */
export type MessageCosts = {
  readonly sent: CostView | null;
  readonly delivered: CostView | null;
  readonly proof: (CostView & { readonly coveredMessages: number }) | null;
};

const text = (value: bigint | null): string | null => (value === null ? null : value.toString());

/**
 * A stored cost row as the API shows it, or null.
 *
 * @param row The row, or null.
 */
export const costView = (row: TransactionCostRow | null): CostView | null =>
  row === null
    ? null
    : {
        chainId: row.chainId,
        transactionHash: row.transactionHash,
        gasUsed: row.gasUsed.toString(),
        effectiveGasPrice: row.effectiveGasPrice.toString(),
        costWei: row.costWei.toString(),
        usdPerNative: text(row.usdPerNativeE18),
        costMicroUsd: text(row.costMicroUsd),
        priceBlock: text(row.priceBlock),
        priceSource: row.priceSource,
      };
