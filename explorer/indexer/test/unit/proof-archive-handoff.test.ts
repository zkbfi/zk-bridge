import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { registerProofRoutes } from "../../src/api/routes/proofs";
import { backendRowsSchema, ingestBackendRows, readBackendSnapshot } from "../../src/proof-archive/backend-rows";
import { exportArchive, importArchive, listFiles, importRecords } from "../../src/proof-archive/bundle";
import { main, type CliDependencies } from "../../src/proof-archive/cli";
import { importMirror, mirrorFile, writeMirrorRecords } from "../../src/proof-archive/mirror";
import { canonicalJson, checkPublicTree, exportPublicTree, PUBLIC_README } from "../../src/proof-archive/public";
import { handoffRecord } from "../../src/proof-archive/records";
import { freshArchive } from "./support/proof-archive-fixtures";

/**
 * The handoff updates: the complete light client update of each sync-committee period of a source chain, captured by the
 * backend and kept for good, so that a light client that missed a period can still be moved over it.
 */

const HEX = `0x${"ab".repeat(32)}`;
const PERIOD = 100;
const FIRST_SLOT = PERIOD * 8192;

/** A record text as the backend writes it: compact, sorted keys. */
function text(overrides: Record<string, unknown> = {}): string {
  const value: Record<string, unknown> = {
    attestedSlot: FIRST_SLOT + 5000,
    chainId: 11155111,
    finalizedSlot: FIRST_SLOT + 4900,
    format: "zkb-handoff-update/1",
    nextSyncCommitteeRoot: HEX,
    period: PERIOD,
    signatureSlot: FIRST_SLOT + 5001,
    update: { attested_header: { beacon: { slot: String(FIRST_SLOT + 5000) } }, next_sync_committee: { pubkeys: [`0x${"cd".repeat(48)}`], aggregate_pubkey: `0x${"ef".repeat(48)}` }, sync_committee_bits: `0x${"ff".repeat(64)}` },
    ...overrides,
  };
  return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])));
}

const row = (overrides: Partial<{ chainId: number; period: number; record: string; storedAt: number }> = {}) => ({ chainId: 11155111, period: PERIOD, record: text(), storedAt: 1_700_000_000_000, ...overrides });

const built = (overrides: Partial<Parameters<typeof handoffRecord>[0]> = {}) => {
  const checked = handoffRecord({ chainId: 11155111, period: PERIOD, record: text(), storedAt: 5, source: "backend", ...overrides });
  if (!checked.ok) throw new Error(checked.reason);
  return checked.record;
};

let directory: string;
let stderr: MockInstance<typeof process.stderr.write>;
const logged = () => stderr.mock.calls.map((call) => String(call[0])).join("");
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "handoff-"));
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(async () => {
  stderr.mockRestore();
  await rm(directory, { recursive: true, force: true });
});

