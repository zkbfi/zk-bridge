/**
 * What a transaction cost, in the chain's coin and in dollars, for the message page's step costs (owner: "note the
 * eth/native transaction costs, not just the gas, and we should also look up the usd cost"). Pure: the price is read by
 * the caller at a named block (`nativeUsd` in `pulsex-oracle.ts`) and passed in.
 */
import type { Hex } from "viem";
import { z } from "zod";
import { usdOf } from "./fee-rules.js";
import type { NativePriceSource, PriceQuote } from "./pulsex-oracle.js";

const decimal = z.string().regex(/^\d+$/);

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
  /** The cost in USD × 1e18, rounded down, or null. */
  readonly costUsd: bigint | null;
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
    costUsd: price === null ? null : usdOf(costWei, 18, price.usdE18),
  };
};

/**
 * A transaction's cost as the indexer serves it (`GET /api/tx/:chainId/:hash`, and each step of a message's `costs`):
 * integers as decimal strings, USD scaled by 1e18 (`costUsd`, and `nativeUsd.usd`: one coin).
 */
export const costViewSchema = z.object({
  chainId: z.number().int(),
  hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  block: decimal,
  gasUsed: decimal,
  effectiveGasPriceWei: decimal,
  costWei: decimal,
  costUsd: decimal.nullable(),
  nativeUsd: z.object({ usd: decimal, source: z.enum(["pulsex-pls-usd", "pulsex-weth-copy"]), priceBlock: decimal }).nullable(),
});

/** A transaction's cost in an API answer. */
export type CostView = z.infer<typeof costViewSchema>;

/** The step costs of one message: its send, its delivery, and the proof (shared by the messages it covered). */
export const messageCostsSchema = z.object({
  sent: costViewSchema.nullable(),
  delivered: costViewSchema.nullable(),
  proof: costViewSchema.extend({ coveredMessages: z.number().int() }).nullable(),
});

/** The step costs of one message. */
export type MessageCosts = z.infer<typeof messageCostsSchema>;

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
        hash: row.transactionHash,
        block: row.blockNumber.toString(),
        gasUsed: row.gasUsed.toString(),
        effectiveGasPriceWei: row.effectiveGasPrice.toString(),
        costWei: row.costWei.toString(),
        costUsd: row.costUsd === null ? null : row.costUsd.toString(),
        nativeUsd:
          row.usdPerNativeE18 === null || row.priceSource === null || row.priceBlock === null
            ? null
            : { usd: row.usdPerNativeE18.toString(), source: row.priceSource, priceBlock: row.priceBlock.toString() },
      };
