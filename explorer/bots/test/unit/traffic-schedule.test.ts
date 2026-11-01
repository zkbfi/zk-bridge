import { describe, expect, it } from "vitest";
import { dueAt, jitterOf, slotDue, slotOf, type Schedule } from "../../src/traffic/schedule.ts";

const HOUR = 3_600_000;
const forward: Schedule = { intervalMilliseconds: HOUR, offsetMilliseconds: 0, jitterMilliseconds: 300_000 };
const back: Schedule = { intervalMilliseconds: HOUR, offsetMilliseconds: HOUR / 2, jitterMilliseconds: 300_000 };

describe("the traffic schedule", () => {
  it("numbers the intervals from 1970, shifted by the offset", () => {
    expect(slotOf(0, forward)).toBe(0);
    expect(slotOf(HOUR - 1, forward)).toBe(0);
    expect(slotOf(HOUR, forward)).toBe(1);
    expect(slotOf(HOUR, back)).toBe(0);
    expect(slotOf(HOUR / 2 - 1, back)).toBe(-1);
  });

  it("draws a jitter that a restart keeps, within its bound", () => {
    const jitter = jitterOf("first-to-second", 480_000, 300_000);
    expect(jitter).toBe(jitterOf("first-to-second", 480_000, 300_000));
    expect(jitter).toBeGreaterThanOrEqual(0);
    expect(jitter).toBeLessThanOrEqual(300_000);
    expect(jitterOf("first-to-second", 480_000, 0)).toBe(0);
    const spread = new Set(Array.from({ length: 50 }, (_, slot) => jitterOf("second-to-first", slot, 300_000)));
    expect(spread.size).toBeGreaterThan(40);
  });

  it("puts the two directions half an interval apart", () => {
    const slot = 480_000;
    const first = dueAt("first-to-second", slot, { ...forward, jitterMilliseconds: 0 });
    const second = dueAt("second-to-first", slot, { ...back, jitterMilliseconds: 0 });
    expect(second - first).toBe(HOUR / 2);
  });

  it("is due once in each slot, from its due time", () => {
    const slot = 480_000;
    const due = dueAt("first-to-second", slot, forward);
    expect(slotDue({ direction: "first-to-second", nowMilliseconds: due - 1, lastSlot: slot - 1, schedule: forward })).toBeNull();
    expect(slotDue({ direction: "first-to-second", nowMilliseconds: due, lastSlot: slot - 1, schedule: forward })).toBe(slot);
    expect(slotDue({ direction: "first-to-second", nowMilliseconds: due, lastSlot: null, schedule: forward })).toBe(slot);
    expect(slotDue({ direction: "first-to-second", nowMilliseconds: due + 1, lastSlot: slot, schedule: forward })).toBeNull();
  });
});
