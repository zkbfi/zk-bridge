import { getAbiItem, toEventSelector, type Address, type Hex } from "viem";
import { messageBridgeAbi } from "./abis/index.js";
import type { DeliveryCostReport, DeliveryKind, DeliveryKindReport } from "./delivery-cost-report.js";
import { proofCostWei } from "./delivery-fee.js";
import type { DeliveryCostSettings } from "./delivery-cost-settings.js";

/** The topic of the `AffirmationCompleted` event of the bridge, taken from the interface. */
export const AFFIRMATION_COMPLETED_SELECTOR: Hex = toEventSelector(
  getAbiItem({ abi: messageBridgeAbi, name: "AffirmationCompleted" }),
);

/** The part of a receipt log that this module reads. */
export type ReceiptLog = { readonly address: Address; readonly topics: readonly (Hex | null | undefined)[] };

/**
 * Counts the `AffirmationCompleted` logs of the bridge in a transaction receipt.
 *
 * @param logs The logs of the receipt.
 * @param bridge The address of the bridge on this chain.
 */
export const countDeliveriesInReceipt = (logs: readonly ReceiptLog[], bridge: Address): number =>
  logs.filter(
    (log) => log.address.toLowerCase() === bridge.toLowerCase() && log.topics[0]?.toLowerCase() === AFFIRMATION_COMPLETED_SELECTOR,
  ).length;

/**
 * Tells whether the gas of a transaction belongs to one delivery. A batch transaction holds several deliveries, and its
 * gas cannot be split between them, so the indexer records no cost for it.
 *
 * @param logs The logs of the receipt.
 * @param bridge The address of the bridge on this chain.
 */
export const isSingleDelivery = (logs: readonly ReceiptLog[], bridge: Address): boolean =>
  countDeliveriesInReceipt(logs, bridge) === 1;

/** What the indexer knows about a delivered message, from its `messages` row and its `transfers` row. */
export type DeliveryFacts = {
  /** The `kind` of the `messages` row, or null when the message has no row. */
  readonly messageKind: string | null;
  /** True when the send has been indexed. Before that, `messageKind` is the placeholder `message` and means nothing. */
  readonly sendIndexed: boolean;
  /** `hasCallback` of the `transfers` row, or null when the message has no transfer row. */
  readonly hasCallback: boolean | null;
};

/**
 * Classifies a delivery. The send and the delivery arrive in either order, and the delivery creates the `messages` row
 * with the default kind `message`. So the kind counts only once the send is indexed. Before that the delivery cannot be
 * classified and the function returns null: the report skips it until the send arrives. A `token` message needs its
 * transfer row, because only the transfer row tells whether it has a callback.
 *
 * @param facts What is known about the message.
 * @returns The kind, or null when the delivery cannot be classified yet.
 */
export const classifyDelivery = (facts: DeliveryFacts): DeliveryKind | null => {
  if (!facts.sendIndexed || facts.messageKind === null) return null;
  if (facts.messageKind !== "token") return "message";
  if (facts.hasCallback === null) return null;
  return facts.hasCallback ? "token_callback" : "token";
};

/**
 * The mean of the values, rounded half up.
 *
 * @param values Gas figures.
 * @returns The mean, or null for an empty list.
 */
export const averageRoundingHalfUp = (values: readonly bigint[]): bigint | null => {
  if (values.length === 0) return null;
  const count = BigInt(values.length);
  const sum = values.reduce((total, value) => total + value, 0n);
  return (2n * sum + count) / (2n * count);
};

/**
 * The percentile by nearest rank. The rank is `ceil(count * percentile / 100)`, computed in integers with the division
 * rounded up, so a small list never truncates to rank zero. The result is one of the samples, so it is a whole number.
 *
 * @param values Gas figures, in any order.
 * @param percentile A whole number from 1 to 100.
 * @returns The value at that rank, or null for an empty list.
 * @throws When the percentile is not a whole number from 1 to 100.
 */
export const percentileNearestRank = (values: readonly bigint[], percentile: number): bigint | null => {
  if (!Number.isInteger(percentile) || percentile < 1 || percentile > 100) {
    throw new RangeError(`the percentile must be a whole number from 1 to 100, not ${percentile}`);
  }
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => Number(left - right > 0n) - Number(left - right < 0n));
  const rank = (BigInt(values.length) * BigInt(percentile) + 99n) / 100n;
  // The rank is from 1 to the number of values, so the element exists.
  return sorted[Number(rank) - 1] as bigint;
};

/** The newest base fee row of a chain. */
export type BaseFeeRow = {
  readonly blockNumber: bigint;
  readonly timestamp: bigint;
  readonly baseFeePerGas: bigint | null;
};

/** The inputs of {@link buildDeliveryCostReport}. */
export type BuildReportInput = {
  readonly chainId: number;
  /** The gas used by the newest recorded deliveries of each kind. */
  readonly samples: Readonly<Record<DeliveryKind, readonly bigint[]>>;
  /** The newest `chain_tips` row of the chain, or null before the first block. */
  readonly baseFee: BaseFeeRow | null;
  readonly settings: DeliveryCostSettings;
};

const kindReport = (samples: readonly bigint[], defaultGas: bigint): DeliveryKindReport => ({
  sampleCount: samples.length,
  averageGas: averageRoundingHalfUp(samples)?.toString() ?? null,
  p90Gas: percentileNearestRank(samples, 90)?.toString() ?? null,
  defaultGas: defaultGas.toString(),
  isDefault: samples.length === 0,
});

/**
 * Builds the answer of `GET /api/delivery-cost` for one chain.
 *
 * @param input The samples, the latest base fee and the settings.
 * @returns A value that `parseDeliveryCostReport` accepts.
 */
export const buildDeliveryCostReport = (input: BuildReportInput): DeliveryCostReport => {
  const { settings, baseFee } = input;
  const nativeCoinPriceUsd = settings.nativeCoinPriceUsdByChain[input.chainId] ?? null;
  const wei =
    nativeCoinPriceUsd === null
      ? null
      : proofCostWei({
          proofCostUsd: settings.proofCostUsd,
          nativeCoinPriceUsd,
          deliveriesPerProof: settings.deliveriesPerProof,
        }).toString();
  return {
    chainId: input.chainId,
    baseFee: {
      wei: baseFee?.baseFeePerGas?.toString() ?? null,
      blockNumber: baseFee === null ? null : Number(baseFee.blockNumber),
      timestamp: baseFee === null ? null : Number(baseFee.timestamp),
    },
    proofCost: {
      usd: settings.proofCostUsd,
      nativeCoinPriceUsd,
      deliveriesPerProof: settings.deliveriesPerProof,
      wei,
      isEstimate: true,
    },
    kinds: {
      token_callback: kindReport(input.samples.token_callback, settings.defaultGas),
      token: kindReport(input.samples.token, settings.defaultGas),
      message: kindReport(input.samples.message, settings.defaultGas),
    },
  };
};
