import { describe, expect, it, vi } from "vitest";
import { unitCheck } from "../src/checks/units.ts";
import { makeDeps } from "./support.ts";

const show = (fields: Record<string, string>) => Object.entries(fields).map(([key, value]) => `${key}=${value}`).join("\n");
const run = (output: string | Error, unit = { name: "zk-bridge-backend", optional: false }) => {
  const exec = vi.fn(async () => { if (output instanceof Error) throw output; return output; });
  return { exec, result: unitCheck(unit).run(makeDeps({ exec })) };
};

describe("unitCheck", () => {
  it("asks systemctl show for the properties, and nothing else", async () => {
    const { exec, result } = run(show({ LoadState: "loaded", ActiveState: "active", SubState: "running" }));
    expect(await result).toEqual({ state: "ok", detail: "active (running)" });
    expect(exec).toHaveBeenCalledWith("systemctl", ["show", "zk-bridge-backend", "--no-pager", "--property=LoadState,ActiveState,SubState"]);
  });

  it("accepts a timer that waits", async () => {
    expect(await run(show({ LoadState: "loaded", ActiveState: "active", SubState: "waiting" }), { name: "zk-bridge-keepalive.timer", optional: false }).result).toEqual({ state: "ok", detail: "active (waiting)" });
  });

  it("is degraded while the unit restarts and down when it is stopped or failed", async () => {
    expect(await run(show({ LoadState: "loaded", ActiveState: "activating", SubState: "auto-restart" })).result).toEqual({ state: "degraded", detail: "activating (auto-restart): it is restarting" });
    expect(await run(show({ LoadState: "loaded", ActiveState: "failed", SubState: "failed" })).result).toEqual({ state: "down", detail: "failed (failed)" });
    expect(await run(show({ LoadState: "loaded", ActiveState: "inactive", SubState: "dead" })).result).toEqual({ state: "down", detail: "inactive (dead)" });
  });

  it("treats a missing optional unit as fine and a missing required one as down", async () => {
    const missing = show({ LoadState: "not-found", ActiveState: "inactive", SubState: "dead" });
    expect(await run(missing, { name: "zk-bridge-traffic", optional: true }).result).toEqual({ state: "ok", detail: "not installed on this server" });
    expect(await run(missing).result).toEqual({ state: "down", detail: "the unit is not installed" });
  });

  it("is down when systemctl cannot run", async () => {
    await expect(run(new Error("spawn systemctl ENOENT")).result).rejects.toThrow(/ENOENT/);
  });
});