describe("the validation of a handoff update", { timeout: 60_000 }, () => {
  it("accepts a good record and reads its hash and slots from the text", () => {
    const record = built();
    expect(record).toEqual({
      chainId: 11155111,
      period: PERIOD,
      record: text(),
      sha256: createHash("sha256").update(text()).digest("hex"),
      attestedSlot: FIRST_SLOT + 5000,
      finalizedSlot: FIRST_SLOT + 4900,
      storedAt: 5,
      source: "backend",
    });
    expect(built({ record: text({ finalizedSlot: FIRST_SLOT + 5000 }) }).finalizedSlot).toBe(FIRST_SLOT + 5000);
  });

  it("refuses what does not hold together, with a reason that never holds the text", () => {
    const reason = (input: Partial<Parameters<typeof handoffRecord>[0]>) => {
      const checked = handoffRecord({ chainId: 11155111, period: PERIOD, record: text(), storedAt: null, source: "backend", ...input });
      return checked.ok ? null : checked.reason;
    };
    expect(reason({ record: "{nope" })).toBe("the record is not JSON");
    expect(reason({ record: "[1]" })).toBe("the record is not an object");
    expect(reason({ record: "null" })).toBe("the record is not an object");
    expect(reason({ record: text({ format: "zkb-handoff-update/2" }) })).toBe("the record has another format");
    expect(reason({ record: text({ chainId: 1 }) })).toBe("the chain or period differs from the key");
    expect(reason({ record: text({ chainId: "11155111" }) })).toBe("the chain or period differs from the key");
    expect(reason({ record: text({ period: PERIOD + 1 }) })).toBe("the chain or period differs from the key");
    expect(reason({ record: text({ period: String(PERIOD) }) })).toBe("the chain or period differs from the key");
    expect(reason({ chainId: 0, record: text({ chainId: 0 }) })).toBe("the chain or period is out of range");
    expect(reason({ chainId: 2 ** 31, record: text({ chainId: 2 ** 31 }) })).toBe("the chain or period is out of range");
    expect(reason({ period: 2 ** 31, record: text({ period: 2 ** 31, attestedSlot: 2 ** 31 * 8192, signatureSlot: 2 ** 31 * 8192, finalizedSlot: 0 }) })).toBe("the chain or period is out of range");
    expect(reason({ record: text({ attestedSlot: FIRST_SLOT - 1 }) })).toBe("a slot is not in the period");
    expect(reason({ record: text({ attestedSlot: FIRST_SLOT + 8192 }) })).toBe("a slot is not in the period");
    expect(reason({ record: text({ signatureSlot: FIRST_SLOT + 8192 }) })).toBe("a slot is not in the period");
    expect(reason({ record: text({ attestedSlot: 5000.5 }) })).toBe("a slot is not in the period");
    expect(reason({ record: text({ signatureSlot: "x" }) })).toBe("a slot is not in the period");
    expect(reason({ record: text({ finalizedSlot: FIRST_SLOT + 5001 }) })).toBe("the finalized slot is not a slot up to the attested one");
    expect(reason({ record: text({ finalizedSlot: -1 }) })).toBe("the finalized slot is not a slot up to the attested one");
    expect(reason({ record: text({ nextSyncCommitteeRoot: "0x12" }) })).toBe("the next sync committee root is not 32 bytes of hex");
    expect(reason({ record: text({ nextSyncCommitteeRoot: 5 }) })).toBe("the next sync committee root is not 32 bytes of hex");
    expect(reason({ record: text({ update: [] }) })).toBe("the update has no next sync committee");
    expect(reason({ record: text({ update: {} }) })).toBe("the update has no next sync committee");
    expect(reason({ record: text({ update: { next_sync_committee: [] } }) })).toBe("the update has no next sync committee");
  });
});

describe("the handoff update table", { timeout: 60_000 }, () => {
  it("is created by the migration (version 2), upserts once, and never deletes", async () => {
    const { archive, sql } = await freshArchive();
    await archive.migrate();
    expect((await sql.query("SELECT version FROM proof_archive.schema_version ORDER BY version")).rows).toEqual([{ version: 1 }, { version: 2 }]);
    expect(await archive.putHandoff(built())).toBe("inserted");
    expect(await archive.putHandoff(built({ storedAt: 999 }))).toBe("unchanged");
    expect(await archive.handoff(11155111, PERIOD)).toEqual(built());
    expect(await archive.handoff(11155111, PERIOD + 1)).toBeNull();
    expect(await archive.putHandoff(built({ period: PERIOD + 1, record: text({ period: PERIOD + 1, attestedSlot: (PERIOD + 1) * 8192 + 9, signatureSlot: (PERIOD + 1) * 8192 + 10, finalizedSlot: (PERIOD + 1) * 8192 }) }))).toBe("inserted");
    expect(await archive.putHandoff(built({ chainId: 943, record: text({ chainId: 943 }) }))).toBe("inserted");
    expect(await archive.handoffPeriods(11155111)).toEqual([PERIOD, PERIOD + 1]);
    expect(await archive.handoffPeriods(5)).toEqual([]);
    expect((await archive.putHandoff(built({ chainId: 944, record: text({ chainId: 944 }), storedAt: null })))).toBe("inserted");
    expect((await archive.handoff(944, PERIOD))?.storedAt).toBeNull();
    expect((await archive.counts()).handoffUpdates).toBe(4);
    const all: unknown[] = [];
    for await (const page of archive.pages("handoff_updates")) all.push(...page);
    expect(all).toHaveLength(4);
  });

  it("keeps the first record and records a conflict for a different one, once", async () => {
    const { archive, sql } = await freshArchive();
    await archive.putHandoff(built());
    const other = built({ record: text({ nextSyncCommitteeRoot: `0x${"11".repeat(32)}` }) });
    expect(await archive.putHandoff(other)).toBe("conflict");
    expect(await archive.putHandoff(other)).toBe("conflict");
    expect((await archive.handoff(11155111, PERIOD))?.record).toBe(text());
    const conflicts = (await sql.query<{ table_name: string; column_name: string }>("SELECT table_name, column_name FROM proof_archive.conflicts ORDER BY column_name")).rows;
    expect(conflicts.map((item) => item.table_name)).toEqual(["proof_archive.handoff_updates", "proof_archive.handoff_updates"]);
    expect(conflicts.map((item) => item.column_name)).toEqual(["record", "sha256"]);
  });
});

