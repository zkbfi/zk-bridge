import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listFiles } from "../../src/proof-archive/bundle";
import { main, type CliDependencies } from "../../src/proof-archive/cli";
import {
  addToMirror,
  checkMirror,
  importMirror,
  MIRROR_DIRECTORIES,
  mirrorFile,
  mirrorRecords,
  pruneMirror,
  stageNewestStates,
  stateTime,
  writeMirrorManifest,
  writeMirrorRecords,
  writeOnce,
} from "../../src/proof-archive/mirror";
import { exportPublicTree } from "../../src/proof-archive/public";
import { evidenceRecord, lightClientRecord } from "../../src/proof-archive/records";
import type { ProofArchive } from "../../src/proof-archive/store";
import { freshArchive, proofBytes, publicValuesFor, sepolia, sepoliaRecord } from "./support/proof-archive-fixtures";

/**
 * The private mirror of deploy/app-server/proofs.sh: one file per record, named by its content, written once; beacon
 * states, SQLite snapshots and daily manifests beside them, the last three kept for a window of days. Owner,
 * 2026-11-02: "ok, so lets plan to do 30 days of everything".
 */

let directory: string;
let mirror: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "proof-mirror-"));
  mirror = join(directory, "mirror");
});
afterEach(async () => rm(directory, { recursive: true, force: true }));

const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const PAIR = "sepolia-pls943";
const NOW = new Date("2026-11-02T03:30:00Z");
/** The genesis time that the test states carry (Sepolia's), and the slot of a time on its 12 second grid. */
const GENESIS = 1_655_733_600;
const slotAt = (date: Date) => Math.floor((date.getTime() / 1000 - GENESIS) / 12);
const daysBefore = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const ROOT_A = `0x${"ab".repeat(32)}`;
const ROOT_B = `0x${"cd".repeat(32)}`;

/** The first 48 bytes of an SSZ beacon state: genesis_time, genesis_validators_root, slot; then some padding. */
function stateBytes(slot: number, genesis = GENESIS, tail = "x"): Buffer {
  const head = Buffer.alloc(48);
  head.writeBigUInt64LE(BigInt(genesis), 0);
  head.writeBigUInt64LE(BigInt(slot), 40);
  return Buffer.concat([head, Buffer.from(tail)]);
}
const stateName = (slot: number, root = ROOT_A) => `${String(slot).padStart(12, "0")}-${root}`;

async function put(root: string, path: string, bytes: string | Buffer): Promise<void> {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), bytes);
}

const lightClient = (extras = {}) => lightClientRecord({ pair: PAIR, direction: "first-to-second", proof: proofBytes(), publicValues: publicValuesFor(64n, 96n), source: "backend-held", extras });
const evidence = () => evidenceRecord({ messageId: `0x${"0e".repeat(32)}`, pair: PAIR, direction: "second-to-first", body: '{"proof":["0x01"]}', storedAt: 3, source: "backend" });

/** An archive with one row of each kind and one conflict. */
async function filledArchive(): Promise<ProofArchive> {
  const { archive } = await freshArchive();
  await archive.putStorageProof(sepoliaRecord());
  await archive.putStorageProof({ ...sepoliaRecord(), storageKeys: [sepolia.storageKeys[0] as string] });
  await archive.putLightClientProof(lightClient({ backendJobId: "job-9" }));
  await archive.putEvidence(evidence());
  await archive.putStorageProof({ ...sepoliaRecord(), proof: { forged: true } });
  return archive;
}

