import { describe, expect, it } from "vitest";
import { createIdleHistory, idleSecondsAt } from "../src/idle-history.ts";
import { openStorage } from "../src/storage.ts";

const SWITCH = Date.parse("2026-11-08T01:59:00Z");

describe("the idle timeout over time (2026-11-08)", () => {
  it("is seeded by the migration: 60 s from the beginning, 5 s from 2026-11-08T01:59:00Z, once however often the file opens", () => {
    const storage = openStorage(":memory:");
    storage.database.exec("INSERT OR IGNORE INTO idle_timeout_history (at, seconds) VALUES (0, 60)");
    const history = createIdleHistory(storage);
    expect(history.changes()).toEqual([
      { at: 0, seconds: 60 },
      { at: SWITCH, seconds: 5 },
    ]);
    expect(history.secondsAt(SWITCH - 1, 99)).toBe(60);
    expect(history.secondsAt(SWITCH, 99)).toBe(5);
    expect(history.secondsAt(SWITCH + 86_400_000, 99)).toBe(5);
    storage.close();
  });

  it("records a change when the endpoint's timeout differs from the latest row, and nothing when it matches", () => {
    const storage = openStorage(":memory:");
    const history = createIdleHistory(storage);
    history.record(SWITCH + 1000, 5);
    expect(history.changes()).toHaveLength(2);
    history.record(SWITCH + 2000, 30);
    history.record(SWITCH + 3000, 30);
    expect(history.changes().map((change) => change.seconds)).toEqual([60, 5, 30]);
    // The same instant replaces: a read and the set that follows it in the same millisecond.
    history.record(SWITCH + 2000, 5);
    expect(history.changes().map((change) => change.seconds)).toEqual([60, 5, 5]);
    storage.close();
  });

  it("answers the first change before it starts, and the fallback with no changes", () => {
    expect(idleSecondsAt([], 5, 7)).toBe(7);
    expect(idleSecondsAt([{ at: 100, seconds: 9 }], 5, 7)).toBe(9);
    expect(idleSecondsAt([{ at: 100, seconds: 9 }, { at: 200, seconds: 3 }], 150, 7)).toBe(9);
  });
});