describe("ingest from the backend", { timeout: 60_000 }, () => {
  it("takes the handoffs of the live poll, refuses and counts a bad one, and reports a conflict", async () => {
    const { archive } = await freshArchive();
    const rows = backendRowsSchema.parse({ handoffs: [row(), row({ period: 3, record: "{" })] });
    expect(await ingestBackendRows(archive, "sepolia-pls943", rows)).toEqual({ inserted: 1, unchanged: 0, merged: 0, conflict: 0, invalid: 1 });
    expect(logged()).toContain('"event":"proof_archive_handoff_refused"');
    expect(logged()).not.toContain("nextSyncCommitteeRoot");
    expect(await ingestBackendRows(archive, "sepolia-pls943", rows)).toMatchObject({ unchanged: 1, invalid: 1 });
    const different = backendRowsSchema.parse({ handoffs: [row({ record: text({ nextSyncCommitteeRoot: `0x${"11".repeat(32)}` }) })] });
    expect(await ingestBackendRows(archive, "sepolia-pls943", different)).toMatchObject({ conflict: 1 });
    expect(logged()).toContain('"event":"proof_archive_conflict"');
    expect(backendRowsSchema.parse({}).handoffs).toEqual([]);
  });

  it("reads the table of a snapshot, and a snapshot without it as none", async () => {
    const path = join(directory, "backend.sqlite");
    const database = new DatabaseSync(path);
    database.exec("CREATE TABLE handoff_updates (chain_id INTEGER, period INTEGER, record TEXT, sha256 TEXT, attested_slot INTEGER, finalized_slot INTEGER, stored_at INTEGER, PRIMARY KEY (chain_id, period))");
    database.prepare("INSERT INTO handoff_updates VALUES (?, ?, ?, 'x', 1, 1, ?)").run(11155111, PERIOD, text(), 77);
    database.close();
    const { rows } = readBackendSnapshot(path);
    expect(rows.handoffs).toEqual([{ chainId: 11155111, period: PERIOD, record: text(), storedAt: 77 }]);
    const { archive } = await freshArchive();
    expect(await ingestBackendRows(archive, "p", rows)).toMatchObject({ inserted: 1 });
    expect((await archive.handoff(11155111, PERIOD))?.storedAt).toBe(77);
    const old = join(directory, "old.sqlite");
    new DatabaseSync(old).close();
    expect(readBackendSnapshot(old).rows.handoffs).toEqual([]);
  });

  it("is reported by the command line", async () => {
    const path = join(directory, "backend.sqlite");
    const database = new DatabaseSync(path);
    database.exec("CREATE TABLE handoff_updates (chain_id INTEGER, period INTEGER, record TEXT, sha256 TEXT, attested_slot INTEGER, finalized_slot INTEGER, stored_at INTEGER)");
    database.prepare("INSERT INTO handoff_updates VALUES (?, ?, ?, 'x', 1, 1, 1)").run(11155111, PERIOD, text());
    database.close();
    const { archive } = await freshArchive();
    const out: string[] = [];
    const dependencies: CliDependencies = { openArchive: async () => ({ archive, close: async () => {} }), stateRoot: () => async () => null, now: () => new Date(0), print: (line) => out.push(line), log: () => {} };
    expect(await main(["ingest-backend", "--sqlite", path], {}, dependencies)).toBe(0);
    expect(JSON.parse(out[0] as string)).toMatchObject({ ingested: { inserted: 1, invalid: 0 }, rows: { handoffs: 1 } });
  });
});

