import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlockNotFoundError, type Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkManifest, exportArchive, importArchive, ingestCache, listFiles, verifyStorageProofs, writeManifest } from "../../src/proof-archive/bundle";
import { defaultDependencies, main, parseOptions, rpcStateRoot, openPoolArchive, type CliDependencies } from "../../src/proof-archive/cli";
import { canonicalJson, checkPublicTree, exportPublicTree, PUBLIC_README, suspiciousReason } from "../../src/proof-archive/public";
import { evidenceRecord, lightClientRecord } from "../../src/proof-archive/records";
import type { ProofArchive } from "../../src/proof-archive/store";
import { freshArchive, proofBytes, proofMessage, publicValuesFor, sepolia, sepoliaRecord } from "./support/proof-archive-fixtures";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "proof-bundle-"));
});
afterEach(async () => rm(directory, { recursive: true, force: true }));

/** An archive with one row of each kind and one conflict. */
async function filledArchive(): Promise<ProofArchive> {
  const { archive } = await freshArchive();
  await archive.putStorageProof(sepoliaRecord());
  await archive.putStorageProof({ ...sepoliaRecord(), storageKeys: [sepolia.storageKeys[0] as string] });
  await archive.putLightClientProof(lightClientRecord({ pair: "sepolia-pls943", direction: "first-to-second", proof: proofBytes(), publicValues: publicValuesFor(64n, 96n), source: "calldata", extras: { backendJobId: "job-9" } }));
  await archive.putEvidence(evidenceRecord({ messageId: `0x${"0e".repeat(32)}`, pair: "sepolia-pls943", direction: "second-to-first", body: '{"proof":["0x01"]}', storedAt: 3, source: "backend" }));
  await archive.putStorageProof({ ...sepoliaRecord(), proof: { forged: true } });
  return archive;
}

describe("export and import of the archive files", () => {
  it("round-trips into a fresh archive, and a second import changes nothing", async () => {
    const source = await filledArchive();
    expect(await exportArchive(source, directory)).toEqual({ storage_proofs: 2, light_client_proofs: 1, message_evidence: 1, conflicts: 1 });
    const { archive } = await freshArchive();
    const first = await importArchive(archive, directory);
    expect(first.storage_proofs).toEqual({ inserted: 2, unchanged: 0, merged: 0, conflict: 0, invalid: 0 });
    expect(first.light_client_proofs.inserted).toBe(1);
    expect(first.message_evidence.inserted).toBe(1);
    const second = await importArchive(archive, directory);
    expect(second.storage_proofs.unchanged + second.light_client_proofs.unchanged + second.message_evidence.unchanged).toBe(4);
    expect(await archive.counts()).toEqual({ storageProofs: 2, lightClientProofs: 1, evidence: 1, conflicts: 0 });
  });

  it("reports a different value as a conflict and counts records that do not hold together as invalid", async () => {
    const { archive } = await freshArchive();
    await archive.putStorageProof({ ...sepoliaRecord(), proof: { first: true } });
    await mkdir(join(directory, "archive"));
    const good = lightClientRecord({ pair: "sepolia-pls943", direction: "first-to-second", proof: proofBytes(), publicValues: publicValuesFor(64n, 96n), source: "calldata" });
    const evidence = evidenceRecord({ messageId: `0x${"0e".repeat(32)}`, pair: "p", direction: "first-to-second", body: "{}", storedAt: null, source: "backend" });
    await writeFile(join(directory, "archive", "storage_proofs.ndjson"), `${JSON.stringify(sepoliaRecord())}\n\n{"bad":1}\nnot json\n`);
    await writeFile(join(directory, "archive", "light_client_proofs.ndjson"), `${JSON.stringify({ ...good, newSlot: "97" })}\n{}\n`);
    await writeFile(join(directory, "archive", "message_evidence.ndjson"), `${JSON.stringify({ ...evidence, body: "{ }" })}\n${JSON.stringify(evidence)}\n`);
    const result = await importArchive(archive, directory);
    expect(result.storage_proofs).toEqual({ inserted: 0, unchanged: 0, merged: 0, conflict: 1, invalid: 2 });
    expect(result.light_client_proofs.invalid).toBe(2);
    expect(result.message_evidence).toMatchObject({ inserted: 1, invalid: 1 });
  });

  it("reads a bundle without archive files as empty", async () => {
    const { archive } = await freshArchive();
    expect((await importArchive(archive, directory)).storage_proofs.inserted).toBe(0);
  });
});

