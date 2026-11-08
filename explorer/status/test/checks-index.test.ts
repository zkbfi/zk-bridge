import { describe, expect, it } from "vitest";
import { buildChecks } from "../src/checks/index.ts";
import { SECTIONS } from "../src/types.ts";
import { makeDeps, pair } from "./support.ts";

describe("buildChecks", () => {
  it("lists the checks of every section, with unique ids", () => {
    const checks = buildChecks(makeDeps());
    const ids = checks.map((check) => check.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining([
        "indexer-local", "indexer-public", "backend-local", "backend-public", "webhook", "site-next", "site-main", "gateway-next", "gateway-main",
        "unit-zk-bridge-backend", "unit-zk-bridge-indexer", "unit-zk-bridge-runner", "unit-zk-bridge-traffic", "unit-zk-bridge-ipfs",
        "rpc-11155111", "rpc-943", "beacon-11155111", "beacon-943", "lightclient-first-to-second", "lightclient-second-to-first", "lightclient-deadline-first-to-second", "lightclient-deadline-second-to-first",
        "bridge-11155111", "gate-11155111", "bridge-943", "gate-943",
        "pipeline-benchmarks", "gpu-billing", "pipeline-first-to-second", "pipeline-second-to-first", "pipeline-deliveries", "prover-runpod",
        "wallet-runner-11155111", "wallet-runner-943",
      ]),
    );
    for (const section of SECTIONS) expect(checks.some((check) => check.section === section)).toBe(true);
  });

  it("leaves out the RunPod check without a key and the beacon check of a chain without a beacon endpoint", () => {
    const withoutKey = buildChecks(makeDeps({ apiKey: undefined })).map((check) => check.id);
    expect(withoutKey).not.toContain("prover-runpod");
    const noBeacon = makeDeps({ pair: { ...pair, sides: [{ ...pair.sides[0], beaconUrl: null }, pair.sides[1]] as const } });
    expect(buildChecks(noBeacon).map((check) => check.id)).not.toContain("beacon-11155111");
  });

  it("binds each check to the dependencies", async () => {
    const deps = makeDeps({ exec: async () => "LoadState=loaded\nActiveState=active\nSubState=running" });
    const unit = buildChecks(deps).find((check) => check.id === "unit-zk-bridge-backend");
    expect(await unit?.run()).toEqual({ state: "ok", detail: "active (running)" });
  });
});
