import { describe, expect, it } from "vitest";
import { planBatches } from "../../src/runner/batch-plan.ts";

const items = (gases: readonly bigint[]) => gases.map((assumedGas, index) => ({ id: index + 1, assumedGas }));
const idsOf = (plan: { batches: ReadonlyArray<ReadonlyArray<{ id: number }>> }) => plan.batches.map((batch) => batch.map((item) => item.id));

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

  it("never packs an item whose required gas exceeds the batch maximum", () => {
    const plan = planBatches(items([1n, 50n, 1n]), { maximumBatchSize: 5, maximumBatchGas: 10n });
    expect(idsOf(plan)).toEqual([[1, 3]]);
    expect(plan.oversize.map((item) => item.id)).toEqual([2]);
  });

  it("keeps the sum of assumed gas in every batch at or under maximumBatchGas", () => {
    const gases = [3n, 7n, 5n, 5n, 9n, 11n, 1n, 2n, 10n, 4n];
    const plan = planBatches(items(gases), { maximumBatchSize: 4, maximumBatchGas: 10n });
    for (const batch of plan.batches) expect(batch.reduce((sum, item) => sum + item.assumedGas, 0n) <= 10n).toBe(true);
    expect(plan.oversize.map((item) => item.assumedGas)).toEqual([11n]);
    expect(plan.batches.flat()).toHaveLength(gases.length - 1);
  });

  it("makes no batch from no items", () => {
    expect(planBatches([], { maximumBatchSize: 5, maximumBatchGas: 10n })).toEqual({ batches: [], oversize: [] });
  });
});