describe("the proof cache", () => {
  it("upserts the entries of a runner proof cache and skips other files", async () => {
    const record = sepoliaRecord();
    const folder = join(directory, String(record.chainId), record.address.toLowerCase());
    await mkdir(folder, { recursive: true });
    const { sourceHost: _host, ...entry } = record;
    await writeFile(join(folder, `${record.blockNumber}-${record.blockHash}.json`), JSON.stringify(entry));
    await writeFile(join(folder, `1-0x${"00".repeat(32)}.json`), "not json");
    await writeFile(join(folder, `2-0x${"00".repeat(32)}.json`), "{}");
    await writeFile(join(folder, "notes.txt"), "x");
    await writeFile(join(folder, `3-0x${"00".repeat(32)}.json.123.tmp`), "x");
    const { archive } = await freshArchive();
    expect(await ingestCache(archive, directory)).toEqual({ inserted: 1, unchanged: 0, merged: 0, conflict: 0, invalid: 2 });
    expect((await archive.storageProofsAt({ chainId: record.chainId, address: record.address, blockNumber: BigInt(record.blockNumber) }))[0]?.sourceHost).toBeNull();
  });
});

describe("manifests", () => {
  it("lists every file with its hash and counts, and finds missing, changed and unlisted files", async () => {
    await exportArchive(await filledArchive(), directory);
    await mkdir(join(directory, "files"));
    await writeFile(join(directory, "files", "a.ssz"), "state");
    // A link is no file of the bundle.
    await symlink(join(directory, "files", "a.ssz"), join(directory, "files", "link.ssz"));
    const log = join(directory, "..", `ipfs-${Date.now()}.log`);
    await writeFile(log, "2026-11-01T00:00:00Z bafybeigdyrztktx5b5m7zj2r4p4tlwhz3xz3k3c3yq7bqv3hbv5v6t2gxa 3 a8c9ffd6b362acfdb444c62d039e9870bacfc690\n2026-11-02T00:00:00Z bafybeihkoviema7g3gxyt6la7vd5ho32ictqbilu3wnlo3rs7ewhnp7lly 4 a8c9ffd6b362acfdb444c62d039e9870bacfc690\n\n");
    const manifest = await writeManifest(directory, { commit: "a8c9ffd6b362acfdb444c62d039e9870bacfc690", now: () => new Date(0), ipfsLog: log });
    await rm(log);
    expect(manifest).toMatchObject({ formatVersion: 1, createdAt: "1970-01-01T00:00:00.000Z", commit: "a8c9ffd6b362acfdb444c62d039e9870bacfc690", lastPublished: "2026-11-02T00:00:00Z bafybeihkoviema7g3gxyt6la7vd5ho32ictqbilu3wnlo3rs7ewhnp7lly 4 a8c9ffd6b362acfdb444c62d039e9870bacfc690" });
    expect(manifest.host).toEqual(expect.any(String));
    expect(manifest.counts).toMatchObject({ archive: 4, files: 1, "archive/storage_proofs.ndjson": 2 });
    expect(await checkManifest(directory)).toEqual({ missing: [], changed: [], unlisted: [], checked: 5 });
    await writeFile(join(directory, "files", "a.ssz"), "other");
    await rm(join(directory, "archive", "conflicts.ndjson"));
    await writeFile(join(directory, "extra.txt"), "x");
    expect(await checkManifest(directory)).toEqual({ missing: ["archive/conflicts.ndjson"], changed: ["files/a.ssz"], unlisted: ["extra.txt"], checked: 4 });
    const publicManifest = await writeManifest(directory, { commit: "a8c9ffd6b362acfdb444c62d039e9870bacfc690", now: () => new Date(0), ipfsLog: join(directory, "missing.log"), public: true });
    expect(publicManifest.host).toBeUndefined();
    expect(publicManifest.lastPublished).toBeNull();
    expect(await listFiles(directory)).toContain("manifest.json");
  });
});

