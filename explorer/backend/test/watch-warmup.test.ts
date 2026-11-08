import { describe, expect, it } from "vitest";
import { DEFAULT_WARMUP, IDLE, holdIntervalFor, leadFrom, nextHoldAt, predictionOf, warmupStep, type WarmupSession, type WarmupStepInput, type WarmupTarget } from "../src/watch/warmup.ts";

/** The settings before 2026-11-08 (hold 40 s under a 60 s idle timeout): the scenarios of these tests rest on them. */
const config = { ...DEFAULT_WARMUP, holdIntervalSeconds: 40, idleTimeoutSeconds: 60 };

describe("leadFrom", () => {
  it("is the default lead time while there is no observation", () => {
    expect(leadFrom([], config)).toEqual({ seconds: 90, basis: "default", observations: 0 });
  });

  it("is the p75 (nearest rank) of the observations plus the margin", () => {
    // Ten observations: the eighth smallest, and five seconds.
    expect(leadFrom([31, 35, 40, 45, 50, 55, 60, 65, 70, 300], config)).toEqual({ seconds: 70, basis: "observed", observations: 10 });
    // One observation is its own p75; a fraction rounds up.
    expect(leadFrom([44.2], config)).toEqual({ seconds: 50, basis: "observed", observations: 1 });
    expect(leadFrom([40, 50], { ...config, leadP: 0.5, leadMarginSeconds: 0 })).toMatchObject({ seconds: 40 });
    // The quantile is configurable: the p90 of the same ten is the ninth.
    expect(leadFrom([31, 35, 40, 45, 50, 55, 60, 65, 70, 300], { ...config, leadP: 0.9 })).toMatchObject({ seconds: 75 });
  });

  it("reads only the newest observations", () => {
    // The newest first: twenty short starts hide the old 400 s image pull.
    const observations = [...Array<number>(20).fill(30), 400];
    expect(leadFrom(observations, config)).toEqual({ seconds: 35, basis: "observed", observations: 20 });
    expect(leadFrom(observations, { ...config, leadObservations: 21 })).toMatchObject({ seconds: 35 });
    expect(leadFrom([400, ...Array<number>(20).fill(30)], config)).toMatchObject({ seconds: 35 });
    // Six slow starts of twenty reach the p75.
    expect(leadFrom([400, 400, 400, 400, 400, 400, ...Array<number>(14).fill(30)], config)).toMatchObject({ seconds: 405 });
  });

  it("is clamped to the minimum and the maximum, and so is the default", () => {
    expect(leadFrom([2, 3, 4], config)).toMatchObject({ seconds: 20 });
    expect(leadFrom([900], config)).toMatchObject({ seconds: 600 });
    expect(leadFrom([], { ...config, defaultLeadSeconds: 10 })).toMatchObject({ seconds: 20, basis: "default" });
    expect(leadFrom([], { ...config, defaultLeadSeconds: 1000 })).toMatchObject({ seconds: 600, basis: "default" });
  });
});

