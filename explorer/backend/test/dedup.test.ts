import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { describeHeld, isStale, pendingFrom, readHeldProofs, type HeldProof } from "../src/requests/held-proofs.ts";
import { insertJob, updateJob } from "../src/requests/jobs.ts";
import { DEFAULT_RATE_LIMITS } from "../src/requests/rate-limit.ts";
import { createRequestService } from "../src/requests/service.ts";
import { openStorage, type Storage } from "../src/storage.ts";
import { ensureProofTable } from "../src/webhook/receive.ts";
import { controllableProver, fakeProofNeed, makeBackend, makeClock, makeProofPackage, memoryLogger, postFrom } from "./support.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const keepOnBoard = (storage: Storage, startSlot: number, newSlot: number, storedAt: number) =>
  storage.database.prepare("INSERT OR REPLACE INTO proofs (direction, job_id, start_slot, new_slot, body, stored_at) VALUES ('first-to-second', NULL, ?, ?, '0x', ?)").run(String(startSlot), String(newSlot), storedAt);

describe("the proofs we have", () => {
  it("are read from the board, the webhook store and the newest job", () => {
    const storage = openStorage(":memory:");
    expect(readHeldProofs(storage, "first-to-second")).toEqual([]);
    keepOnBoard(storage, 100, 200, 5);
    ensureProofTable(storage);
    insertJob(storage, { id: "j1", direction: "first-to-second", now: 1 });
    storage.database.prepare("INSERT INTO webhook_proofs (job_id, direction, payload, start_slot, new_slot, stored_at) VALUES ('j1', 'first-to-second', '0x', '100', '210', 7)").run();
    // A queued job has no slots yet.
    expect(readHeldProofs(storage, "first-to-second")).toEqual([
      { startSlot: 100, newSlot: 200, where: "board", since: 5 },
      { startSlot: 100, newSlot: 210, where: "stored", since: 7 },
    ]);
    updateJob(storage, "j1", { status: "proving", startSlot: "100", newSlot: "220" }, 9, ["queued"]);
    expect(readHeldProofs(storage, "first-to-second").at(-1)).toEqual({ startSlot: 100, newSlot: 220, where: "job", since: 9 });
    updateJob(storage, "j1", { status: "published" }, 11, ["proving"]);
    expect(readHeldProofs(storage, "first-to-second").at(-1)).toMatchObject({ where: "job", since: 11 });
    // A job that ended is not a proof that waits; nor is one of the other direction.
    updateJob(storage, "j1", { status: "failed" }, 12, ["published"]);
    expect(readHeldProofs(storage, "first-to-second").map((proof) => proof.where)).toEqual(["board", "stored"]);
    expect(readHeldProofs(storage, "second-to-first")).toEqual([]);
  });

  it("the one that can still land reaches furthest from the head; a tie goes to the oldest", () => {
    const held: HeldProof[] = [
      { startSlot: 90, newSlot: 300, where: "board", since: 1 },
      { startSlot: 100, newSlot: 100, where: "job", since: 1 },
      { startSlot: 100, newSlot: 200, where: "stored", since: 5 },
      { startSlot: 100, newSlot: 250, where: "job", since: 9 },
      { startSlot: 100, newSlot: 250, where: "board", since: 3 },
      { startSlot: 100, newSlot: 250, where: "stored", since: 4 },
    ];
    expect(pendingFrom(held, 100)).toEqual({ startSlot: 100, newSlot: 250, where: "board", since: 3 });
    expect(pendingFrom(held, 250)).toBeNull();
    expect(isStale({ startSlot: 1, newSlot: 2, where: "board", since: 0 }, 600_000, 600)).toBe(false);
    expect(isStale({ startSlot: 1, newSlot: 2, where: "board", since: 0 }, 600_001, 600)).toBe(true);
    expect(describeHeld({ startSlot: 1, newSlot: 2, where: "stored", since: 0 })).toBe("the proof from slot 1 to slot 2 (stored)");
  });
});