describe("verifyStorageProofs", () => {
  it("verifies against the state root of each block, and tells a bad proof from one it could not check", async () => {
    await mkdir(join(directory, "archive"));
    const good = sepoliaRecord();
    const lines = [good, { ...good, blockHash: `0x${"aa".repeat(32)}` }, { ...good, blockHash: `0x${"bb".repeat(32)}` }, { ...good, blockHash: `0x${"cc".repeat(32)}` }, { bad: true }, { ...good, storageKeys: [sepolia.storageKeys[1]] }];
    await writeFile(join(directory, "archive", "storage_proofs.ndjson"), lines.map((line) => JSON.stringify(line)).join("\n"));
    const root = vi.fn(async (_chainId: number, hash: Hex): Promise<Hex | null> => {
      if (hash === `0x${"aa".repeat(32)}`) return null;
      if (hash === `0x${"bb".repeat(32)}`) throw new Error("no EXPLORER_RPC_URL_11155111");
      if (hash === `0x${"cc".repeat(32)}`) return `0x${"00".repeat(32)}`;
      return sepolia.stateRoot;
    });
    const result = await verifyStorageProofs(directory, root);
    expect(result.verified).toBe(1);
    expect(result.unchecked.map((item) => item.reason)).toEqual(["the node does not have the block", "no EXPLORER_RPC_URL_11155111"]);
    expect(result.invalid.map((item) => item.reason)).toEqual(["node 0 does not match its hash", "the record does not parse", "no proof of the stored slot's key"]);
  });

  it("reads state roots by block hash from the endpoint of each chain", async () => {
    const getBlock = vi.fn(async ({ blockHash }: { blockHash: Hex }) => {
      if (blockHash === `0x${"aa".repeat(32)}`) throw new BlockNotFoundError({ blockHash });
      if (blockHash === `0x${"bb".repeat(32)}`) throw new Error("timeout");
      return { stateRoot: sepolia.stateRoot };
    });
    const makeClient = vi.fn(() => ({ getBlock }) as never);
    const read = rpcStateRoot({ EXPLORER_RPC_URL_1: "http://127.0.0.1:1" }, makeClient);
    expect(await read(1, sepolia.blockHash)).toBe(sepolia.stateRoot);
    expect(await read(1, `0x${"aa".repeat(32)}`)).toBeNull();
    await expect(read(1, `0x${"bb".repeat(32)}`)).rejects.toThrow("timeout");
    await expect(read(2, sepolia.blockHash)).rejects.toThrow("no EXPLORER_RPC_URL_2");
    expect(makeClient).toHaveBeenCalledTimes(1);
    expect(rpcStateRoot({})).toEqual(expect.any(Function));
    // The default client: nothing listens on port 1.
    await expect(rpcStateRoot({ EXPLORER_RPC_URL_1: "http://127.0.0.1:1" })(1, sepolia.blockHash)).rejects.toThrow();
  });
});

