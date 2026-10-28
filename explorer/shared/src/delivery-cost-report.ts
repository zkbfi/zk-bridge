import { z } from "zod";

/**
 * The answer of `GET /api/delivery-cost`. The indexer builds it. The terminal dashboard and the web interface read it
 * with {@link parseDeliveryCostReport}, so all three agree on the shape. Amounts of gas and wei are decimal strings,
 * because they can pass 2^53. A figure improves by itself: the more deliveries the indexer records, the more samples
 * the report holds, and no client changes.
 */

/** The kinds of delivery that the indexer measures separately. */
export const DELIVERY_KINDS = ["token_callback", "token", "message"] as const;

/** A token delivery with a callback (through the delivery router), a plain token delivery, or a message with no tokens. */
export type DeliveryKind = (typeof DELIVERY_KINDS)[number];

const amountText = z.string().regex(/^\d+$/);

const kindReport = z.object({
  /** How many recorded deliveries of this kind the figures come from. */
  sampleCount: z.number().int().nonnegative(),
  /** Mean gas used by the transaction. Null when there are no samples. */
  averageGas: amountText.nullable(),
  /** The 90th percentile of gas used by the transaction, rounded up. Null when there are no samples. */
  p90Gas: amountText.nullable(),
  /** The configured default gas (`EXPLORER_DEFAULT_DELIVERY_GAS`). It applies when `sampleCount` is zero. */
  defaultGas: amountText,
  /** True when the report has no samples, so `defaultGas` is the figure to use and it is a default, not a measure. */
  isDefault: z.boolean(),
});

/** The report of one chain. */
export const deliveryCostReportSchema = z.object({
  chainId: z.number().int(),
  baseFee: z.object({
    /** The base fee of the latest block that the indexer saw, in wei per gas. Null before the first block. */
    wei: amountText.nullable(),
    blockNumber: z.number().int().nullable(),
    /** The timestamp of that block, in seconds. */
    timestamp: z.number().int().nullable(),
  }),
  kinds: z.object({ token_callback: kindReport, token: kindReport, message: kindReport }),
});

/** The report of one chain, as the indexer sends it. */
export type DeliveryCostReport = z.infer<typeof deliveryCostReportSchema>;

/** The report of one kind. */
export type DeliveryKindReport = z.infer<typeof kindReport>;

/**
 * Checks a parsed JSON value.
 *
 * @param value The JSON of the response.
 * @throws When the value does not match the report.
 */
export const parseDeliveryCostReport = (value: unknown): DeliveryCostReport => deliveryCostReportSchema.parse(value);
