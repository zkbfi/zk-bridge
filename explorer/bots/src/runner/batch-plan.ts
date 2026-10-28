/** The limits of one batch. */
export interface BatchLimits {
  /** The most items in one batch. */
  readonly maximumBatchSize: number;
  /** The most gas that the items of one batch may assume together. */
  readonly maximumBatchGas: bigint;
}

/** The result of {@link planBatches}. */
export interface BatchPlan<Item> {
  /** The batches, oldest items first. The assumed gas of each batch adds up to at most `maximumBatchGas`. */
  readonly batches: Item[][];
  /** The items whose own assumed gas is above `maximumBatchGas`. No batch holds them: the caller sends each one alone. */
  readonly oversize: Item[];
}

/**
 * Splits items into as few batches as the limits allow, and keeps their order. The first item that would break a limit
 * starts the next batch, so the oldest items always go in the first batch. An item whose own assumed gas is above the
 * gas limit never goes in a batch: it is returned apart, because no batch can hold it without passing the limit.
 */
export function planBatches<Item extends { readonly assumedGas: bigint }>(items: readonly Item[], limits: BatchLimits): BatchPlan<Item> {
  const batches: Item[][] = [];
  const oversize: Item[] = [];
  let current: Item[] = [];
  let currentGas = 0n;
  for (const item of items) {
    if (item.assumedGas > limits.maximumBatchGas) {
      oversize.push(item);
      continue;
    }
    const fits = current.length < limits.maximumBatchSize && currentGas + item.assumedGas <= limits.maximumBatchGas;
    if (!fits && current.length > 0) {
      batches.push(current);
      current = [];
      currentGas = 0n;
    }
    current.push(item);
    currentGas += item.assumedGas;
  }
  if (current.length > 0) batches.push(current);
  return { batches, oversize };
}