describe("record files", () => {
  it("name each record by the public layout plus the SHA-256 of its canonical JSON", () => {
    const record = sepoliaRecord();
    const file = mirrorFile("storage-proofs", record);
    expect(file.path).toBe(`storage-proofs/${sepolia.chainId}/${sepolia.address.toLowerCase()}/${sepolia.blockNumber}-${sepolia.blockHash.toLowerCase()}.${sha(file.text)}.json`);
    // The mirror is private: it keeps the source host and the fetch time.
    expect(JSON.parse(file.text)).toMatchObject({ sourceHost: "rpc.example", fetchedAt: record.fetchedAt });
    const light = mirrorFile("light-client-proofs", lightClient({ backendJobId: "job-9" }));
    expect(light.path).toMatch(new RegExp(`^light-client-proofs/${PAIR}/first-to-second/64-96-0x[0-9a-f]{64}\\.${sha(light.text)}\\.json$`));
    expect(light.text).toContain("job-9");
    const body = evidence();
    expect(mirrorFile("evidence", body).path).toMatch(new RegExp(`^evidence/${PAIR}/second-to-first/0x(0e){32}-${body.bodyHash.slice(2)}\\.[0-9a-f]{64}\\.json$`));
    expect(mirrorFile("conflicts", { table: "t" }).path).toMatch(/^conflicts\/conflict\.[0-9a-f]{64}\.json$/);
    // Unsafe path parts are refused, never written.
    expect(() => mirrorFile("light-client-proofs", { ...lightClient(), pair: "../etc" })).toThrow("unsafe path part");
    expect(() => mirrorFile("evidence", { ...body, pair: ".hidden" })).toThrow("unsafe path part");
  });

  it("are written once: a second run finds them identical, and other content under the same name fails loudly", async () => {
    const archive = await filledArchive();
    const first = await writeMirrorRecords(archive, mirror);
    expect(first).toEqual({ written: { "storage-proofs": 2, "light-client-proofs": 1, evidence: 1, conflicts: 1 }, identical: 0, conflicts: [] });
    const files = await listFiles(mirror);
    expect(files).toHaveLength(5);
    // Readable by everyone who may enter the mirror (the archive user writes, root and the pull read).
    for (const file of files) expect((await stat(join(mirror, file))).mode & 0o777, file).toBe(0o644);
    expect(await writeMirrorRecords(archive, mirror)).toMatchObject({ identical: 5, conflicts: [] });
    const victim = files.find((file) => file.startsWith("evidence/")) as string;
    await writeFile(join(mirror, victim), "tampered");
    const again = await writeMirrorRecords(archive, mirror);
    expect(again.conflicts).toEqual([victim]);
    expect(await readFile(join(mirror, victim), "utf8")).toBe("tampered");
  });

  it("keep both versions of a light client proof that was filled in later", async () => {
    const { archive } = await freshArchive();
    await archive.putLightClientProof(lightClient());
    await writeMirrorRecords(archive, mirror);
    await archive.putLightClientProof(lightClient({ postedChainId: 943, postedTransactionHash: `0x${"77".repeat(32)}`, postedBlockNumber: "5" }));
    expect((await writeMirrorRecords(archive, mirror)).written["light-client-proofs"]).toBe(1);
    expect((await listFiles(join(mirror, "light-client-proofs"))).length).toBe(2);

    // The public tree from the mirror merges the versions: the filled fields win over nulls. A proof of other slots
    // stays its own file.
    await archive.putLightClientProof(lightClientRecord({ pair: PAIR, direction: "first-to-second", proof: proofBytes(), publicValues: publicValuesFor(96n, 128n), source: "calldata" }));
    await writeMirrorRecords(archive, mirror);
    const tree = join(directory, "tree");
    expect((await exportPublicTree({ kind: "mirror", mirror }, tree)).lightClientProofs).toBe(2);
    const file = (await listFiles(join(tree, "light-client-proofs"))).find((name) => name.includes("/64-96-"));
    expect(JSON.parse(await readFile(join(tree, "light-client-proofs", file as string), "utf8"))).toMatchObject({ postedChainId: 943, postedBlockNumber: "5" });
  });

  it("give the public tree one entry per storage proof and refuse a damaged version of a record", async () => {
    // The same answer fetched twice (another fetch time, from a second server's mirror) is one public entry.
    for (const fetchedAt of ["2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z"]) {
      const file = mirrorFile("storage-proofs", { ...sepoliaRecord(), fetchedAt });
      await put(mirror, file.path, file.text);
    }
    await exportPublicTree({ kind: "mirror", mirror }, join(directory, "tree"));
    const [storage] = await listFiles(join(directory, "tree", "storage-proofs"));
    expect(JSON.parse(await readFile(join(directory, "tree", "storage-proofs", storage as string), "utf8"))).toHaveLength(1);

    // A version whose content does not match its name: after a good one it is ignored, before one it stops the export.
    const good = mirrorFile("light-client-proofs", lightClient());
    const stem = good.path.replace(/\.[0-9a-f]{64}\.json$/, "");
    await put(mirror, good.path, good.text);
    await put(mirror, `${stem}.${"f".repeat(64)}.json`, "{}");
    expect((await exportPublicTree({ kind: "mirror", mirror }, join(directory, "tree2"))).lightClientProofs).toBe(1);
    await put(mirror, `${stem}.${"0".repeat(64)}.json`, "{}");
    await expect(exportPublicTree({ kind: "mirror", mirror }, join(directory, "tree3"))).rejects.toThrow("does not parse");
  });

  it("read back only well-named files, and a file whose content does not match its name reads as nothing", async () => {
    await writeMirrorRecords(await filledArchive(), mirror);
    const read = async (kind: string) => {
      const values: unknown[] = [];
      for await (const value of mirrorRecords(mirror, kind)) values.push(value);
      return values;
    };
    expect(await read("storage-proofs")).toHaveLength(2);
    expect(await read("nothing-here")).toEqual([]);
    await put(mirror, "evidence/p/first-to-second/notes.txt", "x");
    await put(mirror, `evidence/p/first-to-second/x.${"00".repeat(32)}.json`, "{}");
    await put(mirror, `evidence/p/first-to-second/y.${sha("not json")}.json`, "not json");
    const values = await read("evidence");
    expect(values).toHaveLength(3);
    expect(values.filter((value) => value === undefined)).toHaveLength(2);
  });

  it("import into a fresh archive, in any order of versions, and a second import changes nothing", async () => {
    const source = await filledArchive();
    await writeMirrorRecords(source, mirror);
    await source.putLightClientProof(lightClient({ backendJobId: "job-9", postedTransactionHash: `0x${"77".repeat(32)}` }));
    await writeMirrorRecords(source, mirror);
    const { archive } = await freshArchive();
    const first = await importMirror(archive, mirror);
    expect(first.storage_proofs).toEqual({ inserted: 2, unchanged: 0, merged: 0, conflict: 0, invalid: 0 });
    expect(first.light_client_proofs.inserted + first.light_client_proofs.merged + first.light_client_proofs.unchanged).toBe(2);
    expect(first.message_evidence.inserted).toBe(1);
    const [restored] = await archive.lightClientProofs({ direction: "first-to-second", limit: 5 });
    expect(restored?.postedTransactionHash).toBe(`0x${"77".repeat(32)}`);
    const second = await importMirror(archive, mirror);
    expect(second.storage_proofs.unchanged + second.light_client_proofs.unchanged + second.message_evidence.unchanged).toBe(5);
    expect(await archive.counts()).toEqual({ storageProofs: 2, lightClientProofs: 1, evidence: 1, conflicts: 0 });
  });
});

