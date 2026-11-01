import { describe, expect, it } from "vitest";
import { openStore } from "../src/store.ts";
import type { CheckResult } from "../src/types.ts";

const HOUR = 3_600_000;
const result = (id: string, at: number, state: CheckResult["state"], detail = "d"): CheckResult => ({ id, at, state, latencyMs: 12, detail });
const info = { a: { name: "A", section: "services" as const }, b: { name: "B", section: "chains" as const } };

describe("store", () => {
  it("keeps the newest result of each check as the current one, with the detail of an ok run", () => {
    const store = openStore(":memory:");
    store.record([result("a", 1000, "ok", "fine"), result("b", 1000, "down", "broken")], info);
    store.record([result("a", 2000, "degraded", "slow")], info);
    expect(store.current()).toEqual([
      { id: "a", name: "A", section: "services", at: 2000, state: "degraded", latencyMs: 12, detail: "slow", since: 2000 },
      { id: "b", name: "B", section: "chains", at: 1000, state: "down", latencyMs: 12, detail: "broken", since: 1000 },
    ]);
    store.record([result("a", 3000, "degraded", "still slow")], info);
    expect(store.current()[0]).toMatchObject({ at: 3000, since: 2000 });
    store.close();
  });

  it("counts uptime as the share of runs that were not down, and a full ok share separately", () => {
    const store = openStore(":memory:");
    const now = 10 * HOUR;
    store.record(
      [result("a", now - 4 * HOUR, "ok"), result("a", now - 3 * HOUR, "degraded", "x"), result("a", now - 2 * HOUR, "down", "y"), result("a", now - 1 * HOUR, "ok")],
      info,
    );
    store.record([result("a", now - 40 * HOUR, "down", "old")], info);
    expect(store.uptime(now)["24h"].a).toEqual({ runs: 4, uptime: 75, ok: 50 });
    expect(store.uptime(now)["24h"].b).toBeUndefined();
    expect(store.uptime(now)["7d"].a).toEqual({ runs: 5, uptime: 60, ok: 40 });
    store.close();
  });

  it("gives one bar per slice of the window with the worst state in it, and null where nothing ran", () => {
    const store = openStore(":memory:");
    const now = 2 * 86_400_000;
    const bucket = 86_400_000 / 48;
    store.record(
      [result("a", now - 1, "ok"), result("a", now - 2, "down", "x"), result("a", now - 5 * bucket, "degraded", "y"), result("a", now - 86_400_000 - 5, "down", "outside")],
      info,
    );
    const bars = store.history(now, "24h");
    expect(Object.keys(bars)).toEqual(["a"]);
    expect(bars.a).toHaveLength(48);
    expect(bars.a?.[47]).toBe("down");
    expect(bars.a?.[43]).toBe("degraded");
    expect(bars.a?.[0]).toBeNull();
    expect(store.history(now, "30d", "a").a).toHaveLength(60);
    expect(store.history(now, "24h", "nope")).toEqual({});
    store.close();
  });

  it("names a check that has no entry in the info, and rolls back a round that cannot be written", () => {
    const store = openStore(":memory:");
    store.record([result("x", 1000, "ok")], {});
    expect(store.current()[0]).toMatchObject({ id: "x", name: "x", section: "services" });
    expect(() => store.record([result("a", 2000, "ok"), { ...result("a", 3000, "ok"), at: undefined as unknown as number }], info)).toThrow();
    expect(store.size()).toBe(1);
    store.close();
  });

  it("lists the non-ok runs of a check, newest first", () => {
    const store = openStore(":memory:");
    store.record([result("a", 1000, "down", "first"), result("a", 2000, "ok"), result("a", 3000, "degraded", "second")], info);
    expect(store.problems("a", 0, 10)).toEqual([
      { at: 3000, state: "degraded", detail: "second" },
      { at: 1000, state: "down", detail: "first" },
    ]);
    expect(store.problems("a", 2500, 10)).toHaveLength(1);
    store.close();
  });

  it("prunes the runs older than the retention", () => {
    const store = openStore(":memory:");
    store.record([result("a", 1000, "ok"), result("a", 9000, "ok")], info);
    expect(store.prune(5000)).toBe(1);
    expect(store.uptime(10_000)["24h"].a?.runs).toBe(1);
    expect(store.size()).toBe(1);
    store.close();
  });
});
