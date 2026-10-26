import { describe, expect, it, vi } from "vitest";
import { createFallbackController, describeFailure, judgeIndexerFreshness, type ProbeResult, type SourceStatus } from "../src/index.js";

const behind: ProbeResult = { ok: false, reason: { code: "behind", message: "indexer 400 s behind the chain head" } };
const healthy: ProbeResult = { ok: true };

/** A controller with a clock and a probe that the test controls. */
const setup = (options: { indexerConfigured?: boolean; probe?: () => Promise<ProbeResult> } = {}) => {
  let clock = 0;
  const probe = vi.fn(options.probe ?? (async () => healthy));
  const controller = createFallbackController({
    indexerConfigured: options.indexerConfigured ?? true,
    probe,
    now: () => clock,
    freshnessIntervalMilliseconds: 30_000,
    recoveryIntervalMilliseconds: 15_000,
  });
  const operations = (indexer: () => Promise<string>) => ({ viaIndexer: indexer, viaRpc: async () => "rpc" });
  return { controller, probe, operations, advance: (milliseconds: number) => void (clock += milliseconds) };
};

describe("describeFailure", () => {
  it.each([
    [Object.assign(new TypeError("fetch failed"), {}), "unreachable"],
    [Object.assign(new Error("the operation timed out"), { name: "TimeoutError" }), "unreachable"],
    [Object.assign(new Error("aborted"), { name: "AbortError" }), "unreachable"],
    [new Error("connect ECONNREFUSED 127.0.0.1:42069"), "unreachable"],
    ["getaddrinfo ENOTFOUND host", "unreachable"],
  ])("calls a network failure unreachable", (error, code) => {
    expect(describeFailure(error)).toEqual({ code, message: "indexer unreachable" });
  });

  it("calls any other failure an error and keeps the first 80 characters of its message", () => {
    const reason = describeFailure(new Error(`The indexer answered 502. ${"x".repeat(200)}`));
    expect(reason.code).toBe("error");
    expect(reason.message).toBe(`indexer error: ${`The indexer answered 502. ${"x".repeat(200)}`.slice(0, 80)}`);
  });
});

describe("judgeIndexerFreshness", () => {
  it("accepts an indexer within the limit, on every chain", () => {
    expect(judgeIndexerFreshness({ indexerTips: [1_000, 1_100], chainTips: [1_200, 1_300], maximumLagSeconds: 300 })).toEqual(healthy);
  });

  it("says behind when one chain lags more than the limit, and names the worst lag", () => {
    expect(judgeIndexerFreshness({ indexerTips: [1_000, 1_000], chainTips: [1_100, 1_400], maximumLagSeconds: 300 })).toEqual({
      ok: false,
      reason: { code: "behind", message: "indexer 400 s behind the chain head" },
    });
  });

  it("says behind, with no time, when the indexer holds no block for a chain", () => {
    expect(judgeIndexerFreshness({ indexerTips: [1_000, null], chainTips: [1_000, 1_000], maximumLagSeconds: 300 })).toEqual({
      ok: false,
      reason: { code: "behind", message: "indexer an unknown time behind the chain head" },
    });
    expect(judgeIndexerFreshness({ indexerTips: [], chainTips: [5], maximumLagSeconds: 300 }).ok).toBe(false);
  });

  it("does not count an indexer that is ahead of the chain clock as behind", () => {
    expect(judgeIndexerFreshness({ indexerTips: [2_000], chainTips: [1_000], maximumLagSeconds: 0 })).toEqual(healthy);
  });
});

