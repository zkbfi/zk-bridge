import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { forkProofRecordFixture } from "../../../shared/test/support/fork-proof-fixture";
import { registerProofRoutes } from "../../src/api/routes/proofs";
import { backendRowsSchema, ingestBackendRows, readBackendSnapshot } from "../../src/proof-archive/backend-rows";
import { exportArchive, importArchive, importRecords, listFiles } from "../../src/proof-archive/bundle";
import { main, type CliDependencies } from "../../src/proof-archive/cli";
import { importMirror, mirrorFile, writeMirrorRecords } from "../../src/proof-archive/mirror";
import { checkPublicTree, exportPublicTree, PUBLIC_README } from "../../src/proof-archive/public";
import { forkProofArchiveRecord } from "../../src/proof-archive/records";
import { freshArchive } from "./support/proof-archive-fixtures";

/**
 * The fork proofs: the `sourceFork` of each source beacon block that carries a message, kept for good because PulseChain
 * nodes prune old states. Several messages of one block share one record; the key is the chain and the state root.
 */

const CHAIN = 943;
const first = forkProofRecordFixture({ seed: 0x10, slot: 5678, executionBlockNumber: 1234 });
const second = forkProofRecordFixture({ seed: 0x20, slot: 6000, executionBlockNumber: 1300 });
const third = forkProofRecordFixture({ seed: 0x30, slot: 100, executionBlockNumber: 50, depth: 5 });
/** The same key as `first` with another text: a valid record of the same state with another slot. */
const rival = forkProofRecordFixture({ seed: 0x10, slot: 5679, executionBlockNumber: 1234 });

const row = (fixture = first, overrides: Partial<{ chainId: number; stateRoot: string; record: string; storedAt: number }> = {}) => ({ chainId: CHAIN, stateRoot: fixture.stateRoot, record: fixture.text, storedAt: 1_700_000_000_000, ...overrides });

const built = (fixture = first, overrides: Partial<Parameters<typeof forkProofArchiveRecord>[0]> = {}) => {
  const checked = forkProofArchiveRecord({ chainId: CHAIN, stateRoot: fixture.stateRoot, record: fixture.text, storedAt: 5, source: "backend", ...overrides });
  if (!checked.ok) throw new Error(checked.reason);
  return checked.record;
};

let directory: string;
let stderr: MockInstance<typeof process.stderr.write>;
const logged = () => stderr.mock.calls.map((call) => String(call[0])).join("");
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "fork-proofs-"));
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(async () => {
  stderr.mockRestore();
  await rm(directory, { recursive: true, force: true });
});

describe("the validation of a fork proof", { timeout: 60_000 }, () => {
  it("accepts a good record and reads its fields and hash from the text", () => {
    expect(built()).toEqual({
      chainId: CHAIN,
      stateRoot: first.stateRoot,
      slot: 5678,
      blockRoot: first.value.blockRoot,
      executionBlockNumber: 1234,
      executionBlockHash: first.value.executionBlockHash,
      shape: 6,
      record: first.text,
      sha256: createHash("sha256").update(first.text).digest("hex"),
      storedAt: 5,
      source: "backend",
    });
    expect(built(first, { stateRoot: first.stateRoot.toUpperCase().replace("0X", "0x") }).stateRoot).toBe(first.stateRoot);
  });

  it("refuses what does not hold together, with a reason that never holds the text", () => {
    const reason = (input: Partial<Parameters<typeof forkProofArchiveRecord>[0]>) => {
      const checked = forkProofArchiveRecord({ chainId: CHAIN, stateRoot: first.stateRoot, record: first.text, storedAt: null, source: "backend", ...input });
      return checked.ok ? null : checked.reason;
    };
    expect(reason({ record: "{nope" })).toBe("not JSON");
    expect(reason({ chainId: 944 })).toBe("another chain");
    expect(reason({ stateRoot: second.stateRoot })).toBe("another state root");
    expect(reason({ chainId: 0, record: forkProofRecordFixture({ chainId: 0 }).text })).toBe("the chain is out of range");
    expect(reason({ chainId: 2 ** 31, record: forkProofRecordFixture({ chainId: 2 ** 31 }).text })).toBe("the chain is out of range");
    const tampered = { ...first.value, version: "0x90000076" };
    expect(reason({ record: JSON.stringify(tampered) })).not.toBeNull();
    // A shape that the check does not know is refused by the check itself, so it never reaches the integer column.
    expect(reason({ record: JSON.stringify({ ...first.value, shape: 2 ** 31 }) })).not.toBeNull();
  });
});