describe("writeOnce", () => {
  it("writes a new file 0644 even under a strict umask, finds an equal one identical and another one a conflict", async () => {
    const previous = process.umask(0o077);
    try {
      expect(await writeOnce(mirror, "a/b.bin", Buffer.from("one"))).toBe("written");
    } finally {
      process.umask(previous);
    }
    expect((await stat(join(mirror, "a/b.bin"))).mode & 0o777).toBe(0o644);
    expect(await writeOnce(mirror, "a/b.bin", "one")).toBe("identical");
    expect(await writeOnce(mirror, "a/b.bin", "two")).toBe("conflict");
    expect(await readdir(join(mirror, "a"))).toEqual(["b.bin"]);
    await mkdir(join(mirror, "a", "dir.bin"));
    await expect(writeOnce(mirror, "a/dir.bin", "x")).rejects.toThrow();
  });
});

describe("addToMirror", () => {
  it("copies well-named beacon states and snapshots once, skips everything else, and reports a clash", async () => {
    const from = join(directory, "runner");
    await put(from, `943/${stateName(10)}.ssz`, stateBytes(10));
    await put(from, `943/${stateName(10)}.summary`, "0x01\n0x02\n");
    await put(from, `pulsechain/${stateName(11)}.ssz`, "x");
    await put(from, "943/junk.ssz", "x");
    await symlink("/etc/hosts", join(from, "943", `${stateName(12)}.ssz`));
    await chmod(join(from, "943", `${stateName(10)}.ssz`), 0o600);
    expect(await addToMirror(mirror, from, "beacon-states")).toEqual({ added: 2, identical: 0, skipped: 2, conflicts: [] });
    expect((await stat(join(mirror, "beacon-states", "943", `${stateName(10)}.ssz`))).mode & 0o777).toBe(0o644);
    expect(await addToMirror(mirror, from, "beacon-states")).toMatchObject({ added: 0, identical: 2 });
    const other = join(directory, "backend");
    await put(other, `943/${stateName(10)}.ssz`, stateBytes(10, GENESIS, "other"));
    expect((await addToMirror(mirror, other, "beacon-states")).conflicts).toEqual([`beacon-states/943/${stateName(10)}.ssz`]);

    const snapshots = join(directory, "snapshots");
    await put(snapshots, "20261102T033000Z.sqlite", "db");
    await put(snapshots, "backend.sqlite", "db");
    expect(await addToMirror(mirror, snapshots, "snapshots")).toMatchObject({ added: 1, skipped: 1 });
    expect(await addToMirror(mirror, join(directory, "none"), "snapshots")).toMatchObject({ added: 0, skipped: 0 });
    await expect(addToMirror(mirror, snapshots, "storage-proofs")).rejects.toThrow("cannot add files to storage-proofs");
  });
});

