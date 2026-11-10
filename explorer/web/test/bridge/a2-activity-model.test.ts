import { describe, expect, it } from "vitest";
import type { FeedItem } from "@terminal/model/types";
import { FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import { dayOf, relativeTime, stepsOf } from "../../src/bridge/activity-model";

const NOON = Date.UTC(2026, 5, 15, 12) / 1000;

describe("relativeTime", () => {
  it("says just now, minutes, hours, yesterday, then the date", () => {
    expect(relativeTime(NOON - 30, NOON)).toBe("just now");
    expect(relativeTime(NOON - 150, NOON)).toBe("3 min ago");
    expect(relativeTime(NOON - 7200, NOON)).toBe("2 h ago");
    expect(relativeTime(NOON - 90_000, NOON)).toBe("yesterday");
    expect(relativeTime(NOON - 3 * 86_400, NOON)).toBe(new Date((NOON - 3 * 86_400) * 1000).toLocaleDateString());
  });
});

describe("dayOf", () => {
  it("headings the same day Today, the day before Yesterday, and older days by weekday and date", () => {
    expect(dayOf(NOON - 3600, NOON)).toBe("Today");
    expect(dayOf(NOON - 86_400, NOON)).toBe("Yesterday");
    expect(dayOf(NOON - 5 * 86_400, NOON)).toBe(new Date((NOON - 5 * 86_400) * 1000).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }));
  });
});

describe("stepsOf a delivered transfer", () => {
  it("stamps the last step with the delivery time and links both ends", () => {
    const item = {
      id: `0x${"01".repeat(32)}`, kind: "token", direction: "first-to-second", status: "delivered", sender: "0x1", recipient: "0x2", token: FIXTURE_TOKENS[0]!, amount: 1n,
      sentAt: NOON - 600, deliveredAt: NOON, sourceTransactionHash: `0x${"11".repeat(32)}`, destinationTransactionHash: `0x${"22".repeat(32)}`,
    } as unknown as FeedItem;
    const { steps } = stepsOf(item, FIXTURE_PAIR);
    expect(steps.at(-1)!.at).not.toBe("");
    expect(steps.at(-1)!.href).toContain(`0x${"22".repeat(32)}`);
    expect(steps[0]!.href).toContain(`0x${"11".repeat(32)}`);
  });
});
