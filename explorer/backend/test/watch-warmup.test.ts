import { describe, expect, it } from "vitest";
import { DEFAULT_WARMUP, IDLE, leadFrom, nextHoldAt, warmupStep, type WarmupSession, type WarmupStepInput, type WarmupTarget } from "../src/watch/warmup.ts";

const config = DEFAULT_WARMUP;

describe("leadFrom", () => {
  it("is the default lead time while there is no observation", () => {
    expect(leadFrom([], config)).toEqual({ seconds: 90, basis: "default", observations: 0 });
  });

  it("is the p90 (nearest rank) of the observations", () => {
    // Ten observations: the ninth smallest.
    expect(leadFrom([31, 35, 40, 45, 50, 55, 60, 65, 70, 300], config)).toEqual({ seconds: 70, basis: "observed", observations: 10 });
    // One observation is its own p90; a fraction rounds up.
    expect(leadFrom([44.2], config)).toEqual({ seconds: 45, basis: "observed", observations: 1 });
    expect(leadFrom([40, 50], { ...config, leadP: 0.5 })).toMatchObject({ seconds: 40 });
  });

  it("reads only the newest observations", () => {
    // The newest first: twenty short starts hide the old 400 s image pull.
    const observations = [...Array<number>(20).fill(30), 400];
    expect(leadFrom(observations, config)).toEqual({ seconds: 30, basis: "observed", observations: 20 });
    expect(leadFrom(observations, { ...config, leadObservations: 21 })).toMatchObject({ seconds: 30 });
    expect(leadFrom([400, ...Array<number>(20).fill(30)], config)).toMatchObject({ seconds: 30 });
    // Three slow starts of twenty reach the p90.
    expect(leadFrom([400, 400, 400, ...Array<number>(17).fill(30)], config)).toMatchObject({ seconds: 400 });
  });

  it("is clamped to the minimum and the maximum, and so is the default", () => {
    expect(leadFrom([2, 3, 4], config)).toMatchObject({ seconds: 30 });
    expect(leadFrom([900], config)).toMatchObject({ seconds: 600 });
    expect(leadFrom([], { ...config, defaultLeadSeconds: 10 })).toMatchObject({ seconds: 30, basis: "default" });
    expect(leadFrom([], { ...config, defaultLeadSeconds: 1000 })).toMatchObject({ seconds: 600, basis: "default" });
  });
});

