import { describe, expect, it } from "vitest";
import { openStorage } from "../src/storage.ts";
import { DEFAULT_WARMUP } from "../src/watch/warmup.ts";
import { CAP_WINDOW_MILLISECONDS, OBSERVATIONS_KEPT, SESSION_RETENTION_MILLISECONDS, createWarmupStore, noteJobWorkerWait } from "../src/watch/warmup-store.ts";

/** The settings before 2026-11-06 (p90, no margin, 90 s grace): the scenarios of these tests rest on them. */
const LEGACY_WARMUP = { ...DEFAULT_WARMUP, leadP: 0.9, leadMarginSeconds: 0, minLeadSeconds: 30, graceSeconds: 90 };

const HOUR = 3_600_000;
const T = 1_800_000_000_000;

function store() {
  const storage = openStorage(":memory:");
  return { storage, store: createWarmupStore(storage), count: (table: string) => (storage.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n };
}

describe("the warm-up record", () => {
  it("learns the lead time from the newest observations of both directions", () => {
    const { store: record } = store();
    expect(record.lead(LEGACY_WARMUP)).toEqual({ seconds: 90, basis: "default", observations: 0 });
    record.recordObservation({ direction: "first-to-second", source: "ping", seconds: 400, at: T });
    for (let index = 0; index < 20; index += 1) record.recordObservation({ direction: index % 2 === 0 ? "first-to-second" : "second-to-first", source: "job", seconds: 24 + index, at: T + index });
    // The 400 s pull is older than the newest twenty.
    expect(record.lead(LEGACY_WARMUP)).toEqual({ seconds: 41, basis: "observed", observations: 20 });
    expect(record.lead({ ...LEGACY_WARMUP, leadObservations: 21 })).toMatchObject({ seconds: 42 });
  });

  it("keeps a bounded number of observations", () => {
    const { store: record, count } = store();
    for (let index = 0; index < OBSERVATIONS_KEPT + 5; index += 1) record.recordObservation({ direction: "first-to-second", source: "ping", seconds: 30, at: T });
    expect(count("warmup_observations")).toBe(OBSERVATIONS_KEPT);
  });

  it("records sessions, and counts their seconds in the last 24 hours against the cap, open ones up to now", () => {
    const { store: record, storage } = store();
    expect(record.warmSecondsInWindow(T)).toBe(0);
    // Half inside the window: only the part inside counts.
    const old = record.openSession({ direction: "first-to-second", why: "message", dueAt: T, leadSeconds: 90, at: T - CAP_WINDOW_MILLISECONDS - 60_000 });
    record.endSession(old, "used", T - CAP_WINDOW_MILLISECONDS + 60_000, 60);
    const done = record.openSession({ direction: "second-to-first", why: "keep-alive", dueAt: T, leadSeconds: 90, at: T - HOUR });
    record.markReady(done, T - HOUR + 30_000);
    record.markReady(done, T - HOUR + 50_000);
    record.endSession(done, "grace", T - HOUR + 120_000, 60);
    record.endSession(done, "used", T, 60);
    const open = record.openSession({ direction: "first-to-second", why: "message", dueAt: T, leadSeconds: 90, at: T - 45_000 });
    expect(record.warmSecondsInWindow(T)).toBe(60 + 120 + 45);
    // A session that ended before the window counts nothing.
    expect(record.warmSecondsInWindow(T + CAP_WINDOW_MILLISECONDS + HOUR)).toBe(CAP_WINDOW_MILLISECONDS / 1000);
    const row = storage.database.prepare("SELECT ready_at, ended_at, outcome FROM warmup_sessions WHERE id = ?").get(done);
    // The first ready answer and the first end stay.
    expect(row).toEqual({ ready_at: T - HOUR + 30_000, ended_at: T - HOUR + 120_000, outcome: "grace" });
    expect(record.closeOpenSessions(T + 1000)).toBe(1);
    expect(storage.database.prepare("SELECT outcome, ended_at FROM warmup_sessions WHERE id = ?").get(open)).toEqual({ outcome: "restart", ended_at: T + 1000 });
    expect(record.closeOpenSessions(T + 2000)).toBe(0);
  });

  it("deletes ended sessions after a week", () => {
    const { store: record, count } = store();
    const old = record.openSession({ direction: "first-to-second", why: "message", dueAt: T, leadSeconds: 90, at: T });
    record.endSession(old, "used", T + 1000, 60);
    record.openSession({ direction: "first-to-second", why: "message", dueAt: T, leadSeconds: 90, at: T + SESSION_RETENTION_MILLISECONDS + 1000 });
    expect(count("warmup_sessions")).toBe(2);
    record.openSession({ direction: "first-to-second", why: "message", dueAt: T, leadSeconds: 90, at: T + SESSION_RETENTION_MILLISECONDS + 1001 });
    expect(count("warmup_sessions")).toBe(2);
  });

  it("knows whether a session of a direction ran at a time", () => {
    const { store: record } = store();
    const id = record.openSession({ direction: "first-to-second", why: "message", dueAt: T, leadSeconds: 90, at: T });
    expect(record.sessionAt("first-to-second", T - 1)).toBe(false);
    expect(record.sessionAt("first-to-second", T + 10_000)).toBe(true);
    expect(record.sessionAt("second-to-first", T + 10_000)).toBe(false);
    record.endSession(id, "used", T + 20_000, 60);
    expect(record.sessionAt("first-to-second", T + 20_000)).toBe(true);
    expect(record.sessionAt("first-to-second", T + 20_001)).toBe(false);
  });
});

describe("the billed time and the daily summary", () => {
  const DAY = 24 * HOUR;
  const day0 = Math.floor(T / DAY) * DAY;
  const config = { idleTimeoutSeconds: 60, gpuUsdPerHour: 3.6 };

  it("estimates the billed time of a session as its length plus the idle timeout, and of a restart as its length", () => {
    const { store: record, storage } = store();
    const id = record.openSession({ direction: "first-to-second", why: "message", dueAt: T, leadSeconds: 90, at: T });
    record.endSession(id, "grace", T + 100_000, 60);
    const open = record.openSession({ direction: "first-to-second", why: "message", dueAt: T, leadSeconds: 90, at: T });
    record.closeOpenSessions(T + 10_000);
    expect(storage.database.prepare("SELECT outcome, billed_seconds AS billed FROM warmup_sessions ORDER BY outcome").all()).toEqual([
      { outcome: "grace", billed: 160 },
      { outcome: "restart", billed: 10 },
    ]);
    expect(open).not.toBe(id);
  });

  it("sums the sessions per day: used and wasted, billed seconds, cost, and the seconds a worker sat ready before the due time", () => {
    const { store: record, storage } = store();
    const run = (offset: number, outcome: "used" | "unusable", lengthSeconds: number, readyBeforeDueSeconds: number | null) => {
      const start = day0 + offset;
      const id = record.openSession({ direction: "first-to-second", why: "message", dueAt: start + 60_000, leadSeconds: 60, at: start });
      if (readyBeforeDueSeconds !== null) record.markReady(id, start + 60_000 - readyBeforeDueSeconds * 1000);
      record.endSession(id, outcome, start + lengthSeconds * 1000, 60);
    };
    run(HOUR, "used", 90, 25);
    run(2 * HOUR, "used", 70, -5); // ready after the due time counts no idle
    run(3 * HOUR, "unusable", 20, null);
    run(DAY + HOUR, "used", 40, 5);
    // From before the billed time was recorded: estimated from its own times.
    run(DAY + 2 * HOUR, "used", 40, null);
    storage.database.prepare("UPDATE warmup_sessions SET billed_seconds = NULL WHERE started_at = ?").run(day0 + DAY + 2 * HOUR);
    // An open session is not counted yet.
    record.openSession({ direction: "first-to-second", why: "message", dueAt: T, leadSeconds: 60, at: day0 + DAY + 3 * HOUR });
    expect(record.summary(day0, config)).toEqual([
      { day: new Date(day0 + DAY).toISOString().slice(0, 10), sessions: 2, used: 2, wasted: 0, billedSeconds: 200, wastedSeconds: 0, idleBeforeDueSeconds: 5, estimatedCostUsd: 0.2, wastedCostUsd: 0 },
      { day: new Date(day0).toISOString().slice(0, 10), sessions: 3, used: 2, wasted: 1, billedSeconds: 360, wastedSeconds: 80, idleBeforeDueSeconds: 25, estimatedCostUsd: 0.36, wastedCostUsd: 0.08 },
    ]);
    // Only the sessions from the given time on.
    expect(record.summary(day0 + DAY, config)).toHaveLength(1);
  });
});

describe("noteJobWorkerWait", () => {
  const timing = (wait: number, notReady: number) => ({ wait_worker_ms: wait, not_ready_count: notReady, total_ms: 99_000 });

  it("keeps the wait of a job that met a cold worker while no warm-up ran", () => {
    const { store: record } = store();
    expect(noteJobWorkerWait(record, { direction: "first-to-second", startedAt: T, timing: timing(61_500, 3), at: T + 100_000 })).toEqual({ kind: "cold", seconds: 61.5 });
    expect(record.lead(LEGACY_WARMUP)).toMatchObject({ seconds: 62, basis: "observed" });
  });

  it("keeps nothing from a warm worker, an older prover, or a job that a warm-up covered", () => {
    const { store: record } = store();
    expect(noteJobWorkerWait(record, { direction: "first-to-second", startedAt: T, timing: timing(0, 0), at: T })).toEqual({ kind: "warm" });
    expect(noteJobWorkerWait(record, { direction: "first-to-second", startedAt: T, timing: null, at: T })).toEqual({ kind: "unknown" });
    expect(noteJobWorkerWait(record, { direction: "first-to-second", startedAt: T, timing: undefined, at: T })).toEqual({ kind: "unknown" });
    expect(noteJobWorkerWait(record, { direction: "first-to-second", startedAt: T, timing: { not_ready_count: 1, wait_worker_ms: "x" }, at: T })).toEqual({ kind: "unknown" });
    const id = record.openSession({ direction: "first-to-second", why: "message", dueAt: T, leadSeconds: 90, at: T - 60_000 });
    record.endSession(id, "used", T + 5_000, 60);
    expect(noteJobWorkerWait(record, { direction: "first-to-second", startedAt: T, timing: timing(20_000, 1), at: T + 90_000 })).toEqual({ kind: "missed", seconds: 20 });
    expect(record.lead(LEGACY_WARMUP)).toMatchObject({ basis: "default" });
  });
});
