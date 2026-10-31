import { describe, expect, it } from "vitest";
import { createSerialQueue, mapWithLimit } from "../src/rpc/concurrency.js";

describe("mapWithLimit", () => {
  it("keeps the order of the results and never runs more calls than the limit", async () => {
    let running = 0;
    let highest = 0;
    const results = await mapWithLimit([1, 2, 3, 4, 5, 6], 2, async (value, index) => {
      running += 1;
      highest = Math.max(highest, running);
      await new Promise((resolve) => setTimeout(resolve, 6 - value));
      running -= 1;
      return `${index}:${value * 10}`;
    });
    expect(results).toEqual(["0:10", "1:20", "2:30", "3:40", "4:50", "5:60"]);
    expect(highest).toBe(2);
  });

  it("answers an empty list for an empty input", async () => {
    expect(await mapWithLimit([], 3, async () => 1)).toEqual([]);
  });

  it("throws the error of a failed call", async () => {
    await expect(mapWithLimit([1, 2], 1, async (value) => (value === 2 ? Promise.reject(new Error("call failed")) : value))).rejects.toThrow("call failed");
  });
});

describe("createSerialQueue", () => {
  it("runs a task after the earlier tasks end, even when an earlier task fails", async () => {
    const queue = createSerialQueue();
    const order: string[] = [];
    const first = queue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("first");
      throw new Error("first failed");
    });
    const second = queue(async () => {
      order.push("second");
      return "done";
    });
    await expect(first).rejects.toThrow("first failed");
    expect(await second).toBe("done");
    expect(order).toEqual(["first", "second"]);
  });
});