describe("warmupStep", () => {
  const target: WarmupTarget = { at: 10_000, why: "message", keys: ["m1"] };
  const lead = 120;
  const step = (overrides: Partial<WarmupStepInput> = {}) =>
    warmupStep({ nowSeconds: target.at - lead, targets: [target], live: new Set(["m1"]), session: IDLE, config, leadSeconds: lead, jobActive: false, pingOutstanding: false, capReached: false, ...overrides });
  const warming: WarmupSession = { phase: "warming", id: "s", target, startedAt: target.at - lead, lastPingAt: target.at - lead };
  const warm: WarmupSession = { phase: "warm", id: "s", target, startedAt: target.at - lead, readyAt: target.at - 60, lastReadyAt: target.at - 60, lastPingAt: target.at - 60, holds: 0 };

  it("starts a session when the due time minus the lead time comes, and not before", () => {
    expect(step({ nowSeconds: target.at - lead - 1 })).toEqual({ kind: "none" });
    expect(step()).toEqual({ kind: "start", target });
    // A due time past by less than the grace still starts one; past the grace, nothing.
    expect(step({ nowSeconds: target.at + config.graceSeconds })).toEqual({ kind: "start", target });
    expect(step({ nowSeconds: target.at + config.graceSeconds + 1 })).toEqual({ kind: "none" });
  });

  it("the lead time sets the start: a longer cold start starts earlier", () => {
    expect(step({ nowSeconds: target.at - 400, leadSeconds: 400 })).toEqual({ kind: "start", target });
    expect(step({ nowSeconds: target.at - 400, leadSeconds: 399 })).toEqual({ kind: "none" });
  });

  it("starts nothing while a job runs or a ping is outstanding, nor within the gap after a timed-out ping", () => {
    expect(step({ jobActive: true })).toEqual({ kind: "none" });
    expect(step({ pingOutstanding: true })).toEqual({ kind: "none" });
    const timedOut: WarmupSession = { phase: "idle", timedOutAt: target.at - lead - config.minGapSeconds + 1 };
    expect(step({ session: timedOut })).toEqual({ kind: "none" });
    expect(step({ session: { phase: "idle", timedOutAt: target.at - lead - config.minGapSeconds } })).toEqual({ kind: "start", target });
  });

  it("starts nothing once the daily cap is spent, and says so", () => {
    expect(step({ capReached: true })).toEqual({ kind: "capped", target });
  });

  it("pings again every interval while no worker is ready, one at a time", () => {
    expect(step({ session: warming, nowSeconds: target.at - lead + config.intervalSeconds - 1 })).toEqual({ kind: "none" });
    expect(step({ session: warming, nowSeconds: target.at - lead + config.intervalSeconds })).toEqual({ kind: "repeat" });
    expect(step({ session: warming, nowSeconds: target.at - lead + config.intervalSeconds, pingOutstanding: true })).toEqual({ kind: "none" });
  });

  it("holds a ready worker with a ping just before its idle timeout, until the due time is past by the grace", () => {
    expect(step({ session: warm, nowSeconds: target.at - 60 + config.holdIntervalSeconds - 1 })).toEqual({ kind: "none" });
    expect(step({ session: warm, nowSeconds: target.at - 60 + config.holdIntervalSeconds })).toEqual({ kind: "hold" });
    expect(step({ session: warm, nowSeconds: target.at - 60 + config.holdIntervalSeconds, pingOutstanding: true })).toEqual({ kind: "none" });
    expect(step({ session: { ...warm, lastReadyAt: target.at + 40, lastPingAt: target.at + 40 }, nowSeconds: target.at + config.graceSeconds })).toEqual({ kind: "hold" });
    expect(step({ session: { ...warm, lastReadyAt: target.at + 40 }, nowSeconds: target.at + config.graceSeconds + 1 })).toEqual({ kind: "end", reason: "grace" });
  });

  it("after a hold that was not answered ready, waits the interval before the next one: no ping storm", () => {
    const missed: WarmupSession = { ...warm, lastPingAt: target.at - 20 };
    expect(nextHoldAt(missed, config)).toBe(target.at - 20 + config.intervalSeconds);
    expect(step({ session: missed, nowSeconds: target.at - 20 + config.intervalSeconds - 1 })).toEqual({ kind: "none" });
    expect(step({ session: missed, nowSeconds: target.at - 20 + config.intervalSeconds })).toEqual({ kind: "hold" });
    // An interval longer than the hold never delays the hold after a ready answer.
    expect(nextHoldAt(warm, { ...config, intervalSeconds: 120 })).toBe(target.at - 60 + config.holdIntervalSeconds);
  });

  it("ends the session as used once the job starts, whatever else holds", () => {
    expect(step({ session: warm, jobActive: true, live: new Set() })).toEqual({ kind: "end", reason: "used" });
    expect(step({ session: warming, jobActive: true, pingOutstanding: true })).toEqual({ kind: "end", reason: "used" });
  });

  it("ends the session when none of its keys still waits: the message was delivered or covered", () => {
    expect(step({ session: warm, live: new Set(["other"]) })).toEqual({ kind: "end", reason: "covered" });
    // One key of several still waiting keeps it.
    const both: WarmupSession = { ...warm, target: { ...target, keys: ["m1", "m2"] } };
    expect(step({ session: both, live: new Set(["m2"]) })).toEqual({ kind: "none" });
  });

  it("ends a warm session at its next hold once the daily cap is spent", () => {
    expect(step({ session: warm, capReached: true })).toEqual({ kind: "none" });
    expect(step({ session: warm, capReached: true, nowSeconds: target.at - 60 + config.holdIntervalSeconds })).toEqual({ kind: "end", reason: "cap" });
  });
});