describe("the fork proof table", { timeout: 60_000 }, () => {
  it("is created by the migration (version 3), is additive, upserts once, and never deletes", async () => {
    const { archive, sql } = await freshArchive();
    await archive.migrate();
    await archive.migrate();
    expect((await sql.query("SELECT version FROM proof_archive.schema_version ORDER BY version")).rows).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    expect(await archive.putForkProof(built())).toBe("inserted");
    expect(await archive.putForkProof(built(first, { storedAt: 999, source: "import" }))).toBe("unchanged");
    expect(await archive.forkProof(CHAIN, first.stateRoot)).toEqual(built());
    expect(await archive.forkProof(CHAIN, first.stateRoot.toUpperCase().replace("0X", "0x"))).toEqual(built());
    expect(await archive.forkProof(CHAIN, second.stateRoot)).toBeNull();
    expect(await archive.forkProof(1, first.stateRoot)).toBeNull();
    expect(await archive.putForkProof(built(second))).toBe("inserted");
    expect(await archive.putForkProof(built(third))).toBe("inserted");
    expect(await archive.putForkProof(built(first, { chainId: 1, record: forkProofRecordFixture({ seed: 0x10, chainId: 1 }).text, storedAt: null }))).toBe("inserted");
    expect((await archive.forkProof(1, first.stateRoot))?.storedAt).toBeNull();
    expect((await archive.counts()).forkProofs).toBe(4);
    const all: unknown[] = [];
    for await (const page of archive.pages("fork_proofs")) all.push(...page);
    expect(all).toHaveLength(4);
  });

  it("lists a chain ascending by slot from a slot, with a limit", async () => {
    const { archive } = await freshArchive();
    for (const fixture of [second, first, third]) await archive.putForkProof(built(fixture));
    const entry = (fixture: typeof first) => ({ slot: fixture.value.slot, stateRoot: fixture.stateRoot, blockRoot: fixture.value.blockRoot, executionBlockNumber: fixture.value.executionBlockNumber });
    expect(await archive.forkProofs({ chainId: CHAIN, fromSlot: 0n, limit: 10 })).toEqual([entry(third), entry(first), entry(second)]);
    expect(await archive.forkProofs({ chainId: CHAIN, fromSlot: 5678n, limit: 10 })).toEqual([entry(first), entry(second)]);
    expect(await archive.forkProofs({ chainId: CHAIN, fromSlot: 0n, limit: 1 })).toEqual([entry(third)]);
    expect(await archive.forkProofs({ chainId: 5, fromSlot: 0n, limit: 10 })).toEqual([]);
  });

  it("keeps the first record and records a conflict for a different one, once", async () => {
    const { archive, sql } = await freshArchive();
    await archive.putForkProof(built());
    const other = built(rival);
    expect(await archive.putForkProof(other)).toBe("conflict");
    expect(await archive.putForkProof(other)).toBe("conflict");
    expect((await archive.forkProof(CHAIN, first.stateRoot))?.record).toBe(first.text);
    const conflicts = (await sql.query<{ table_name: string; column_name: string }>("SELECT table_name, column_name FROM proof_archive.conflicts ORDER BY column_name")).rows;
    expect(conflicts.map((item) => item.table_name)).toEqual(Array(conflicts.length).fill("proof_archive.fork_proofs"));
    expect(conflicts.map((item) => item.column_name)).toEqual(["record", "sha256", "slot"]);
  });
});