describe("the request service never re-proves a proof we have", () => {
  function service(storage: Storage, options: { need?: Parameters<typeof fakeProofNeed>[0]; clock?: ReturnType<typeof makeClock> } = {}) {
    const log = memoryLogger();
    const prover = controllableProver();
    const clock = options.clock ?? makeClock();
    const created = createRequestService({
      storage,
      proverForJob: () => prover.binary,
      readProofNeed: fakeProofNeed(options.need ?? { needed: true, why: "waiting-message", headSlot: 100 }).read,
      now: clock.now,
      limits: DEFAULT_RATE_LIMITS,
      proverTimeoutMilliseconds: 1_800_000,
      logger: log.logger,
    });
    const named = (name: string) => log.lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((event) => event.event === name);
    return { service: created, prover, clock, named };
  }

  it("refuses a request while a proof from the head waits to land, on the board or stored", async () => {
    const storage = openStorage(":memory:");
    const run = service(storage);
    keepOnBoard(storage, 100, 200, run.clock.now());
    expect(await run.service.submit({ pair: "eth-pls", direction: "first-to-second", reason: "user", caller: "a" })).toEqual({ refused: "nothing-to-prove", why: "proof-pending" });
    expect(run.named("proof_pending")).toMatchObject([{ startSlot: 100, newSlot: 200, where: "board", reason: "user", detail: "the proof from slot 100 to slot 200 (board) waits to land" }]);
    // The watcher names the head it read: the same check, from that head.
    expect(await run.service.submit({ pair: "eth-pls", direction: "first-to-second", reason: "finality", caller: "watch", target: { startSlot: 100, newSlot: 260 } })).toEqual({ refused: "nothing-to-prove", why: "proof-pending" });
    // A proof from another head is applied already, or can no longer land: it holds nothing back.
    expect(await run.service.submit({ pair: "eth-pls", direction: "first-to-second", reason: "finality", caller: "watch", target: { startSlot: 200, newSlot: 260 } })).toMatchObject({ jobId: expect.any(String) });
  });

  it("over HTTP too: the keep-alive march and the dapp get 409", async () => {
    const backend = makeBackend({ proofNeed: fakeProofNeed({ needed: true, why: "keep-alive", headSlot: 100 }) });
    keepOnBoard(backend.storage, 100, 200, backend.clock.now());
    const { init, env } = postFrom("10.0.0.1", { reason: "keep-alive" });
    const answer = await backend.app.request("/requests", init, env);
    expect(answer.status).toBe(409);
    expect(await answer.json()).toEqual({ error: "nothing-to-prove", why: "proof-pending" });
  });

  it("lets a new proof start once the pending one waited too long, and says so", async () => {
    const storage = openStorage(":memory:");
    const run = service(storage);
    keepOnBoard(storage, 100, 200, run.clock.now() - 601_000);
    expect(await run.service.submit({ pair: "eth-pls", direction: "first-to-second", reason: "user", caller: "a" })).toMatchObject({ jobId: expect.any(String) });
    expect(run.named("proof_pending_stale")).toMatchObject([{ startSlot: 100, newSlot: 200, where: "board", waitedSeconds: 601 }]);
  });

  it("a planned handoff with a handoff proof pending starts no second job", async () => {
    const storage = openStorage(":memory:");
    const run = service(storage, { need: { needed: false } });
    insertJob(storage, { id: "handoff", direction: "first-to-second", now: run.clock.now() });
    updateJob(storage, "handoff", { status: "published", startSlot: "100", newSlot: "8300" }, run.clock.now(), ["queued"]);
    run.clock.advance(120_000);
    expect(await run.service.submit({ pair: "eth-pls", direction: "first-to-second", reason: "finality", caller: "watch", plannedHandoff: true, target: { startSlot: 100, newSlot: 8400 } })).toEqual({ refused: "nothing-to-prove", why: "proof-pending" });
    expect(run.named("proof_pending")).toMatchObject([{ where: "job", startSlot: 100, newSlot: 8300 }]);
  });

  it("never starts a second job for the same target, also after a failure and a restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zkb-dedup-"));
    directories.push(directory);
    const file = join(directory, "backend.sqlite");
    const clock = makeClock();
    const before = service(openStorage(file), { clock });
    const request = { pair: "eth-pls", direction: "first-to-second", reason: "finality", caller: "watch", target: { startSlot: 100, newSlot: 200 } } as const;
    expect(await before.service.submit(request)).toMatchObject({ jobId: expect.any(String) });
    before.prover.failAll(new Error("worker lost"));
    await before.service.settled();
    // A restart, long after the retry wait.
    clock.advance(3_600_000);
    const after = service(openStorage(file), { clock });
    expect(await after.service.submit(request)).toEqual({ refused: "duplicate" });
    expect(await after.service.submit({ ...request, target: { startSlot: 100, newSlot: 232 } })).toMatchObject({ jobId: expect.any(String) });
    // The database refuses it too.
    const storage = openStorage(file);
    expect(() => insertJob(storage, { id: "again", direction: "first-to-second", now: clock.now(), target: { startSlot: 100, newSlot: 200 } })).toThrow(/UNIQUE/);
  });

  it("logs proof_duplicate when the prover reports the slots of an earlier job", async () => {
    const storage = openStorage(":memory:");
    const run = service(storage, { need: { needed: true, why: "waiting-message" } });
    await run.service.submit({ pair: "eth-pls", direction: "first-to-second", reason: "user", caller: "a" });
    run.prover.settleAll({ kind: "proof", proofPackage: makeProofPackage(10, 42) });
    await run.service.settled();
    const first = storage.database.prepare("SELECT id FROM jobs").get() as { id: string };
    updateJob(storage, first.id, { status: "on-chain" }, run.clock.now(), ["proving"]);
    run.clock.advance(120_000);
    await run.service.submit({ pair: "eth-pls", direction: "first-to-second", reason: "user", caller: "b" });
    run.prover.settleAll({ kind: "proof", proofPackage: makeProofPackage(10, 42) });
    await run.service.settled();
    expect(run.named("proof_duplicate")).toMatchObject([{ startSlot: 10, newSlot: 42, firstJobId: first.id }]);
  });
});

describe("the database of an older version", () => {
  it("gains the planned slots of a job and their unique index", () => {
    const directory = mkdtempSync(join(tmpdir(), "zkb-migrate-"));
    directories.push(directory);
    const file = join(directory, "old.sqlite");
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, direction TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, start_slot TEXT, new_slot TEXT, error TEXT)");
    old.exec("INSERT INTO jobs VALUES ('old', 'first-to-second', 'on-chain', 1, 1, '1', '2', NULL)");
    old.close();
    const storage = openStorage(file);
    const columns = (storage.database.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toContain("planned_start_slot");
    expect(columns).toContain("planned_new_slot");
    expect(storage.database.prepare("SELECT planned_start_slot FROM jobs WHERE id = 'old'").get()).toEqual({ planned_start_slot: null });
  });
});
