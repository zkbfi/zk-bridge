import { describe, expect, it } from "vitest";
import { summarize } from "../src/summary.ts";
import type { CurrentRow } from "../src/store.ts";

const row = (id: string, state: CurrentRow["state"], detail = "", at = 1_000_000): CurrentRow => ({ id, name: id.toUpperCase(), section: "services", at, state, latencyMs: 5, detail, since: at });

describe("summarize", () => {
  it("says operational when every check is ok", () => {
    expect(summarize([row("a", "ok"), row("b", "ok")], 1_000_100, 180_000)).toEqual({
      status: "operational",
      message: "All 2 checks pass.",
      failing: [],
      checks: 2,
      checkedAt: 1_000_000,
    });
  });

  it("names what fails, the down ones first, and takes the worst state", () => {
    const summary = summarize([row("a", "degraded", "slow"), row("b", "down", "no answer"), row("c", "ok")], 1_000_100, 180_000);
    expect(summary.status).toBe("down");
    expect(summary.message).toBe("Down: B: no answer. Degraded: A: slow.");
    expect(summary.failing.map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(summarize([row("a", "degraded", "slow")], 1_000_100, 180_000).message).toBe("Degraded: A: slow.");
  });

  it("calls the page down when its own checks have stopped", () => {
    const stale = summarize([row("a", "ok")], 1_000_000 + 200_000, 180_000);
    expect(stale.status).toBe("down");
    expect(stale.message).toBe("The status service has not run its checks for 3 minutes.");
  });

  it("is degraded, not green, before the first round", () => {
    expect(summarize([], 5, 180_000)).toMatchObject({ status: "degraded", message: "No check has run yet.", checks: 0, checkedAt: null });
  });
});