describe("warmupStep", () => {
  const target: WarmupTarget = { at: 10_000, why: "message", keys: ["m1"] };
  const lead = 120;
  const step = (overrides: Partial<WarmupStepInput> = {}) =>
    warmupStep({ nowSeconds: target.at - lead, targets: [target], live: new Set(["m1"]), session: IDLE, config, leadSeconds: lead, jobActive: false, pingOutstanding: false, capReached: false, predictionStarted: () => false, ...overrides });
  const warming: WarmupSession = { phase: "warming", id: "s", target, startedAt: target.at - lead, lastPingAt: target.at - lead };
  const warm: WarmupSession = { phase: "warm", id: "s", target, startedAt: target.at - lead, readyAt: target.at - 60, lastReadyAt: target.at - 60, lastPingAt: target.at - 60, holds: 0 };

  it("starts a session when the due time minus the lead time comes, and not before", () => {
    expect(step({ nowSeconds: target.at - lead - 1 })).toEqual({ kind: "none" });
    expect(step()).toEqual({ kind: "start", target });
    // A due time past by less than the grace still starts one; past the grace, nothing.
    expect(step({ nowSeconds: target.at + config.graceSeconds })).toEqual({ kind: "start", target });
    expect(step({ nowSeconds: target.at + config.graceSeconds + 1 })).toEqual({ kind: "none" });
  });

  it("starts nothing for a prediction that had its early start: skipped, also while the cap is spent", () => {
    expect(step({ predictionStarted: (candidate) => candidate === target })).toEqual({ kind: "skipped", target });
    expect(step({ predictionStarted: () => true, capReached: true })).toEqual({ kind: "skipped", target });
    // Outside the window there is nothing to skip.
    expect(step({ predictionStarted: () => true, nowSeconds: target.at - lead - 1 })).toEqual({ kind: "none" });
  });

  it("names a prediction by its reason and its keys, not by its time or the order of the keys", () => {
    expect(predictionOf({ at: 1, why: "message", keys: ["b", "a"] })).toBe(predictionOf({ at: 99, why: "message", keys: ["a", "b"] }));
    expect(predictionOf({ at: 1, why: "message", keys: ["a"] })).not.toBe(predictionOf({ at: 1, why: "message", keys: ["a", "b"] }));
    expect(predictionOf({ at: 1, why: "keep-alive", keys: ["a"] })).not.toBe(predictionOf({ at: 1, why: "message", keys: ["a"] }));
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
    expect(step({ session: { ...warm, lastReadyAt: target.at + 5, lastPingAt: target.at + 5 }, nowSeconds: target.at + config.graceSeconds })).toEqual({ kind: "hold" });
    expect(step({ session: { ...warm, lastReadyAt: target.at + 5 }, nowSeconds: target.at + config.graceSeconds + 1 })).toEqual({ kind: "end", reason: "grace" });
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

  it("ends a session at once when no proof is forecast: the decision says not due (minimum interval, retry wait), no hold to the grace", () => {
    expect(step({ session: warm, targets: [] })).toEqual({ kind: "end", reason: "unusable" });
    expect(step({ session: warming, targets: [] })).toEqual({ kind: "end", reason: "unusable" });
    // Past the due time, inside the grace: the real proof was refused, so the worker is released now.
    expect(step({ session: warm, targets: [], nowSeconds: target.at + 1 })).toEqual({ kind: "end", reason: "unusable" });
  });

  it("ends a session whose proof moved further off than the lead time and a ping interval; keeps one still inside it", () => {
    const now = target.at - 60;
    const later = (seconds: number): WarmupTarget => ({ ...target, at: now + seconds });
    expect(step({ session: warm, nowSeconds: now, targets: [later(lead + config.intervalSeconds)] })).toEqual({ kind: "none" });
    expect(step({ session: warm, nowSeconds: now, targets: [later(lead + config.intervalSeconds + 1)] })).toEqual({ kind: "end", reason: "unusable" });
  });

  it("ends a warm session at its next hold once the daily cap is spent", () => {
    expect(step({ session: warm, capReached: true })).toEqual({ kind: "none" });
    expect(step({ session: warm, capReached: true, nowSeconds: target.at - 60 + config.holdIntervalSeconds })).toEqual({ kind: "end", reason: "cap" });
  });
});

describe("holding with the default idle timeout of 5 s", () => {
  const fast = DEFAULT_WARMUP;
  const target: WarmupTarget = { at: 10_000, why: "message", keys: ["a"] };
  const warm: WarmupSession = { phase: "warm", id: "s", target, startedAt: 9_900, readyAt: 9_950, lastReadyAt: 9_950, lastPingAt: 9_950, holds: 0 };
  const step = (session: WarmupSession, nowSeconds: number) =>
    warmupStep({ nowSeconds, targets: [target], live: new Set(["a"]), session, config: fast, leadSeconds: 90, pingOutstanding: false, capReached: false, jobActive: false, predictionStarted: () => false });

  it("derives a 3 s hold under the 5 s idle timeout", () => {
    expect(fast.idleTimeoutSeconds).toBe(5);
    expect(fast.holdIntervalSeconds).toBe(3);
    expect(fast.holdIntervalSeconds).toBe(holdIntervalFor(fast.idleTimeoutSeconds));
    expect(holdIntervalFor(60)).toBe(58);
    expect(holdIntervalFor(1)).toBe(1);
    expect(fast.syncIdleTimeout).toBe(true);
  });

  it("pings a ready worker 3 s after its last ready answer, before the 5 s timeout stops it", () => {
    expect(nextHoldAt(warm, fast)).toBe(9_953);
    expect(step(warm, 9_952)).toEqual({ kind: "none" });
    expect(step(warm, 9_953)).toEqual({ kind: "hold" });
    // The next hold follows the answer to this one, again 3 s later: the worker never idles 5 s.
    expect(nextHoldAt({ ...warm, lastReadyAt: 9_953, lastPingAt: 9_953 }, fast)).toBe(9_956);
    expect(nextHoldAt(warm, fast) - warm.lastReadyAt).toBeLessThan(fast.idleTimeoutSeconds);
  });
});