describe("the mirror", { timeout: 60_000 }, () => {
  it("writes a record file for good under handoff-updates/<chain>/<period>.<sha256>.json, once", async () => {
    const { archive } = await freshArchive();
    await archive.putHandoff(built());
    const mirror = join(directory, "mirror");
    const first = await writeMirrorRecords(archive, mirror);
    expect(first.written["handoff-updates"]).toBe(1);
    const file = mirrorFile("handoff-updates", built());
    expect(file.path).toMatch(new RegExp(`^handoff-updates/11155111/${PERIOD}\\.[0-9a-f]{64}\\.json$`));
    expect(await listFiles(mirror)).toEqual([file.path]);
    expect(await readFile(join(mirror, file.path), "utf8")).toBe(file.text);
    expect(await writeMirrorRecords(archive, mirror)).toMatchObject({ identical: 1, conflicts: [] });
  });

  it("imports into a fresh archive, refusing a record whose text, hash or slots do not hold", async () => {
    const { archive: source } = await freshArchive();
    await source.putHandoff(built());
    const mirror = join(directory, "mirror");
    await writeMirrorRecords(source, mirror);
    const { archive } = await freshArchive();
    expect((await importMirror(archive, mirror)).handoff_updates).toEqual({ inserted: 1, unchanged: 0, merged: 0, conflict: 0, invalid: 0 });
    expect((await importMirror(archive, mirror)).handoff_updates.unchanged).toBe(1);
    expect(await archive.handoff(11155111, PERIOD)).toEqual(built());

    const good = built();
    const put = async (name: string, value: unknown) => {
      const bad = mirrorFile("handoff-updates", value as Record<string, unknown>);
      const path = bad.path.replace("/11155111/", "/1/").replace(`${PERIOD}.`, `${name}.`);
      await mkdir(join(mirror, path, ".."), { recursive: true });
      await writeFile(join(mirror, path), bad.text);
    };
    await put("1", { ...good, sha256: "0".repeat(64) });
    await put("2", { ...good, finalizedSlot: 1 });
    await put("3", { ...good, record: "{" });
    await put("4", { ...good, chainId: "x" });
    const fresh = await freshArchive();
    // Files whose content does not match their name read as nothing and count as invalid too.
    const result = (await importMirror(fresh.archive, mirror)).handoff_updates;
    expect(result.inserted).toBe(1);
    expect(result.invalid).toBeGreaterThanOrEqual(4);
  });

  it("reports a different record under the same key as a conflict", async () => {
    const { archive } = await freshArchive();
    await archive.putHandoff(built());
    const { archive: other } = await freshArchive();
    await other.putHandoff(built({ record: text({ nextSyncCommitteeRoot: `0x${"11".repeat(32)}` }) }));
    const mirror = join(directory, "mirror");
    await writeMirrorRecords(other, mirror);
    expect((await importMirror(archive, mirror)).handoff_updates.conflict).toBe(1);
  });

  it("round-trips through a bundle", async () => {
    const { archive } = await freshArchive();
    await archive.putHandoff(built());
    const bundle = join(directory, "bundle");
    expect((await exportArchive(archive, bundle)).handoff_updates).toBe(1);
    const { archive: target } = await freshArchive();
    expect((await importArchive(target, bundle)).handoff_updates.inserted).toBe(1);
    const tree = join(directory, "tree");
    expect((await exportPublicTree({ kind: "bundle", bundle }, tree)).handoffUpdates).toBe(1);
    async function* none(): AsyncGenerator<unknown> {}
    async function* junk(): AsyncGenerator<unknown> {
      yield undefined;
      yield "x";
    }
    expect(await importRecords(target, { storage: none(), lightClient: none(), evidence: none(), handoffs: junk() })).toMatchObject({ handoff_updates: { invalid: 2 } });
  });
});