describe("createFallbackController", () => {
  it("starts on the indexer and reads through it while it works", async () => {
    const { controller, operations } = setup();
    expect(controller.status()).toEqual({ kind: "indexer", reason: null, label: "indexer" });
    expect(await controller.run(operations(async () => "indexer"))).toBe("indexer");
  });

  it("starts on the RPC source with the reason no indexer URL when none is set, and never reads or probes the indexer", async () => {
    const { controller, probe, advance } = setup({ indexerConfigured: false });
    const viaIndexer = vi.fn(async () => "indexer");
    advance(1_000_000);
    expect(await controller.run({ viaIndexer, viaRpc: async () => "rpc" })).toBe("rpc");
    await controller.checkNow();
    expect(viaIndexer).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(controller.status()).toEqual({ kind: "rpc", reason: { code: "not-set", message: "no indexer URL is set" }, label: "RPC fallback: no indexer URL is set" });
  });

  it("falls back when the indexer is unreachable, runs the same read on RPC, and says why", async () => {
    const { controller } = setup();
    const seen: SourceStatus[] = [];
    controller.subscribe((status) => seen.push(status));
    const result = await controller.run({ viaIndexer: async () => Promise.reject(new TypeError("fetch failed")), viaRpc: async () => "rpc" });
    expect(result).toBe("rpc");
    expect(controller.status().label).toBe("RPC fallback: indexer unreachable");
    expect(seen.map((status) => status.label)).toEqual(["RPC fallback: indexer unreachable"]);
  });

  it("falls back when the indexer answers with an error", async () => {
    const { controller } = setup();
    await controller.run({ viaIndexer: async () => Promise.reject(new Error("The indexer answered 500 for /api/feed.")), viaRpc: async () => "rpc" });
    expect(controller.status()).toMatchObject({ kind: "rpc", reason: { code: "error" } });
    expect(controller.status().label).toBe("RPC fallback: indexer error: The indexer answered 500 for /api/feed.");
  });

  it("falls back when the check finds the indexer behind the chain head", async () => {
    const { controller, advance } = setup({ probe: async () => behind });
    advance(31_000);
    await controller.run({ viaIndexer: async () => "indexer", viaRpc: async () => "rpc" });
    await controller.checkNow();
    expect(controller.status().label).toBe("RPC fallback: indexer 400 s behind the chain head");
    expect(await controller.run({ viaIndexer: async () => "indexer", viaRpc: async () => "rpc" })).toBe("rpc");
  });

  it("goes back to the indexer when a check of the failed indexer succeeds", async () => {
    let result: ProbeResult = behind;
    const { controller, probe, advance } = setup({ probe: async () => result });
    await controller.run({ viaIndexer: async () => Promise.reject(new TypeError("fetch failed")), viaRpc: async () => "rpc" });
    expect(controller.status().kind).toBe("rpc");
    result = healthy;
    advance(14_000);
    await controller.run({ viaIndexer: async () => "indexer", viaRpc: async () => "rpc" });
    expect(probe).not.toHaveBeenCalled();
    advance(2_000);
    expect(await controller.run({ viaIndexer: async () => "indexer", viaRpc: async () => "rpc" })).toBe("rpc");
    await controller.checkNow();
    expect(controller.status().label).toBe("indexer");
    expect(await controller.run({ viaIndexer: async () => "indexer", viaRpc: async () => "rpc" })).toBe("indexer");
  });

  it("stays on RPC when the check of a failed indexer fails again, and when the probe itself throws", async () => {
    const { controller, advance } = setup({ probe: async () => Promise.reject(new Error("probe broke")) });
    await controller.run({ viaIndexer: async () => Promise.reject(new TypeError("fetch failed")), viaRpc: async () => "rpc" });
    advance(16_000);
    await controller.run({ viaIndexer: async () => "indexer", viaRpc: async () => "rpc" });
    await controller.checkNow();
    expect(controller.status()).toMatchObject({ kind: "rpc", reason: { code: "error" } });
  });

  it("does not run two checks at once", async () => {
    let release: (result: ProbeResult) => void = () => undefined;
    const { controller, probe } = setup({ probe: () => new Promise<ProbeResult>((resolve) => (release = resolve)) });
    const first = controller.checkNow();
    const second = controller.checkNow();
    release(healthy);
    await Promise.all([first, second]);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("does not repeat a notice when the status does not change, and stops notifying after unsubscribe", async () => {
    const { controller } = setup();
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    const failing = { viaIndexer: async () => Promise.reject(new TypeError("fetch failed")), viaRpc: async () => "rpc" };
    await controller.run(failing);
    await controller.run(failing);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    await controller.checkNow();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not catch a failure of the RPC source", async () => {
    const { controller } = setup({ indexerConfigured: false });
    await expect(controller.run({ viaIndexer: async () => "indexer", viaRpc: async () => Promise.reject(new Error("rpc down")) })).rejects.toThrow("rpc down");
  });

  it("uses the describeError option to turn an error into a reason", async () => {
    const controller = createFallbackController({
      indexerConfigured: true,
      probe: async () => healthy,
      describeError: () => ({ code: "error", message: "custom reason" }),
    });
    await controller.run({ viaIndexer: async () => Promise.reject(new Error("x")), viaRpc: async () => "rpc" });
    expect(controller.status().label).toBe("RPC fallback: custom reason");
  });
});