describe("the public tree", { timeout: 60_000 }, () => {
  it("writes the allowlisted chain data deterministically, from the archive or from a bundle, and passes its own check", async () => {
    const archive = await filledArchive();
    const fromArchive = join(directory, "a");
    expect(await exportPublicTree({ kind: "archive", archive }, fromArchive)).toEqual({ storageProofs: 1, lightClientProofs: 1, evidence: 1 });
    const bundle = join(directory, "bundle");
    await exportArchive(archive, bundle);
    const fromBundle = join(directory, "b");
    await exportPublicTree({ kind: "bundle", bundle }, fromBundle);
    const files = await listFiles(fromArchive);
    expect(await listFiles(fromBundle)).toEqual(files);
    for (const file of files) expect(await readFile(join(fromBundle, file), "utf8"), file).toBe(await readFile(join(fromArchive, file), "utf8"));
    const storageFile = files.find((file) => file.startsWith("storage-proofs/")) as string;
    expect(storageFile).toBe(`storage-proofs/${sepolia.chainId}/${sepolia.address}/${sepolia.blockNumber}-${sepolia.blockHash}.json`);
    const storage = await readFile(join(fromArchive, storageFile), "utf8");
    expect(JSON.parse(storage)).toHaveLength(2);
    expect(storage).not.toContain("rpc.example");
    expect(storage).not.toContain("fetchedAt");
    const light = await readFile(join(fromArchive, files.find((file) => file.startsWith("light-client-proofs/")) as string), "utf8");
    expect(light).not.toContain("job-9");
    expect(light).not.toContain("source");
    const evidence = files.find((file) => file.startsWith("evidence/")) as string;
    expect(await readFile(join(fromArchive, evidence), "utf8")).toBe('{"proof":["0x01"]}');
    await mkdir(join(fromArchive, "beacon-states", "943"), { recursive: true });
    await writeFile(join(fromArchive, "beacon-states", "943", `000000000064-0x${"ab".repeat(32)}.ssz`), Buffer.from([0xff, 0xfe, 0x00]));
    await writeFile(join(fromArchive, "beacon-states", "943", `000000000064-0x${"ab".repeat(32)}.summary`), "0x01\n0x02\n");
    await writeManifest(fromArchive, { commit: "a8c9ffd6b362acfdb444c62d039e9870bacfc690", now: () => new Date("2026-11-01T03:30:00Z"), public: true });
    expect(await checkPublicTree(fromArchive), JSON.stringify(await checkPublicTree(fromArchive))).toEqual([]);
  });

  it("refuses a record that does not parse", async () => {
    for (const table of ["storage_proofs", "light_client_proofs", "message_evidence"]) {
      const bundle = join(directory, table);
      await mkdir(join(bundle, "archive"), { recursive: true });
      await writeFile(join(bundle, "archive", `${table}.ndjson`), "{}\n");
      await expect(exportPublicTree({ kind: "bundle", bundle }, join(bundle, "out"))).rejects.toThrow("does not parse");
    }
  });

  it("sanitizer: refuses files out of place, non-text files, and anything that looks like a URL, address or key", async () => {
    const tree = join(directory, "tree");
    const put = async (path: string, text: string | Buffer) => {
      await mkdir(join(tree, path, ".."), { recursive: true });
      await writeFile(join(tree, path), text);
    };
    const hash = `0x${"ab".repeat(32)}`;
    await put("README.txt", PUBLIC_README);
    await put("notes.txt", "x");
    await put(`light-client-proofs/p/first-to-second/1-2-${hash}.json`, canonicalJson({ endpoint: "x", nested: [{ note: "see https://rpc.example/key" }] }));
    await put(`light-client-proofs/p/second-to-first/1-2-${hash}.json`, "not json");
    await put(`evidence/p/first-to-second/${hash}-${"cd".repeat(32)}.json`, canonicalJson({ a: "ops@example.com", b: "10.0.0.1", c: "fe80::1", d: "2001:db8:0:1:2:3:4:5" }));
    await put(`storage-proofs/1/0x${"01".repeat(20)}/5-${hash}.json`, canonicalJson({ k: "aB3dE5fG7hJ9kL1mN3pQ5r", t: "ghp_abcdefghij", s: "Bearer abc", fine: ["0xABCDEF0123456789abcdef0123456789", "12345678901234567890123", "first-to-second", 5, null, true] }));
    await put(`beacon-states/1/000000000001-${hash}.summary`, Buffer.from([0xc3, 0x28]));
    await put(`beacon-states/1/000000000002-${hash}.summary`, "0x01\nhttp://10.1.1.1\n");
    await put(`beacon-states/1/000000000003-${hash}.ssz`, Buffer.from([0x00, 0xff]));
    const problems = await checkPublicTree(tree);
    expect(problems).toEqual([
      { file: `beacon-states/1/000000000001-${hash}.summary`, reason: "is not UTF-8 text" },
      { file: `beacon-states/1/000000000002-${hash}.summary`, reason: "looks like a URL" },
      { file: `evidence/p/first-to-second/${hash}-${"cd".repeat(32)}.json`, reason: "looks like an email address" },
      { file: `evidence/p/first-to-second/${hash}-${"cd".repeat(32)}.json`, reason: "looks like an IPv4 address" },
      { file: `evidence/p/first-to-second/${hash}-${"cd".repeat(32)}.json`, reason: "looks like an IPv6 address" },
      { file: `light-client-proofs/p/first-to-second/1-2-${hash}.json`, reason: 'has the field "endpoint"' },
      { file: `light-client-proofs/p/first-to-second/1-2-${hash}.json`, reason: "looks like a URL" },
      { file: `light-client-proofs/p/second-to-first/1-2-${hash}.json`, reason: "is not JSON" },
      { file: "notes.txt", reason: "is not at an allowed path" },
      { file: `storage-proofs/1/0x${"01".repeat(20)}/5-${hash}.json`, reason: "looks like a key or token" },
    ]);
    expect(JSON.stringify(problems)).not.toContain("rpc.example");
    expect(suspiciousReason("2026-11-01T03:30:00.000Z")).toBeNull();
    const manifests = join(directory, "manifests");
    await mkdir(manifests);
    await writeFile(join(manifests, "manifest.json"), JSON.stringify({ commit: "a8c9ffd6b362acfdb444c62d039e9870bacfc690", files: { "notes.txt": { sha256: "00".repeat(32), bytes: 1 }, "README.txt": { sha256: "zz", bytes: 1 }, [`beacon-states/1/000000000001-${hash}.ssz`]: null } }));
    expect(await checkPublicTree(manifests)).toEqual([{ file: "manifest.json", reason: "lists a file it should not" }]);
    await writeFile(join(manifests, "manifest.json"), "{");
    expect(await checkPublicTree(manifests)).toEqual([{ file: "manifest.json", reason: "is not JSON" }]);
    await writeFile(join(manifests, "manifest.json"), JSON.stringify({ commit: "a8c9ffd6b362acfdb444c62d039e9870bacfc690" }));
    expect(await checkPublicTree(manifests)).toEqual([]);
    // The commit and the previous publication are checked by shape (plain hex and a CID would look like keys).
    await writeFile(join(manifests, "manifest.json"), JSON.stringify({ commit: "a8c9ffd6b362acfdb444c62d039e9870bacfc690", lastPublished: "2026-11-02T00:00:00Z bafybeihkoviema7g3gxyt6la7vd5ho32ictqbilu3wnlo3rs7ewhnp7lly 4 a8c9ffd6b362acfdb444c62d039e9870bacfc690" }));
    expect(await checkPublicTree(manifests)).toEqual([]);
    await writeFile(join(manifests, "manifest.json"), JSON.stringify({ commit: "sk_live_abcdef1234567890ab", lastPublished: "token=abc123def456ghi789jkl" }));
    expect(await checkPublicTree(manifests)).toEqual([
      { file: "manifest.json", reason: "has a commit that is not a git hash" },
      { file: "manifest.json", reason: "has a lastPublished line of another shape" },
    ]);
    expect(suspiciousReason("sk-abcdefghijk")).toBe("looks like a key or token");
  });
});