describe("stateTime", () => {
  it("is the slot's time from the genesis time the state carries and the chain's slot length", async () => {
    await put(directory, "a.ssz", stateBytes(100));
    expect(await stateTime(join(directory, "a.ssz"), 11155111, 100)).toBe(GENESIS + 1200);
    // PulseChain has 10 second slots.
    expect(await stateTime(join(directory, "a.ssz"), 943, 100)).toBe(GENESIS + 1000);
    // A state of another slot than its name, or too short to carry the clock, has no time.
    expect(await stateTime(join(directory, "a.ssz"), 943, 101)).toBeNull();
    await put(directory, "b.ssz", "short");
    expect(await stateTime(join(directory, "b.ssz"), 943, 100)).toBeNull();
  });
});

describe("pruneMirror", () => {
  it("deletes beacon states, snapshots and manifests older than the window, never records, and warns about held states it lacks", async () => {
    await writeMirrorRecords(await filledArchive(), mirror);
    const old = slotAt(daysBefore(31));
    const young = slotAt(daysBefore(29));
    await put(mirror, `beacon-states/11155111/${stateName(old)}.ssz`, stateBytes(old));
    await put(mirror, `beacon-states/11155111/${stateName(old)}.summary`, "0x01\n0x02\n");
    await put(mirror, `beacon-states/11155111/${stateName(young)}.ssz`, stateBytes(young));
    // A state written today (its mtime is now) is still deleted when its slot is old: the slot decides, not the file time.
    await put(mirror, `beacon-states/11155111/${stateName(old - 1)}.ssz`, stateBytes(old - 1));
    // A state that does not carry its own slot is kept, and reported.
    await put(mirror, `beacon-states/11155111/${stateName(old - 2)}.ssz`, "short");
    await put(mirror, `beacon-states/11155111/${stateName(old - 3)}.summary`, "orphan");
    await put(mirror, "beacon-states/11155111/junk.bin", "x");
    await put(mirror, "snapshots/20261001T033000Z.sqlite", "old");
    await put(mirror, "snapshots/20261030T033000Z.sqlite", "young");
    await put(mirror, "snapshots/notes.txt", "x");
    await put(mirror, "manifests/20261001T033000Z.json", "{}");
    await put(mirror, "manifests/20261101T033000Z.json", "{}");
    await put(mirror, "evidence/.left.json.tmp-1-2", "partial");
    // What the services hold: one state in the mirror, one too old for it, one that never made it.
    const held = join(directory, "held");
    await put(held, `11155111/${stateName(young)}.ssz`, "x");
    await put(held, `11155111/${stateName(old)}.ssz`, "x");
    await put(held, `943/${stateName(5, ROOT_B)}.ssz`, "x");
    await put(held, "943/junk", "x");
    const held2 = join(directory, "held2");
    await put(held2, `11155111/${stateName(young)}.ssz`, "x");

    const result = await pruneMirror(mirror, { days: 30, now: NOW, held: [held, held2, join(directory, "no-such-dir")] });
    expect(result).toEqual({
      deleted: { beaconStates: 2, snapshots: 1, manifests: 1, temporary: 1 },
      kept: { beaconStates: 2, snapshots: 1, manifests: 1 },
      undated: [`beacon-states/11155111/${stateName(old - 3)}.summary`, `beacon-states/11155111/${stateName(old - 2)}.ssz`, "beacon-states/11155111/junk.bin", "snapshots/notes.txt"],
      heldMissing: [`943/${stateName(5, ROOT_B)}.ssz`],
      heldExpired: 1,
    });
    const left = await listFiles(mirror);
    expect(left.filter((file) => file.startsWith("beacon-states/"))).toEqual([
      `beacon-states/11155111/${stateName(old - 3)}.summary`,
      `beacon-states/11155111/${stateName(old - 2)}.ssz`,
      `beacon-states/11155111/${stateName(young)}.ssz`,
      "beacon-states/11155111/junk.bin",
    ]);
    expect(left.filter((file) => /^(storage-proofs|light-client-proofs|evidence|conflicts)\//.test(file))).toHaveLength(5);
    expect(await pruneMirror(join(directory, "empty"), { days: 30, now: NOW, held: [] })).toMatchObject({ deleted: { beaconStates: 0 }, heldMissing: [] });
    await expect(pruneMirror(mirror, { days: 0, now: NOW, held: [] })).rejects.toThrow("at least one day");
  });
});

describe("manifests of the mirror", () => {
  it("list every file but the manifests themselves, and the newest one checks the mirror", async () => {
    await writeMirrorRecords(await filledArchive(), mirror);
    await put(mirror, `beacon-states/943/${stateName(10)}.ssz`, stateBytes(10));
    await put(mirror, "snapshots/20261102T033000Z.sqlite", "db");
    await put(mirror, "manifests/20261101T033000Z.json", JSON.stringify({ files: {} }));
    await put(mirror, "beacon-states/943/.x.tmp-1-1", "partial");
    const log = join(directory, "ipfs-cids.log");
    await writeFile(log, "2026-11-01T00:00:00Z bafyone 3 abc\n2026-11-02T00:00:00Z bafytwo 4 abc\n");
    const manifest = await writeMirrorManifest(mirror, { stamp: "20261102T033000Z", commit: "abc", now: () => NOW, ipfsLog: log, retentionDays: 30 });
    expect(manifest).toMatchObject({ formatVersion: 2, kind: "mirror", createdAt: NOW.toISOString(), commit: "abc", retentionDays: 30, lastPublished: "2026-11-02T00:00:00Z bafytwo 4 abc" });
    expect(manifest.host).toEqual(expect.any(String));
    expect(Object.keys(manifest.files)).toHaveLength(7);
    expect(manifest.counts).toMatchObject({ "storage-proofs": 2, "beacon-states": 1, snapshots: 1 });
    expect((await stat(join(mirror, "manifests", "20261102T033000Z.json"))).mode & 0o777).toBe(0o644);
    await expect(writeMirrorManifest(mirror, { stamp: "20261102T033000Z", commit: "abc", now: () => NOW, retentionDays: 30 })).rejects.toThrow("exists already");
    await expect(writeMirrorManifest(mirror, { stamp: "today", commit: "abc", now: () => NOW, retentionDays: 30 })).rejects.toThrow("not a UTC stamp");
    expect((await writeMirrorManifest(mirror, { stamp: "20261102T040000Z", commit: "abc", now: () => NOW, ipfsLog: join(directory, "none"), retentionDays: 30 })).lastPublished).toBeNull();

    expect(await checkMirror(mirror)).toEqual({ manifest: "manifests/20261102T040000Z.json", checked: 7, missing: [], changed: [], unlisted: [], misnamed: [] });
    // A record file that changed is both changed and misnamed; a snapshot that is gone is missing; a new file is unlisted.
    const record = (await listFiles(mirror)).find((file) => file.startsWith("light-client-proofs/")) as string;
    await writeFile(join(mirror, record), "tampered");
    await rm(join(mirror, "snapshots", "20261102T033000Z.sqlite"));
    await put(mirror, `evidence/p/first-to-second/z.${sha("{}")}.json`, "{}");
    await put(mirror, "evidence/notes.txt", "x");
    expect(await checkMirror(mirror)).toEqual({
      manifest: "manifests/20261102T040000Z.json",
      checked: 6,
      missing: ["snapshots/20261102T033000Z.sqlite"],
      changed: [record],
      unlisted: ["evidence/notes.txt", `evidence/p/first-to-second/z.${sha("{}")}.json`],
      misnamed: [record],
    });
    await expect(checkMirror(join(directory, "empty"))).rejects.toThrow("no manifest");
  });
});

describe("stageNewestStates", () => {
  it("stages the newest states of each chain, with their summaries, readable by the service users", async () => {
    for (const slot of [1, 2, 3]) await put(mirror, `beacon-states/943/${stateName(slot)}.ssz`, stateBytes(slot));
    await put(mirror, `beacon-states/943/${stateName(3)}.summary`, "0x01\n0x02\n");
    await put(mirror, `beacon-states/1/${stateName(7)}.ssz`, stateBytes(7));
    const out = join(directory, "stage");
    expect(await stageNewestStates(mirror, out, 2)).toEqual({ staged: 3 });
    expect(await listFiles(out)).toEqual([`1/${stateName(7)}.ssz`, `943/${stateName(2)}.ssz`, `943/${stateName(3)}.ssz`, `943/${stateName(3)}.summary`]);
    expect((await stat(join(out, "943", `${stateName(3)}.ssz`))).mode & 0o777).toBe(0o644);
    expect(await stageNewestStates(join(directory, "empty"), join(directory, "stage2"), 2)).toEqual({ staged: 0 });
  });
});

describe("the command line of the mirror", { timeout: 60_000 }, () => {
  const run = async (argv: string[], archive?: ProofArchive) => {
    const out: string[] = [];
    const log: string[] = [];
    const used = archive ?? (await freshArchive()).archive;
    const dependencies: CliDependencies = {
      openArchive: async () => ({ archive: used, close: async () => {} }),
      stateRoot: () => async () => sepolia.stateRoot,
      now: () => NOW,
      print: (text) => out.push(text),
      log: (text) => log.push(text),
    };
    const code = await main(argv, { EXPLORER_PAIR: PAIR }, dependencies);
    return { code, out: out.map((text) => JSON.parse(text) as Record<string, unknown>), log: log.join("\n") };
  };

  it("writes, adds, prunes, manifests, checks, imports and stages", async () => {
    const source = await filledArchive();
    expect((await run(["mirror-write", "--dir", mirror], source)).out[0]).toMatchObject({ written: { "storage-proofs": 2 } });
    const victim = (await listFiles(mirror)).find((file) => file.startsWith("conflicts/")) as string;
    await writeFile(join(mirror, victim), "x");
    const clash = await run(["mirror-write", "--dir", mirror], source);
    expect(clash.code).toBe(3);
    expect(clash.log).toContain(`ERROR: ${victim} exists with other content`);
    await rm(join(mirror, victim));
    await run(["mirror-write", "--dir", mirror], source);

    const from = join(directory, "states");
    await put(from, `11155111/${stateName(slotAt(daysBefore(1)))}.ssz`, stateBytes(slotAt(daysBefore(1))));
    expect((await run(["mirror-add", "--dir", mirror, "--from", from, "--to", "beacon-states"])).out[0]).toMatchObject({ added: 1 });
    const other = join(directory, "other");
    await put(other, `11155111/${stateName(slotAt(daysBefore(1)))}.ssz`, "different");
    const added = await run(["mirror-add", "--dir", mirror, "--from", other, "--to", "beacon-states"]);
    expect(added.code).toBe(3);
    expect(added.log).toContain("exists with other content");

    const held = join(directory, "held");
    await put(held, `943/${stateName(9, ROOT_B)}.ssz`, "x");
    const pruned = await run(["mirror-prune", "--dir", mirror, "--days", "30", "--held", `${from},${held}`]);
    expect(pruned.code).toBe(0);
    expect(pruned.out[0]).toMatchObject({ heldMissing: 1, heldExpired: 0, undated: 0 });
    expect(pruned.log).toContain(`WARNING: the services hold the beacon state 943/${stateName(9, ROOT_B)}.ssz, and the mirror does not`);
    await put(mirror, "snapshots/odd.sqlite", "x");
    const plain = await run(["mirror-prune", "--dir", mirror, "--days", "30"]);
    expect(plain.out[0]).toMatchObject({ heldMissing: 0, undated: 1 });
    expect(plain.log).toContain("kept snapshots/odd.sqlite: its time is unknown");
    await rm(join(mirror, "snapshots", "odd.sqlite"));
    expect((await run(["mirror-prune", "--dir", mirror, "--days", "thirty"])).code).toBe(2);

    expect((await run(["mirror-manifest", "--dir", mirror, "--stamp", "20261102T033000Z", "--commit", "abc", "--days", "30"])).out[0]).toMatchObject({ manifest: "manifests/20261102T033000Z.json", files: 6 });
    expect((await run(["mirror-manifest", "--dir", mirror, "--stamp", "20261102T040000Z", "--commit", "abc", "--days", "30", "--ipfs-log", join(directory, "none")])).code).toBe(0);
    expect((await run(["mirror-check", "--dir", mirror])).out[0]).toMatchObject({ checked: 6, missing: [] });
    // The manifest root's script picked, by name; a name outside the rule is refused.
    expect((await run(["mirror-check", "--dir", mirror, "--manifest", "20261102T033000Z.json"])).out[0]).toMatchObject({ manifest: "manifests/20261102T033000Z.json" });
    const odd = await run(["mirror-check", "--dir", mirror, "--manifest", "zzz.json"]);
    expect(odd.code).toBe(1);
    expect(odd.log).toContain("zzz.json is not a manifest name");
    // --print: exactly the bytes written.
    const printed: string[] = [];
    expect(
      await main(["mirror-manifest", "--dir", mirror, "--stamp", "20261102T050000Z", "--commit", "abc", "--days", "30", "--print"], {}, {
        openArchive: vi.fn(),
        stateRoot: () => async () => null,
        now: () => NOW,
        print: (text) => printed.push(`${text}\n`),
        log: () => {},
      }),
    ).toBe(0);
    expect(printed.join("")).toBe(await readFile(join(mirror, "manifests", "20261102T050000Z.json"), "utf8"));
    await rm(join(mirror, "manifests", "20261102T050000Z.json"));
    await put(mirror, `evidence/p/first-to-second/z.${sha("{}")}.json`, "{}");
    expect((await run(["mirror-check", "--dir", mirror])).code).toBe(0);
    expect((await run(["mirror-check", "--dir", mirror, "--exact"])).code).toBe(1);
    await rm(join(mirror, "evidence", "p"), { recursive: true });
    await writeFile(join(mirror, victim), "x");
    expect((await run(["mirror-check", "--dir", mirror])).code).toBe(1);
    await rm(join(mirror, victim));
    await run(["mirror-write", "--dir", mirror], source);

    const { archive: target } = await freshArchive();
    const imported = await run(["mirror-import", "--dir", mirror], target);
    expect(imported.out[0]).toMatchObject({ conflicts: 0, counts: { storageProofs: 2, lightClientProofs: 1, evidence: 1 } });
    const { archive: conflicting } = await freshArchive();
    await conflicting.putStorageProof({ ...sepoliaRecord(), proof: { other: 1 } });
    expect((await run(["mirror-import", "--dir", mirror], conflicting)).code).toBe(3);

    expect((await run(["mirror-states", "--dir", mirror, "--out", join(directory, "stage")])).out[0]).toEqual({ staged: 1 });
    expect((await run(["mirror-states", "--dir", mirror, "--out", join(directory, "stage3"), "--newest", "x"])).code).toBe(2);

    expect((await run(["verify-storage", "--mirror", mirror])).out[0]).toMatchObject({ verified: 2, invalid: [] });
    expect((await run(["verify-storage"])).code).toBe(2);
    expect((await run(["public-export", "--out", join(directory, "tree"), "--mirror", mirror])).out[0]).toMatchObject({ public: { storageProofs: 1, lightClientProofs: 1, evidence: 1 } });
  });

  it("stops a prune or a manifest whose input is bad", async () => {
    const log = vi.fn();
    expect(await main(["mirror-manifest", "--dir", mirror, "--stamp", "x", "--commit", "abc", "--days", "30"], {}, { openArchive: vi.fn(), stateRoot: () => async () => null, now: () => NOW, print: () => {}, log })).toBe(1);
    expect(String(log.mock.calls[0]?.[0])).toContain("not a UTC stamp");
  });
});

it("names every directory of the mirror", () => {
  expect(MIRROR_DIRECTORIES).toEqual(["storage-proofs", "light-client-proofs", "evidence", "conflicts", "beacon-states", "snapshots", "manifests"]);
});
