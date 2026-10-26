import { describe, expect, it } from "vitest";
import { planBatches } from "../../src/runner/batch-plan.ts";

const items = (gases: readonly bigint[]) => gases.map((assumedGas, index) => ({ id: index + 1, assumedGas }));
const idsOf = (batches: ReadonlyArray<ReadonlyArray<{ id: number }>>) => batches.map((batch) => batch.map((item) => item.id));

describe("the plan of batches", () => {
  it("puts everything in one batch when both limits allow it", () => {
    expect(idsOf(planBatches(items([1n, 1n, 1n]), { maximumBatchSize: 5, maximumBatchGas: 10n }))).toEqual([[1, 2, 3]]);
  });

  it("starts a new batch when the size limit is reached, and keeps the order", () => {
    expect(idsOf(planBatches(items([1n, 1n, 1n, 1n, 1n]), { maximumBatchSize: 2, maximumBatchGas: 100n }))).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("starts a new batch when the next item would pass the gas limit, and allows a sum equal to the limit", () => {
    expect(idsOf(planBatches(items([4n, 4n, 4n]), { maximumBatchSize: 5, maximumBatchGas: 8n }))).toEqual([[1, 2], [3]]);
    expect(idsOf(planBatches(items([4n, 5n]), { maximumBatchSize: 5, maximumBatchGas: 8n }))).toEqual([[1], [2]]);
  });

  it("gives an item that is above the gas limit alone a batch of its own, so that it is not lost", () => {
    expect(idsOf(planBatches(items([1n, 50n, 1n]), { maximumBatchSize: 5, maximumBatchGas: 10n }))).toEqual([[1], [2], [3]]);
  });

  it("makes no batch from no items", () => {
    expect(planBatches([], { maximumBatchSize: 5, maximumBatchGas: 10n })).toEqual([]);
  });
});
