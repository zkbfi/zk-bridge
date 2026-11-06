import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { openStorage } from "../src/storage.ts";
import { findActiveJob, findLatestJob, getJob, getRequest, insertJob, insertRequest, pruneRequests, recentCallersOfAll, recentRequestsOfCaller, updateJob } from "../src/requests/jobs.ts";

const tables = (storage: ReturnType<typeof openStorage>) =>
  (storage.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);

describe("storage", () => {
  it("adds the billed time to a warm-up table of before 2026-11-06, keeping its rows", () => {
    const directory = mkdtempSync(join(tmpdir(), "backend-storage-"));
    try {
      const path = join(directory, "backend.sqlite");
      const old = new DatabaseSync(path);
      old.exec("CREATE TABLE warmup_sessions (id TEXT PRIMARY KEY, direction TEXT NOT NULL, why TEXT NOT NULL, due_at INTEGER NOT NULL, lead_seconds INTEGER NOT NULL, started_at INTEGER NOT NULL, ready_at INTEGER, ended_at INTEGER, outcome TEXT)");
      old.exec("INSERT INTO warmup_sessions (id, direction, why, due_at, lead_seconds, started_at, ended_at, outcome) VALUES ('a', 'first-to-second', 'message', 1, 60, 0, 5000, 'used')");
      old.close();
      const storage = openStorage(path);
      expect(storage.database.prepare("SELECT id, billed_seconds AS billed FROM warmup_sessions").all()).toEqual([{ id: "a", billed: null }]);
      storage.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("creates the four tables in one file and keeps the data after a reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "backend-storage-"));
    try {
      const path = join(directory, "backend.sqlite");
      const first = openStorage(path);
      expect(tables(first)).toEqual(expect.arrayContaining(["evidence", "jobs", "proofs", "requests"]));
      insertJob(first, { id: "job-1", direction: "first-to-second", now: 5 });
      first.close();
      const second = openStorage(path);
      expect(findActiveJob(second, "first-to-second")?.id).toBe("job-1");
      second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("lets only one job per direction be queued or proving", () => {
    const storage = openStorage(":memory:");
    insertJob(storage, { id: "a", direction: "first-to-second", now: 1 });
    expect(() => insertJob(storage, { id: "b", direction: "first-to-second", now: 2 })).toThrow(/UNIQUE/);
    insertJob(storage, { id: "c", direction: "second-to-first", now: 2 });
    updateJob(storage, "a", { status: "failed", error: "x" }, 3, ["queued"]);
    insertJob(storage, { id: "d", direction: "first-to-second", now: 4 });
    expect(findLatestJob(storage, "first-to-second")?.id).toBe("d");
  });

  it("finds a job by identifier, or null", () => {
    const storage = openStorage(":memory:");
    insertJob(storage, { id: "a", direction: "first-to-second", now: 1 });
    expect(getJob(storage, "a")?.status).toBe("queued");
    expect(getJob(storage, "missing")).toBeNull();
  });

  it("changes a job only from an expected status and says whether it changed", () => {
    const storage = openStorage(":memory:");
    insertJob(storage, { id: "a", direction: "first-to-second", now: 1 });
    expect(updateJob(storage, "a", { status: "failed" }, 2, ["proving"])).toBe(false);
    expect(getJob(storage, "a")?.status).toBe("queued");
    expect(updateJob(storage, "a", { status: "proving" }, 2, ["queued", "proving"])).toBe(true);
  });

  it("deletes request rows older than the cut, but never the rows of a queued or proving job", () => {
    const storage = openStorage(":memory:");
    insertJob(storage, { id: "done", direction: "first-to-second", now: 1 });
    updateJob(storage, "done", { status: "on-chain" }, 2, ["queued"]);
    insertJob(storage, { id: "waiting", direction: "second-to-first", now: 1 });
    const add = (id: string, jobId: string, caller: string, now: number) =>
      insertRequest(storage, { id, jobId, pair: "eth-pls", direction: "first-to-second", reason: "user", messageId: null, caller, now });
    add("r1", "done", "x", 100);
    add("r2", "done", "y", 200);
    add("r3", "done", "x", 300);
    add("r4", "waiting", "z", 50);
    expect(recentRequestsOfCaller(storage, "x", 150)).toEqual({ count: 1, oldest: 300 });
    expect(recentCallersOfAll(storage, 150)).toEqual({ count: 2, oldest: 200 });
    expect(pruneRequests(storage, 250)).toBe(2);
    expect(getRequest(storage, "r4")?.id).toBe("r4");
    expect(recentCallersOfAll(storage, 0)).toEqual({ count: 2, oldest: 50 });
    updateJob(storage, "waiting", { status: "failed" }, 3, ["queued"]);
    expect(pruneRequests(storage, 250)).toBe(1);
  });

  it("rolls a transaction back when the work throws, and passes the error on", () => {
    const storage = openStorage(":memory:");
    expect(() =>
      storage.transaction(() => {
        insertJob(storage, { id: "a", direction: "first-to-second", now: 1 });
        throw new Error("stop");
      }),
    ).toThrow("stop");
    expect(findActiveJob(storage, "first-to-second")).toBeNull();
    expect(storage.transaction(() => 7)).toBe(7);
  });

  it("keeps a field that an update leaves out, and sets one that it names", () => {
    const storage = openStorage(":memory:");
    insertJob(storage, { id: "a", direction: "first-to-second", now: 1 });
    updateJob(storage, "a", { status: "proving", startSlot: "5", newSlot: "9" }, 2, ["queued"]);
    updateJob(storage, "a", { status: "failed", error: "why" }, 3, ["proving"]);
    expect(findLatestJob(storage, "first-to-second")).toMatchObject({ status: "failed", startSlot: "5", newSlot: "9", error: "why", updatedAt: 3 });
    updateJob(storage, "a", { status: "published", startSlot: null, error: null }, 4, ["failed"]);
    expect(findLatestJob(storage, "first-to-second")).toMatchObject({ startSlot: null, newSlot: "9", error: null });
  });
});