describe("ingest from the backend", { timeout: 60_000 }, () => {
  it("takes the fork proofs of the live poll, refuses and counts a bad one, and reports a conflict", async () => {
    const { archive } = await freshArchive();
    const rows = backendRowsSchema.parse({ forkProofs: [row(), row(second, { record: "{" })] });
    expect(await ingestBackendRows(archive, "p", rows)).toEqual({ inserted: 1, unchanged: 0, merged: 0, conflict: 0, invalid: 1 });
    expect(logged()).toContain('"event":"proof_archive_fork_proof_refused"');
    expect(logged()).toContain(second.stateRoot);
    expect(logged()).not.toContain("versionBranch");
    expect(await ingestBackendRows(archive, "p", rows)).toMatchObject({ unchanged: 1, invalid: 1 });
    expect(await ingestBackendRows(archive, "p", backendRowsSchema.parse({ forkProofs: [row(first, { record: rival.text })] }))).toMatchObject({ conflict: 1 });
    expect(logged()).toContain('"event":"proof_archive_conflict"');
    expect(backendRowsSchema.parse({}).forkProofs).toEqual([]);
    expect((await archive.forkProof(CHAIN, first.stateRoot))?.storedAt).toBe(1_700_000_000_000);
  });

  it("reads the table of a snapshot, and a snapshot without it as none", async () => {
    const path = join(directory, "backend.sqlite");
    const database = new DatabaseSync(path);
    database.exec(
      "CREATE TABLE fork_proofs (chain_id INTEGER, state_root TEXT, slot INTEGER, block_root TEXT, execution_block_number INTEGER, execution_block_hash TEXT, record TEXT, sha256 TEXT, stored_at INTEGER, PRIMARY KEY (chain_id, state_root))",
    );
    database.prepare("INSERT INTO fork_proofs VALUES (?, ?, 1, 'x', 1, 'x', ?, 'x', ?)").run(CHAIN, first.stateRoot, first.text, 77);
    database.close();
    const { rows } = readBackendSnapshot(path);
    expect(rows.forkProofs).toEqual([{ chainId: CHAIN, stateRoot: first.stateRoot, record: first.text, storedAt: 77 }]);
    const { archive } = await freshArchive();
    expect(await ingestBackendRows(archive, "p", rows)).toMatchObject({ inserted: 1 });
    expect((await archive.forkProof(CHAIN, first.stateRoot))?.storedAt).toBe(77);
    const old = join(directory, "old.sqlite");
    new DatabaseSync(old).close();
    expect(readBackendSnapshot(old).rows.forkProofs).toEqual([]);
  });

  it("is reported by the command line", async () => {
    const path = join(directory, "backend.sqlite");
    const database = new DatabaseSync(path);
    database.exec("CREATE TABLE fork_proofs (chain_id INTEGER, state_root TEXT, record TEXT, stored_at INTEGER)");
    database.prepare("INSERT INTO fork_proofs VALUES (?, ?, ?, 1)").run(CHAIN, first.stateRoot, first.text);
    database.close();
    const { archive } = await freshArchive();
    const out: string[] = [];
    const dependencies: CliDependencies = { openArchive: async () => ({ archive, close: async () => {} }), stateRoot: () => async () => null, now: () => new Date(0), print: (line) => out.push(line), log: () => {} };
    expect(await main(["ingest-backend", "--sqlite", path], {}, dependencies)).toBe(0);
    expect(JSON.parse(out[0] as string)).toMatchObject({ ingested: { inserted: 1, invalid: 0 }, rows: { forkProofs: 1 } });
  });
});