describe("the command line", { timeout: 60_000 }, () => {
  const run = async (argv: string[], overrides: Partial<CliDependencies> & { archive?: ProofArchive } = {}) => {
    const out: string[] = [];
    const log: string[] = [];
    const close = vi.fn(async () => {});
    const archive = overrides.archive ?? (await freshArchive()).archive;
    const code = await main(argv, { EXPLORER_PAIR: "sepolia-pls943" }, {
      openArchive: async () => ({ archive, close }),
      stateRoot: () => async () => sepolia.stateRoot,
      now: () => new Date(0),
      print: (text) => out.push(text),
      log: (text) => log.push(text),
      ...overrides,
    });
    return { code, out: out.map((text) => JSON.parse(text) as Record<string, unknown>), log: log.join("\n"), close, archive };
  };

  it("parses options and flags", () => {
    expect(parseOptions(["--out", "x", "--public", "--commit", "c"])).toEqual({ out: "x", public: "true", commit: "c" });
  });

  it("prints usage, refuses bad arguments with exit 2, and reports a failure with exit 1 without the URL", async () => {
    expect((await run([])).code).toBe(2);
    expect((await run(["help"])).code).toBe(0);
    expect((await run(["--help"])).log).toContain("usage:");
    expect((await run(["nope"])).code).toBe(2);
    expect((await run(["export"])).log).toContain("--out is required");
    expect((await run(["export", "--out"])).code).toBe(2);
    expect((await run(["export", "stray"])).code).toBe(2);
    const failed = await run(["migrate"], { openArchive: async () => Promise.reject(new Error("cannot reach postgresql://user:pw@db.example/x")) });
    expect(failed).toMatchObject({ code: 1 });
    expect(failed.log).toBe("zk-bridge-proof-archive: cannot reach postgresql://db.example");
  });

  it("migrates, exports, imports, ingests and closes the database each time", async () => {
    const migrated = await run(["migrate"]);
    expect(migrated.out[0]).toMatchObject({ migrated: true });
    expect(migrated.close).toHaveBeenCalled();
    const source = await filledArchive();
    const bundle = join(directory, "bundle");
    expect((await run(["export", "--out", bundle], { archive: source })).out[0]).toMatchObject({ exported: { storage_proofs: 2 } });
    const target = await run(["import", "--in", bundle]);
    expect(target.code).toBe(0);
    expect(target.out[0]).toMatchObject({ conflicts: 0, counts: { storageProofs: 2 } });
    const { archive: conflicting } = await freshArchive();
    await conflicting.putStorageProof({ ...sepoliaRecord(), proof: { other: 1 } });
    expect((await run(["import", "--in", bundle], { archive: conflicting })).code).toBe(3);

    const sqlite = join(directory, "backend.sqlite");
    const database = new DatabaseSync(sqlite);
    database.exec("CREATE TABLE webhook_proofs (job_id TEXT, direction TEXT, payload TEXT, start_slot TEXT, new_slot TEXT, stored_at INTEGER, posted_at INTEGER, message_hash TEXT)");
    database.prepare("INSERT INTO webhook_proofs VALUES ('j', 'first-to-second', ?, '64', '96', 1, NULL, NULL)").run(proofMessage("first-to-second", 64n, 96n));
    database.close();
    const ingested = await run(["ingest-backend", "--sqlite", sqlite]);
    expect(ingested.out[0]).toMatchObject({ ingested: { inserted: 1 }, rows: { held: 1 } });
    const { archive: other } = await freshArchive();
    await other.putLightClientProof({ ...lightClientRecord({ pair: "sepolia-pls943", direction: "first-to-second", proof: proofBytes(), publicValues: publicValuesFor(64n, 96n), source: "x" }), backendJobId: "different" });
    expect((await run(["ingest-backend", "--sqlite", sqlite], { archive: other })).code).toBe(3);
    expect((await main(["ingest-backend", "--sqlite", sqlite], {}, { ...(await cliWith(await freshArchive())) })).valueOf()).toBe(0);

    const cache = join(directory, "cache", String(sepolia.chainId), sepolia.address);
    await mkdir(cache, { recursive: true });
    const { sourceHost: _host, ...entry } = sepoliaRecord();
    await writeFile(join(cache, `${sepolia.blockNumber}-${sepolia.blockHash}.json`), JSON.stringify(entry));
    expect((await run(["ingest-cache", "--dir", join(directory, "cache")])).out[0]).toMatchObject({ ingested: { inserted: 1 } });
    const { archive: clash } = await freshArchive();
    await clash.putStorageProof({ ...sepoliaRecord(), proof: { other: 1 } });
    expect((await run(["ingest-cache", "--dir", join(directory, "cache")], { archive: clash })).code).toBe(3);
  });

  it("writes and checks manifests, verifies storage proofs, and builds and checks a public tree", async () => {
    const source = await filledArchive();
    const bundle = join(directory, "bundle");
    await run(["export", "--out", bundle], { archive: source });
    expect((await run(["manifest-write", "--dir", bundle, "--commit", "a8c9ffd6b362acfdb444c62d039e9870bacfc690"])).out[0]).toMatchObject({ files: 4 });
    expect((await run(["manifest-check", "--dir", bundle])).code).toBe(0);
    await appendFile(join(bundle, "archive", "conflicts.ndjson"), "x");
    expect((await run(["manifest-check", "--dir", bundle])).code).toBe(1);
    expect((await run(["verify-storage", "--in", bundle])).out[0]).toMatchObject({ verified: 2, invalid: [] });
    const unchecked = await run(["verify-storage", "--in", bundle], { stateRoot: () => async () => Promise.reject(new Error("down at https://rpc.example/key")) });
    expect(unchecked.out[0]).toMatchObject({ unchecked: [{ reason: "down at https://rpc.example" }, { reason: "down at https://rpc.example" }] });
    expect((await run(["verify-storage", "--in", bundle], { stateRoot: () => async () => `0x${"00".repeat(32)}` })).code).toBe(3);

    const tree = join(directory, "tree");
    expect((await run(["public-export", "--out", tree, "--in", bundle])).out[0]).toMatchObject({ public: { storageProofs: 1 } });
    expect((await run(["public-check", "--dir", tree])).code).toBe(0);
    const fromArchive = await run(["public-export", "--out", join(directory, "tree2")], { archive: source });
    expect(fromArchive.close).toHaveBeenCalled();
    await writeFile(join(tree, "stray.txt"), "x");
    expect((await run(["public-check", "--dir", tree])).code).toBe(3);
    expect((await run(["manifest-write", "--dir", tree, "--commit", "a8c9ffd6b362acfdb444c62d039e9870bacfc690", "--public", "--ipfs-log", join(directory, "none.log")])).code).toBe(0);
  });

  it("opens a pool archive only with a database URL, migrated, and closes the pool", async () => {
    await expect(openPoolArchive({})).rejects.toThrow("DATABASE_URL is not set");
    await expect(openPoolArchive({ DATABASE_URL: "postgresql://nobody@127.0.0.1:1/none?connect_timeout=1" })).rejects.toThrow();
    const { database } = await freshArchive();
    const end = vi.fn(async () => {});
    const pool = { query: (...args: [string, unknown[]?]) => (args.length === 1 ? database.exec(args[0]) : database.query(args[0], args[1])), end };
    const opened = await openPoolArchive({ DATABASE_URL: "postgresql:///x" }, () => pool as never);
    expect((await opened.archive.counts()).storageProofs).toBe(0);
    await opened.close();
    expect(end).toHaveBeenCalled();
  });

  it("writes to standard output and error, and reads the clock and endpoints, by default", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      defaultDependencies.print("{}");
      defaultDependencies.log("note");
      expect(out).toHaveBeenCalledWith("{}\n");
      expect(err).toHaveBeenCalledWith("note\n");
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    expect(defaultDependencies.now()).toBeInstanceOf(Date);
    const usage = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await main(["help"], {})).toBe(0);
      expect(String(usage.mock.calls[0]?.[0])).toContain("usage:");
    } finally {
      usage.mockRestore();
    }
    await expect(defaultDependencies.stateRoot({})(1, sepolia.blockHash)).rejects.toThrow("no EXPLORER_RPC_URL_1");
  });
});

/** The dependencies of `main` over a fresh archive, with output dropped. */
async function cliWith(fresh: { archive: ProofArchive }): Promise<CliDependencies> {
  return { openArchive: async () => ({ archive: fresh.archive, close: async () => {} }), stateRoot: () => async () => null, now: () => new Date(0), print: () => {}, log: () => {} };
}
