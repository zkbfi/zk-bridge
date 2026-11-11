/**
 * The gas one delivery is counted at in the watcher's profit rule. Until the destination chain has shown enough real
 * deliveries it is the start figure (`deploy/gas-defaults.json`, 500,000 gas: above the measured 469,247 of a plain
 * token delivery to a new recipient and 452,134 to an existing holder, below the 552,261 of the first delivery through
 * the delivery router). From then on it follows reality: the 90th percentile of the gas of the newest deliveries through
 * the router that the indexer recorded (`GET /api/delivery-cost`, up to 200 receipts; a batch transaction has no row).
 * The percentile is not floored at the start figure (the point is to follow what deliveries really cost) and not
 * capped: a 90th percentile already holds a single outlier batch back.
 */
import { deliveryCostReportSchema, type DeliveryCostReport, type DeliveryKindReport } from "@zk-bridge/shared";
import type { Logger } from "../logger.ts";
import type { JsonGet } from "../keepalive/sources.ts";

/** How many recorded deliveries it takes before their percentile replaces the start figure. */
export const MEASURED_SAMPLES_MINIMUM = 10;

/** The gas to count, where it came from, and how many deliveries the report held. */
export type DeliveryGasChoice = { readonly gas: bigint; readonly source: "measured" | "start"; readonly sampleCount: number };

/**
 * Chooses the gas of one delivery. Pure: the same report and start figure always give the same answer.
 *
 * @param measured The indexer's report of the deliveries of one kind, or null when it could not be read.
 * @param start The start figure.
 * @returns The 90th percentile when the report holds at least {@link MEASURED_SAMPLES_MINIMUM} deliveries, else the start figure.
 */
export function chooseDeliveryGas(measured: Pick<DeliveryKindReport, "sampleCount" | "p90Gas"> | null, start: bigint): DeliveryGasChoice {
  const sampleCount = measured?.sampleCount ?? 0;
  const p90 = measured?.p90Gas == null ? 0n : BigInt(measured.p90Gas);
  if (sampleCount < MEASURED_SAMPLES_MINIMUM || p90 === 0n) return { gas: start, source: "start", sampleCount };
  return { gas: p90, source: "measured", sampleCount };
}

/** The choice from a report: the deliveries through the delivery router (`token_callback`), the ones that pay a fee. */
export const deliveryGasFromReport = (report: DeliveryCostReport, start: bigint): DeliveryGasChoice => chooseDeliveryGas(report.kinds.token_callback, start);

/**
 * Builds the reader of the gas of one delivery on one destination chain. It never throws: when the indexer cannot be
 * read it answers the start figure and logs why. It logs the source each time it changes.
 */
export function createDeliveryGasReader(input: {
  readonly indexerUrl: string;
  readonly chainId: number;
  readonly get: JsonGet;
  readonly logger: Logger;
  readonly start: bigint;
}): () => Promise<bigint> {
  const base = input.indexerUrl.replace(/\/+$/, "");
  const { start } = input;
  let last = "";
  const answer = (choice: DeliveryGasChoice): bigint => {
    const key = `${choice.source}:${choice.gas}`;
    if (key !== last) input.logger.info("watch_delivery_gas", { chainId: input.chainId, source: choice.source, gas: choice.gas, sampleCount: choice.sampleCount });
    last = key;
    return choice.gas;
  };
  return async () => {
    try {
      const reply = await input.get(`${base}/api/delivery-cost?chainId=${input.chainId}`);
      if (reply.status !== 200) throw new Error(`the chain indexer answered ${reply.status} for the delivery costs`);
      const parsed = deliveryCostReportSchema.safeParse(reply.body);
      if (!parsed.success) throw new Error("the chain indexer sent the delivery costs in an unknown shape");
      return answer(deliveryGasFromReport(parsed.data, start));
    } catch (error) {
      input.logger.warn("watch_delivery_gas_unreadable", { chainId: input.chainId, why: error instanceof Error ? error.message : String(error), gas: start });
      last = `start:${start}`;
      return start;
    }
  };
}