describe("the mirror and the bundle", { timeout: 60_000 }, () => {
  it("writes a record file for good under fork-proofs/<chain>/<state root>.<sha256>.json, once", async () => {
    const { archive } = await freshArchive();
    await archive.putForkProof(built());
    const mirror = join(directory, "mirror");
    expect((await writeMirrorRecords(archive, mirror)).written["fork-proofs"]).toBe(1);
    const file = mirrorFile("fork-proofs", built());
    expect(file.path).toBe(`fork-proofs/${CHAIN}/${first.stateRoot}.${createHash("sha256").update(file.text).digest("hex")}.json`);
    expect(await listFiles(mirror)).toEqual([file.path]);
    expect(await readFile(join(mirror, file.path), "utf8")).toBe(file.text);
    expect(await writeMirrorRecords(archive, mirror)).toMatchObject({ identical: 1, conflicts: [] });
  });

  it("imports into a fresh archive, refusing a record whose text, hash or fields do not hold", async () => {
    const { archive: source } = await freshArchive();
    await source.putForkProof(built());
    const mirror = join(directory, "mirror");
    await writeMirrorRecords(source, mirror);
    const { archive } = await freshArchive();
    expect((await importMirror(archive, mirror)).fork_proofs).toEqual({ inserted: 1, unchanged: 0, merged: 0, conflict: 0, invalid: 0 });
    expect((await importMirror(archive, mirror)).fork_proofs.unchanged).toBe(1);
    expect(await archive.forkProof(CHAIN, first.stateRoot)).toEqual(built());

    const good = built();
    const put = async (name: string, value: unknown) => {
      const bad = mirrorFile("fork-proofs", value as Record<string, unknown>);
      const path = bad.path.replace(`/${CHAIN}/`, "/1/").replace(first.stateRoot, `0x${name.repeat(64)}`);
      await mkdir(join(mirror, path, ".."), { recursive: true });
      await writeFile(join(mirror, path), bad.text);
    };
    await put("1", { ...good, sha256: "0".repeat(64) });
    await put("2", { ...good, slot: 1 });
    await put("3", { ...good, record: "{" });
    await put("4", { ...good, chainId: "x" });
    const fresh = await freshArchive();
    const result = (await importMirror(fresh.archive, mirror)).fork_proofs;
    expect(result.inserted).toBe(1);
    expect(result.invalid).toBeGreaterThanOrEqual(4);
  });

  it("reports a different record under the same key as a conflict", async () => {
    const { archive } = await freshArchive();
    await archive.putForkProof(built());
    const { archive: other } = await freshArchive();
    await other.putForkProof(built(rival));
    const mirror = join(directory, "mirror");
    await writeMirrorRecords(other, mirror);
    expect((await importMirror(archive, mirror)).fork_proofs.conflict).toBe(1);
  });

  it("round-trips through a bundle", async () => {
    const { archive } = await freshArchive();
    await archive.putForkProof(built());
    const bundle = join(directory, "bundle");
    expect((await exportArchive(archive, bundle)).fork_proofs).toBe(1);
    const { archive: target } = await freshArchive();
    expect((await importArchive(target, bundle)).fork_proofs.inserted).toBe(1);
    expect((await exportPublicTree({ kind: "bundle", bundle }, join(directory, "tree"))).forkProofs).toBe(1);
    async function* none(): AsyncGenerator<unknown> {}
    async function* junk(): AsyncGenerator<unknown> {
      yield undefined;
      yield "x";
    }
    expect(await importRecords(target, { storage: none(), lightClient: none(), evidence: none(), handoffs: none(), forkProofs: junk() })).toMatchObject({ fork_proofs: { invalid: 2 } });
  });
});

describe("the public tree", { timeout: 60_000 }, () => {
  it("holds exactly the record text at fork-proofs/<chain>/<state root>.json, from the archive or the mirror, and passes the sanitizer", async () => {
    const { archive } = await freshArchive();
    await archive.putForkProof(built());
    const mirror = join(directory, "mirror");
    await writeMirrorRecords(archive, mirror);
    const fromArchive = join(directory, "a");
    const fromMirror = join(directory, "m");
    expect((await exportPublicTree({ kind: "archive", archive }, fromArchive)).forkProofs).toBe(1);
    expect((await exportPublicTree({ kind: "mirror", mirror }, fromMirror)).forkProofs).toBe(1);
    for (const tree of [fromArchive, fromMirror]) {
      expect(await readFile(join(tree, "fork-proofs", String(CHAIN), `${first.stateRoot}.json`), "utf8")).toBe(first.text);
      expect(await checkPublicTree(tree)).toEqual([]);
    }
    expect(PUBLIC_README).toContain("fork-proofs/<chain id>/<state root>.json");
  });

  it("refuses a record that does not parse", async () => {
    const bundle = join(directory, "bundle");
    await mkdir(join(bundle, "archive"), { recursive: true });
    await writeFile(join(bundle, "archive", "fork_proofs.ndjson"), "{}\n");
    await expect(exportPublicTree({ kind: "bundle", bundle }, join(bundle, "out"))).rejects.toThrow("a fork proof record does not parse");
    await writeFile(join(bundle, "archive", "fork_proofs.ndjson"), `${JSON.stringify({ ...built(), record: "{" })}\n`);
    await expect(exportPublicTree({ kind: "bundle", bundle }, join(bundle, "out"))).rejects.toThrow("a fork proof record does not parse");
  });

  it("sanitizer: a fork proof file must be valid for its path and must hold nothing but chain data", async () => {
    const tree = join(directory, "tree");
    const put = async (path: string, body: string) => {
      await mkdir(join(tree, path, ".."), { recursive: true });
      await writeFile(join(tree, path), body);
    };
    await put(`fork-proofs/${CHAIN}/${first.stateRoot}.json`, first.text);
    expect(await checkPublicTree(tree)).toEqual([]);
    await put(`fork-proofs/${CHAIN}/${second.stateRoot}.json`, first.text);
    await put(`fork-proofs/1/${first.stateRoot}.json`, first.text);
    await put(`fork-proofs/${CHAIN}/${third.stateRoot}.json`, "{");
    await put(`fork-proofs/${CHAIN}/0x${"AB".repeat(32)}.json`, first.text);
    await put("fork-proofs/notes.txt", "x");
    const problems = await checkPublicTree(tree);
    expect(problems.map((item) => `${item.file}: ${item.reason}`).sort()).toEqual([
      `fork-proofs/${CHAIN}/0x${"AB".repeat(32)}.json: is not at an allowed path`,
      `fork-proofs/${CHAIN}/${second.stateRoot}.json: is not a valid fork proof for its path`,
      `fork-proofs/${CHAIN}/${third.stateRoot}.json: is not a valid fork proof for its path`,
      `fork-proofs/1/${first.stateRoot}.json: is not a valid fork proof for its path`,
      "fork-proofs/notes.txt: is not at an allowed path",
    ].sort());
  });

  it("sanitizer: a valid record that carries a URL is refused", async () => {
    const tree = join(directory, "tree");
    // A record with an extra field is still a valid record to the check; the general scan catches what it holds.
    const text = JSON.stringify({ ...first.value, note: "see https://rpc.example/x" });
    await mkdir(join(tree, "fork-proofs", String(CHAIN)), { recursive: true });
    await writeFile(join(tree, "fork-proofs", String(CHAIN), `${first.stateRoot}.json`), text);
    expect((await checkPublicTree(tree)).map((item) => item.reason)).toEqual(["looks like a URL"]);
  });
});

