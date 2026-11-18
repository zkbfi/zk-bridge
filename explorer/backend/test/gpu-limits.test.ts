import { describe, expect, it, vi } from "vitest";
import { deriveGpuLimits, logGpuLimits, proofsPerHour } from "../src/gpu-limits.ts";
import { gpuLimitsOf } from "../src/config.ts";
import { makeConfig } from "./support.ts";

const watchOf = (minIntervalSeconds: number) => ({ pairs: { "eth-pls": { minIntervalSeconds } } });

describe("proofsPerHour", () => {
  it("is ceil(3600 / interval), and an interval of 0 counts as 60 seconds", () => {
    expect(proofsPerHour(3600)).toBe(1);
    expect(proofsPerHour(600)).toBe(6);
    expect(proofsPerHour(700)).toBe(6);
    expect(proofsPerHour(0)).toBe(60);
  });
});

describe("deriveGpuLimits", () => {
  const base = { pair: "eth-pls", proofCostUsd: 0.1, headroom: 2, explicit: {} };

  it("derives today's 0.5 / 5 for an hourly pair (the testnet)", () => {
    const limits = deriveGpuLimits({ ...base, watch: watchOf(3600) });
    expect(limits.maxUsdPerHour).toEqual({ value: 0.5, derived: 0.5, source: "derived" });
    expect(limits.gpuBudgetUsdPerDirectionPerDay).toEqual({ value: 5, derived: 5, source: "derived" });
  });

  it("derives 2.40 an hour and 28.80 a direction a day for a 600 second pair (the mainnet)", () => {
    const limits = deriveGpuLimits({ ...base, watch: watchOf(600) });
    expect(limits.proofsPerHour).toBe(6);
    expect(limits.maxUsdPerHour.value).toBe(2.4);
    expect(limits.gpuBudgetUsdPerDirectionPerDay.value).toBe(28.8);
  });

  it("never goes below the floors, and an interval of 0 counts as 60 seconds", () => {
    expect(deriveGpuLimits({ ...base, watch: watchOf(86_400) }).maxUsdPerHour.value).toBe(0.5);
    expect(deriveGpuLimits({ ...base, watch: watchOf(0) }).maxUsdPerHour.value).toBe(24);
    expect(deriveGpuLimits({ ...base, watch: watchOf(0) }).gpuBudgetUsdPerDirectionPerDay.value).toBe(288);
  });

  it("derives nothing when no interval is set anywhere: the floors stay (an older file keeps 0.5 / 5)", () => {
    const limits = deriveGpuLimits({ ...base, watch: {} });
    expect(limits.intervalSeconds).toBeNull();
    expect([limits.maxUsdPerHour.value, limits.gpuBudgetUsdPerDirectionPerDay.value]).toEqual([0.5, 5]);
  });

  it("reads the pair's interval, else the watch level, and the deprecated alias", () => {
    expect(deriveGpuLimits({ ...base, watch: { minIntervalSeconds: 600, pairs: {} } }).intervalSeconds).toBe(600);
    expect(deriveGpuLimits({ ...base, watch: { minIntervalSeconds: 600, pairs: { "eth-pls": { minIntervalSeconds: 1200 } } } }).intervalSeconds).toBe(1200);
    expect(deriveGpuLimits({ ...base, watch: { pairs: { "eth-pls": { maxWaitSeconds: 1800 } } } }).intervalSeconds).toBe(1800);
  });

  it("uses the cost and headroom that are given", () => {
    const limits = deriveGpuLimits({ ...base, proofCostUsd: 0.2, headroom: 3, watch: watchOf(600) });
    expect(limits.maxUsdPerHour.value).toBe(7.2);
    expect(limits.gpuBudgetUsdPerDirectionPerDay.value).toBe(86.4);
  });

  it("lets an explicit value win and keeps the derived figure beside it", () => {
    const limits = deriveGpuLimits({ ...base, watch: watchOf(600), explicit: { maxUsdPerHour: 0.5, gpuBudgetUsdPerDirectionPerDay: 50 } });
    expect(limits.maxUsdPerHour).toEqual({ value: 0.5, derived: 2.4, source: "set" });
    expect(limits.gpuBudgetUsdPerDirectionPerDay).toEqual({ value: 50, derived: 28.8, source: "set" });
  });
});

