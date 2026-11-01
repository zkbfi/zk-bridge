import { describe, expect, it } from "vitest";
import { seeded } from "../support/seeded.ts";
import { drawPlan, dueIndex, HOUR_MILLISECONDS, hourOf, unsentIn, type Cadence, type HourPlan } from "../../src/traffic/schedule.ts";

const cadence: Cadence = { minPerHour: 0, maxPerHour: 3, minGapSeconds: 300 };
const HOUR = 480_000;

describe("hourOf", () => {
  it("numbers the clock hours from 1970 (UTC)", () => {
    expect(hourOf(0)).toBe(0);
    expect(hourOf(HOUR_MILLISECONDS - 1)).toBe(0);
    expect(hourOf(HOUR_MILLISECONDS)).toBe(1);
  });
});

describe("drawPlan", () => {
  it("keeps the count, the hour and the gaps inside their bounds over many hours", () => {
    const random = seeded(7);
    const counts = new Set<number>();
    for (let hour = HOUR; hour < HOUR + 2000; hour += 1) {
      const plan = drawPlan({ hour, cadence, random });
      counts.add(plan.count);
      expect(plan.count).toBeGreaterThanOrEqual(0);
      expect(plan.count).toBeLessThanOrEqual(3);
      expect(plan.times).toHaveLength(plan.count);
      expect(plan.sent).toEqual(plan.times.map(() => false));
      plan.times.forEach((time, index) => {
        expect(time).toBeGreaterThanOrEqual(hour * HOUR_MILLISECONDS);
        expect(time).toBeLessThan((hour + 1) * HOUR_MILLISECONDS);
        if (index > 0) expect(time - (plan.times[index - 1] as number)).toBeGreaterThanOrEqual(300_000);
      });
    }
    expect([...counts].sort()).toEqual([0, 1, 2, 3]);
  });

  it("draws every count about equally often", () => {
    const random = seeded(11);
    const counts = [0, 0, 0, 0];
    for (let at = 0; at < 4000; at += 1) {
      const at2 = drawPlan({ hour: 1, cadence, random }).count;
      counts[at2] = (counts[at2] as number) + 1;
    }
    for (const share of counts) expect(share).toBeGreaterThan(800);
  });

  it("can draw no send at all, and always the same number when the bounds meet", () => {
    expect(drawPlan({ hour: 5, cadence, random: () => 0 })).toEqual({ hour: 5, count: 0, times: [], sent: [] });
    const fixed = drawPlan({ hour: 5, cadence: { minPerHour: 2, maxPerHour: 2, minGapSeconds: 300 }, random: seeded(3) });
    expect(fixed.count).toBe(2);
  });

  it("packs the largest count against the end of the hour at the extreme draw", () => {
    const plan = drawPlan({ hour: 0, cadence: { minPerHour: 3, maxPerHour: 3, minGapSeconds: 1799 }, random: () => 0.9999999 });
    expect(plan.times).toHaveLength(3);
    expect(plan.times[2]).toBe(HOUR_MILLISECONDS - 1);
    expect((plan.times[2] as number) - (plan.times[1] as number)).toBe(1_799_000);
    const earliest = drawPlan({ hour: 0, cadence: { minPerHour: 3, maxPerHour: 3, minGapSeconds: 1799 }, random: () => 0 });
    expect(earliest.times).toEqual([0, 1_799_000, 3_598_000]);
  });

  it("is the same for the same seed and differs between seeds", () => {
    const first = Array.from({ length: 20 }, (_, hour) => drawPlan({ hour, cadence, random: seeded(42 + hour) }));
    const again = Array.from({ length: 20 }, (_, hour) => drawPlan({ hour, cadence, random: seeded(42 + hour) }));
    expect(again).toEqual(first);
    const other = seeded(43);
    expect(drawPlan({ hour: 1, cadence, random: other })).not.toEqual(drawPlan({ hour: 1, cadence, random: seeded(42) }));
  });
});

describe("dueIndex", () => {
  const plan: HourPlan = { hour: 1, count: 2, times: [4_000_000, 5_000_000], sent: [false, false] };

  it("waits for the first unused time", () => {
    expect(dueIndex({ plan, nowMilliseconds: 3_999_999, lastAttemptAtMilliseconds: null, cadence })).toBeNull();
    expect(dueIndex({ plan, nowMilliseconds: 4_000_000, lastAttemptAtMilliseconds: null, cadence })).toBe(0);
  });

  it("goes on with the next time once one is used, and ends when all are", () => {
    const first = { ...plan, sent: [true, false] };
    expect(unsentIn(first)).toBe(1);
    expect(dueIndex({ plan: first, nowMilliseconds: 4_500_000, lastAttemptAtMilliseconds: 4_000_000, cadence })).toBeNull();
    expect(dueIndex({ plan: first, nowMilliseconds: 5_000_000, lastAttemptAtMilliseconds: 4_000_000, cadence })).toBe(1);
    expect(dueIndex({ plan: { ...plan, sent: [true, true] }, nowMilliseconds: 9_000_000, lastAttemptAtMilliseconds: null, cadence })).toBeNull();
  });

  it("holds a late send until the gap since the last attempt has passed", () => {
    const late = { ...plan, sent: [true, false] };
    expect(dueIndex({ plan: late, nowMilliseconds: 5_100_000, lastAttemptAtMilliseconds: 4_900_000, cadence })).toBeNull();
    expect(dueIndex({ plan: late, nowMilliseconds: 5_200_000, lastAttemptAtMilliseconds: 4_900_000, cadence })).toBe(1);
  });
});