describe("the public tree", { timeout: 60_000 }, () => {
  it("holds exactly the record text at handoff-updates/<chain>/<period>.json, from the archive or the mirror, and passes the sanitizer", async () => {
    const { archive } = await freshArchive();
    await archive.putHandoff(built());
    const mirror = join(directory, "mirror");
    await writeMirrorRecords(archive, mirror);
    const fromArchive = join(directory, "a");
    const fromMirror = join(directory, "m");
    expect((await exportPublicTree({ kind: "archive", archive }, fromArchive)).handoffUpdates).toBe(1);
    expect((await exportPublicTree({ kind: "mirror", mirror }, fromMirror)).handoffUpdates).toBe(1);
    for (const tree of [fromArchive, fromMirror]) {
      expect(await readFile(join(tree, "handoff-updates", "11155111", `${PERIOD}.json`), "utf8")).toBe(text());
      expect(await checkPublicTree(tree)).toEqual([]);
    }
    expect(PUBLIC_README).toContain("handoff-updates/<chain id>/<period>.json");
  });

  it("refuses a record that does not parse", async () => {
    const bundle = join(directory, "bundle");
    await mkdir(join(bundle, "archive"), { recursive: true });
    await writeFile(join(bundle, "archive", "handoff_updates.ndjson"), "{}\n");
    await expect(exportPublicTree({ kind: "bundle", bundle }, join(bundle, "out"))).rejects.toThrow("a handoff update record does not parse");
    await writeFile(join(bundle, "archive", "handoff_updates.ndjson"), `${JSON.stringify({ ...built(), record: "{" })}\n`);
    await expect(exportPublicTree({ kind: "bundle", bundle }, join(bundle, "out"))).rejects.toThrow("a handoff update record does not parse");
  });

  it("sanitizer: a handoff file must be valid for its path and must hold nothing but chain data", async () => {
    const tree = join(directory, "tree");
    const put = async (path: string, body: string) => {
      await mkdir(join(tree, path, ".."), { recursive: true });
      await writeFile(join(tree, path), body);
    };
    await put(`handoff-updates/11155111/${PERIOD}.json`, text());
    expect(await checkPublicTree(tree)).toEqual([]);
    await put(`handoff-updates/11155111/${PERIOD + 1}.json`, text());
    await put(`handoff-updates/11155111/${PERIOD + 2}.json`, "{");
    await put(`handoff-updates/943/${PERIOD}.json`, text({ chainId: 943, update: { next_sync_committee: {}, note: "see https://rpc.example/x" } }));
    await put(`handoff-updates/943/${PERIOD + 1}.json`, text({ chainId: 943, period: PERIOD + 1, attestedSlot: FIRST_SLOT + 8192 + 1, signatureSlot: FIRST_SLOT + 8192 + 2, finalizedSlot: FIRST_SLOT + 8192, update: { next_sync_committee: {}, host: "x" } }));
    await put("handoff-updates/notes.txt", "x");
    const problems = await checkPublicTree(tree);
    expect(problems.map((item) => `${item.file}: ${item.reason}`).sort()).toEqual([
      "handoff-updates/11155111/101.json: is not a valid handoff update for its path",
      "handoff-updates/11155111/102.json: is not a valid handoff update for its path",
      "handoff-updates/943/100.json: looks like a URL",
      "handoff-updates/943/101.json: has the field \"host\"",
      "handoff-updates/notes.txt: is not at an allowed path",
    ]);
    expect(canonicalJson({ a: 1 })).toBe('{"a":1}\n');
  });
});

describe("the read routes", { timeout: 60_000 }, () => {
  const app = (archive: Parameters<typeof registerProofRoutes>[1]) => {
    const hono = new Hono();
    registerProofRoutes(hono, archive);
    return hono;
  };

  it("list the periods, serve the record text byte for byte, and count", async () => {
    const { archive } = await freshArchive();
    await archive.putHandoff(built({ period: PERIOD + 1, record: text({ period: PERIOD + 1, attestedSlot: (PERIOD + 1) * 8192 + 9, signatureSlot: (PERIOD + 1) * 8192 + 10, finalizedSlot: (PERIOD + 1) * 8192 }) }));
    await archive.putHandoff(built());
    const routes = app(async () => archive);
    expect(await (await routes.request("/api/proofs/handoffs/11155111")).json()).toEqual({ periods: [PERIOD, PERIOD + 1] });
    expect(await (await routes.request("/api/proofs/handoffs/5")).json()).toEqual({ periods: [] });
    const file = await routes.request(`/api/proofs/handoffs/11155111/${PERIOD}.json`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("application/json");
    expect(await file.text()).toBe(text());
    expect((await routes.request(`/api/proofs/handoffs/11155111/${PERIOD + 50}.json`)).status).toBe(404);
    expect((await routes.request(`/api/proofs/handoffs/11155111/${PERIOD}`)).status).toBe(400);
    expect((await routes.request(`/api/proofs/handoffs/11155111/${PERIOD}.json.bak`)).status).toBe(400);
    expect((await routes.request("/api/proofs/handoffs/11155111/x.json")).status).toBe(400);
    expect((await routes.request("/api/proofs/handoffs/x/1.json")).status).toBe(400);
    expect((await routes.request("/api/proofs/handoffs/99999999999/1.json")).status).toBe(400);
    expect((await routes.request("/api/proofs/handoffs/11155111/9999999999.json")).status).toBe(400);
    expect((await routes.request("/api/proofs/handoffs/x")).status).toBe(400);
    expect((await routes.request("/api/proofs/handoffs/99999999999")).status).toBe(400);
    expect(await (await routes.request("/api/proofs/summary")).json()).toEqual({ storageProofs: 0, lightClientProofs: 0, evidence: 0, handoffUpdates: 2, conflicts: 0 });
  });

  it("answer 503 while the archive is off", async () => {
    const routes = app(async () => null);
    for (const path of ["/api/proofs/handoffs/1", `/api/proofs/handoffs/1/${PERIOD}.json`]) expect((await routes.request(path)).status, path).toBe(503);
  });
});
