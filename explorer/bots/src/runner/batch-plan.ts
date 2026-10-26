/** The limits of one batch. */
export interface BatchLimits {
  /** The most items in one batch. */
  readonly maximumBatchSize: number;
  /** The most gas that the items of one batch may assume together. */
  readonly maximumBatchGas: bigint;
}

/**
 * Splits items into as few batches as the limits allow, and keeps their order. The first item that would break a limit
 * starts the next batch, so the oldest items always go in the first batch. An item whose own assumed gas is above the
 * gas limit still gets a batch of its own: the simulation decides then, and nothing splits it further.
 */
export function planBatches<Item extends { readonly assumedGas: bigint }>(items: readonly Item[], limits: BatchLimits): Item[][] {
  const batches: Item[][] = [];
  let current: Item[] = [];
  let currentGas = 0n;
  for (const item of items) {
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
  return batches;
}