describe("the configuration", () => {
  it("resolves the live testnet file to 0.5 / 5, derived guard and set budget", () => {
    const config = makeConfig({ pair: "sepolia-pls943", limits: { gpuBudgetUsdPerDirectionPerDay: 5 }, watch: { enabled: false, pairs: { "sepolia-pls943": { minIntervalSeconds: 3600 } } } });
    expect(config.gpuGuard).toMatchObject({ maxUsdPerHour: 0.5, proofCostUsd: 0.1, headroom: 2 });
    expect(config.limits.gpuBudgetUsdPerDirectionPerDay).toBe(5);
    expect(gpuLimitsOf(config).maxUsdPerHour.source).toBe("derived");
    expect(gpuLimitsOf(config).gpuBudgetUsdPerDirectionPerDay.source).toBe("set");
  });

  it("derives the mainnet limits from a 600 second pair interval", () => {
    const config = makeConfig({ watch: { enabled: false, pairs: { "eth-pls": { minIntervalSeconds: 600 } } } });
    expect(config.gpuGuard.maxUsdPerHour).toBe(2.4);
    expect(config.limits.gpuBudgetUsdPerDirectionPerDay).toBe(28.8);
  });

  it("keeps explicit values and rejects a zero cost or headroom", () => {
    const config = makeConfig({ gpuGuard: { maxUsdPerHour: 0.25 }, limits: { gpuBudgetUsdPerDirectionPerDay: 0 }, watch: { enabled: false, pairs: { "eth-pls": { minIntervalSeconds: 600 } } } });
    expect(config.gpuGuard.maxUsdPerHour).toBe(0.25);
    expect(config.limits.gpuBudgetUsdPerDirectionPerDay).toBe(0);
    expect(() => makeConfig({ gpuGuard: { proofCostUsd: 0 } })).toThrow();
    expect(() => makeConfig({ gpuGuard: { headroom: 0 } })).toThrow();
  });
});

describe("gpuLimitsOf", () => {
  it("falls back to counting both values as set for a copy of the configuration that was not parsed", () => {
    const config = makeConfig({ watch: { enabled: false, pairs: { "eth-pls": { minIntervalSeconds: 600 } } } });
    const copy = { ...config };
    expect(gpuLimitsOf(copy).maxUsdPerHour).toEqual({ value: 2.4, derived: 2.4, source: "set" });
    expect(gpuLimitsOf(config).maxUsdPerHour.source).toBe("derived");
  });
});

describe("logGpuLimits", () => {
  const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

  it("logs the limits in force, each as derived or set", () => {
    const log = logger();
    logGpuLimits(log as never, deriveGpuLimits({ pair: "eth-pls", watch: watchOf(600), proofCostUsd: 0.1, headroom: 2, explicit: { gpuBudgetUsdPerDirectionPerDay: 28.8 } }));
    expect(log.info).toHaveBeenCalledWith("gpu_limits", expect.objectContaining({ intervalSeconds: 600, maxUsdPerHour: 2.4, maxUsdPerHourSource: "derived", gpuBudgetUsdPerDirectionPerDay: 28.8, gpuBudgetSource: "set" }));
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("warns once for each explicit value below the derived one, with both figures", () => {
    const log = logger();
    logGpuLimits(log as never, deriveGpuLimits({ pair: "eth-pls", watch: watchOf(600), proofCostUsd: 0.1, headroom: 2, explicit: { maxUsdPerHour: 0.5, gpuBudgetUsdPerDirectionPerDay: 5 } }));
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith("gpu_limits_below_interval", expect.objectContaining({ key: "gpuGuard.maxUsdPerHour", set: 0.5, derived: 2.4, intervalSeconds: 600 }));
    expect(log.warn).toHaveBeenCalledWith("gpu_limits_below_interval", expect.objectContaining({ key: "limits.gpuBudgetUsdPerDirectionPerDay", set: 5, derived: 28.8 }));
  });
});
