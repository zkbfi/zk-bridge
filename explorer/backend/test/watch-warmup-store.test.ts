import { describe, expect, it } from "vitest";
import { openStorage } from "../src/storage.ts";
import { DEFAULT_WARMUP } from "../src/watch/warmup.ts";
import { CAP_WINDOW_MILLISECONDS, OBSERVATIONS_KEPT, SESSION_RETENTION_MILLISECONDS, createWarmupStore, noteJobWorkerWait } from "../src/watch/warmup-store.ts";

const HOUR = 3_600_000;
const T = 1_800_000_000_000;

function store() {
  const storage = openStorage(":memory:");
  return { storage, store: createWarmupStore(storage), count: (table: string) => (storage.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n };
}

describe("the warm-up record", () => {
  it("learns the lead time from the newest observations of both directions", () => {
    const { store: record } = store();
    expect(record.lead(DEFAULT_WARMUP)).toEqual({ seconds: 90, basis: "default", observations: 0 });
    record.recordObservation({ direction: "first-to-second", source: "ping", seconds: 400, at: T });
    for (let index = 0; index < 20; index += 1) record.recordObservation({ direction: index % 2 === 0 ? "first-to-second" : "second-to-first", source: "job", seconds: 24 + index, at: T + index });
    // The 400 s pull is older than the newest twenty.
    expect(record.lead(DEFAULT_WARMUP)).toEqual({ seconds: 41, basis: "observed", observations: 20 });
    expect(record.lead({ ...DEFAULT_WARMUP, leadObservations: 21 })).toMatchObject({ seconds: 42 });
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
    record.endSession(old, "used", T - CAP_WINDOW_MILLISECONDS + 60_000);
    const done = record.openSession({ direction: "second-to-first", why: "keep-alive", dueAt: T, leadSeconds: 90, at: T - HOUR });
    record.markReady(done, T - HOUR + 30_000);
    record.markReady(done, T - HOUR + 50_000);
    record.endSession(done, "grace", T - HOUR + 120_000);
    record.endSession(done, "used", T);
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
    record.endSession(old, "used", T + 1000);
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
    record.endSession(id, "used", T + 20_000);
    expect(record.sessionAt("first-to-second", T + 20_000)).toBe(true);
    expect(record.sessionAt("first-to-second", T + 20_001)).toBe(false);
  });
});

describe("noteJobWorkerWait", () => {
  const timing = (wait: number, notReady: number) => ({ wait_worker_ms: wait, not_ready_count: notReady, total_ms: 99_000 });

  it("keeps the wait of a job that met a cold worker while no warm-up ran", () => {
    const { store: record } = store();
    expect(noteJobWorkerWait(record, { direction: "first-to-second", startedAt: T, timing: timing(61_500, 3), at: T + 100_000 })).toEqual({ kind: "cold", seconds: 61.5 });
    expect(record.lead(DEFAULT_WARMUP)).toMatchObject({ seconds: 62, basis: "observed" });
  });

  it("keeps nothing from a warm worker, an older prover, or a job that a warm-up covered", () => {
    const { store: record } = store();
    expect(noteJobWorkerWait(record, { direction: "first-to-second", startedAt: T, timing: timing(0, 0), at: T })).toEqual({ kind: "warm" });
    expect(noteJobWorkerWait(record, { direction: "first-to-second", startedAt: T, timing: null, at: T })).toEqual({ kind: "unknown" });
    expect(noteJobWorkerWait(record, { direction: "first-to-second", startedAt: T, timing: undefined, at: T })).toEqual({ kind: "unknown" });
    expect(noteJobWorkerWait(record, { direction: "first-to-second", startedAt: T, timing: { not_ready_count: 1, wait_worker_ms: "x" }, at: T })).toEqual({ kind: "unknown" });
    const id = record.openSession({ direction: "first-to-second", why: "message", dueAt: T, leadSeconds: 90, at: T - 60_000 });
    record.endSession(id, "used", T + 5_000);
    expect(noteJobWorkerWait(record, { direction: "first-to-second", startedAt: T, timing: timing(20_000, 1), at: T + 90_000 })).toEqual({ kind: "missed", seconds: 20 });
    expect(record.lead(DEFAULT_WARMUP)).toMatchObject({ basis: "default" });
  });
});