describe("the read routes", { timeout: 60_000 }, () => {
  const app = (archive: Parameters<typeof registerProofRoutes>[1]) => {
    const hono = new Hono();
    registerProofRoutes(hono, archive);
    return hono;
  };

  it("list the entries, serve the record text byte for byte, and count", async () => {
    const { archive } = await freshArchive();
    for (const fixture of [second, first, third]) await archive.putForkProof(built(fixture));
    const routes = app(async () => archive);
    const listed = (await (await routes.request(`/api/proofs/fork-proofs/${CHAIN}`)).json()) as { entries: Array<Record<string, unknown>> };
    expect(listed.entries.map((item) => item.slot)).toEqual([100, 5678, 6000]);
    expect(Object.keys(listed.entries[0] as object).sort()).toEqual(["blockRoot", "executionBlockNumber", "slot", "stateRoot"]);
    expect(((await (await routes.request(`/api/proofs/fork-proofs/${CHAIN}?fromSlot=5678&limit=1`)).json()) as { entries: unknown[] }).entries).toHaveLength(1);
    expect(await (await routes.request("/api/proofs/fork-proofs/5")).json()).toEqual({ entries: [] });
    const file = await routes.request(`/api/proofs/fork-proofs/${CHAIN}/${first.stateRoot}.json`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("application/json");
    expect(await file.text()).toBe(first.text);
    expect(await (await routes.request(`/api/proofs/fork-proofs/${CHAIN}/${first.stateRoot.toUpperCase().replace("0X", "0x")}.json`)).text()).toBe(first.text);
    expect((await routes.request(`/api/proofs/fork-proofs/${CHAIN}/0x${"00".repeat(32)}.json`)).status).toBe(404);
    for (const bad of [`/${CHAIN}/${first.stateRoot}`, `/${CHAIN}/${first.stateRoot}.json.bak`, `/${CHAIN}/0x12.json`, `/x/${first.stateRoot}.json`, `/99999999999/${first.stateRoot}.json`]) {
      expect((await routes.request(`/api/proofs/fork-proofs${bad}`)).status, bad).toBe(400);
    }
    for (const bad of ["/x", "/99999999999", `/${CHAIN}?fromSlot=x`, `/${CHAIN}?limit=0`, `/${CHAIN}?limit=501`, `/${CHAIN}?limit=x`]) {
      expect((await routes.request(`/api/proofs/fork-proofs${bad}`)).status, bad).toBe(400);
    }
    expect(await (await routes.request("/api/proofs/summary")).json()).toMatchObject({ forkProofs: 3 });
  });

  it("answer 503 while the archive is off", async () => {
    const routes = app(async () => null);
    for (const path of ["/api/proofs/fork-proofs/1", `/api/proofs/fork-proofs/1/${first.stateRoot}.json`]) expect((await routes.request(path)).status, path).toBe(503);
  });
});
