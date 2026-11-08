import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile, open } from "node:fs/promises";
import { hostname } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { join, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import type { Hex } from "viem";
import { openingStorageKey, proofCacheEntrySchema, verifyAccountProof } from "@zk-bridge/shared/prover";
import { evidenceRecordSchema, handoffRecord, handoffRecordSchema, lightClientProofRecordSchema, lightClientRecordConsistent, storageProofRecordSchema, type HandoffRecord, type StorageProofRecord } from "./records";
import { emptyTally, type ProofArchive } from "./store";
import type { IngestTally } from "./backend-rows";

/**
 * The archive part of a backup bundle (deploy/app-server/proofs.sh): one file of JSON records a line per table, under
 * `<bundle>/archive/`, and the manifest of the whole bundle (`manifest.json`: SHA-256 of every file, counts, commit).
 */

/** The tables of the archive part, as their file names (without `.ndjson`). */
export const ARCHIVE_FILES = ["storage_proofs", "light_client_proofs", "message_evidence", "handoff_updates", "conflicts"] as const;

/** Writes every row of the archive into `<bundle>/archive/<table>.ndjson`. Returns the rows per file. */
export async function exportArchive(archive: ProofArchive, bundle: string): Promise<Record<string, number>> {
  const directory = join(bundle, "archive");
  await mkdir(directory, { recursive: true });
  const counts: Record<string, number> = {};
  for (const table of ARCHIVE_FILES) {
    const file = await open(join(directory, `${table}.ndjson`), "w");
    let count = 0;
    try {
      for await (const page of archive.pages(table)) {
        await file.write(page.map((row) => `${JSON.stringify(row)}\n`).join(""));
        count += page.length;
      }
    } finally {
      await file.close();
    }
    counts[table] = count;
  }
  return counts;
}

/** The lines of a file of JSON records, or none when the file is missing. */
export async function* recordsOf(path: string): AsyncGenerator<unknown> {
  try {
    await stat(path);
  } catch {
    return;
  }
  const lines = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    try {
      yield JSON.parse(line) as unknown;
    } catch {
      yield undefined;
    }
  }
}

/** The records to import, one stream per table (lines of a bundle file, or the record files of the mirror). */
export type RecordSources = { readonly storage: AsyncIterable<unknown>; readonly lightClient: AsyncIterable<unknown>; readonly evidence: AsyncIterable<unknown>; readonly handoffs: AsyncIterable<unknown> };

/** A handoff update from a file, or null: it must parse, pass the checks of its text, and carry the hash and slots of its text. */
function checkedHandoff(raw: unknown): HandoffRecord | null {
  const parsed = handoffRecordSchema.safeParse(raw);
  if (!parsed.success) return null;
  const checked = handoffRecord(parsed.data);
  return checked.ok && isDeepStrictEqual(checked.record, parsed.data) ? parsed.data : null;
}

/**
 * Upserts records. A record that does not parse, or a light client record whose slots and hash do not match its proof,
 * or evidence whose hash does not match its body, or a handoff update that fails its checks, is counted as invalid and
 * skipped.
 */
export async function importRecords(archive: ProofArchive, sources: RecordSources): Promise<Record<"storage_proofs" | "light_client_proofs" | "message_evidence" | "handoff_updates", IngestTally>> {
  const fresh = (): IngestTally => ({ ...emptyTally(), invalid: 0 });
  const result = { storage_proofs: fresh(), light_client_proofs: fresh(), message_evidence: fresh(), handoff_updates: fresh() };
  for await (const raw of sources.storage) {
    const parsed = storageProofRecordSchema.safeParse(raw);
    if (!parsed.success) result.storage_proofs.invalid += 1;
    else result.storage_proofs[await archive.putStorageProof(parsed.data)] += 1;
  }
  for await (const raw of sources.lightClient) {
    const parsed = lightClientProofRecordSchema.safeParse(raw);
    if (!parsed.success || !lightClientRecordConsistent(parsed.data)) result.light_client_proofs.invalid += 1;
    else result.light_client_proofs[await archive.putLightClientProof(parsed.data)] += 1;
  }
  for await (const raw of sources.evidence) {
    const parsed = evidenceRecordSchema.safeParse(raw);
    if (!parsed.success || `0x${createHash("sha256").update(parsed.data.body).digest("hex")}` !== parsed.data.bodyHash.toLowerCase()) result.message_evidence.invalid += 1;
    else result.message_evidence[await archive.putEvidence(parsed.data)] += 1;
  }
  for await (const raw of sources.handoffs) {
    const record = checkedHandoff(raw);
    if (record === null) result.handoff_updates.invalid += 1;
    else result.handoff_updates[await archive.putHandoff(record)] += 1;
  }
  return result;
}

/** Upserts the archive files of a bundle (see {@link importRecords}). The conflicts file is a report and is not read. */
export function importArchive(archive: ProofArchive, bundle: string): Promise<Record<"storage_proofs" | "light_client_proofs" | "message_evidence" | "handoff_updates", IngestTally>> {
  const directory = join(bundle, "archive");
  return importRecords(archive, {
    storage: recordsOf(join(directory, "storage_proofs.ndjson")),
    lightClient: recordsOf(join(directory, "light_client_proofs.ndjson")),
    evidence: recordsOf(join(directory, "message_evidence.ndjson")),
    handoffs: recordsOf(join(directory, "handoff_updates.ndjson")),
  });
}

/** Every file under a directory, as paths relative to it with `/`, sorted. */
export async function listFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) found.push(relative(root, path).split(sep).join("/"));
    }
  };
  await walk(root);
  return found.sort();
}

/** Upserts every entry of a proof cache directory (`<chain id>/<address>/<block>-<hash>.json`). */
export async function ingestCache(archive: ProofArchive, directory: string): Promise<IngestTally> {
  const tally: IngestTally = { ...emptyTally(), invalid: 0 };
  for (const name of await listFiles(directory)) {
    if (!/^\d+\/0x[0-9a-f]{40}\/\d+-0x[0-9a-f]{64}\.json$/.test(name)) continue;
    let parsed;
    try {
      parsed = proofCacheEntrySchema.safeParse(JSON.parse(await readFile(join(directory, name), "utf8")));
    } catch {
      parsed = { success: false as const };
    }
    if (!parsed.success) tally.invalid += 1;
    else tally[await archive.putStorageProof({ ...parsed.data, sourceHost: null })] += 1;
  }
  return tally;
}

export const sha256OfFile = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
};

/** The manifest of a bundle. */
export interface Manifest {
  readonly formatVersion: 1;
  readonly createdAt: string;
  readonly commit: string;
  /** The server that wrote it. Left out of a public tree. */
  readonly host?: string;
  /** Files per top-level directory, and records per archive file. */
  readonly counts: Record<string, number>;
  readonly files: Record<string, { readonly sha256: string; readonly bytes: number }>;
  /** The newest line of the IPFS publication log, when one was given. */
  readonly lastPublished?: string | null;
}

/** The newest line of the IPFS publication log, or null when there is none. */
export async function lastPublishedLine(ipfsLog: string): Promise<string | null> {
  const text = await readFile(ipfsLog, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line.trim() !== "").at(-1) ?? null;
}

/** Writes `<bundle>/manifest.json` over every other file of the bundle. */
export async function writeManifest(bundle: string, input: { readonly commit: string; readonly now: () => Date; readonly ipfsLog?: string; readonly public?: boolean }): Promise<Manifest> {
  const files: Record<string, { sha256: string; bytes: number }> = {};
  const counts: Record<string, number> = {};
  for (const name of await listFiles(bundle)) {
    if (name === "manifest.json") continue;
    const path = join(bundle, name);
    files[name] = { sha256: await sha256OfFile(path), bytes: (await stat(path)).size };
    const top = name.includes("/") ? (name.split("/")[0] as string) : ".";
    counts[top] = (counts[top] ?? 0) + 1;
    if (name.startsWith("archive/") && name.endsWith(".ndjson")) {
      let lines = 0;
      for await (const _record of recordsOf(path)) lines += 1;
      counts[name] = lines;
    }
  }
  const lastPublished = input.ipfsLog === undefined ? undefined : await lastPublishedLine(input.ipfsLog);
  const manifest: Manifest = {
    formatVersion: 1,
    createdAt: input.now().toISOString(),
    commit: input.commit,
    ...(input.public === true ? {} : { host: hostname() }),
    counts,
    files,
    ...(lastPublished === undefined ? {} : { lastPublished }),
  };
  await writeFile(join(bundle, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** What a manifest check found. Empty lists mean the bundle is whole. */
export type ManifestCheck = { readonly missing: string[]; readonly changed: string[]; readonly unlisted: string[]; readonly checked: number };

/** Re-hashes every file the manifest lists, and lists files it does not. */
export async function checkManifest(bundle: string): Promise<ManifestCheck> {
  const manifest = JSON.parse(await readFile(join(bundle, "manifest.json"), "utf8")) as Manifest;
  const present = new Set((await listFiles(bundle)).filter((name) => name !== "manifest.json"));
  const result = { missing: [] as string[], changed: [] as string[], unlisted: [] as string[], checked: 0 };
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (!present.has(name)) {
      result.missing.push(name);
      continue;
    }
    present.delete(name);
    result.checked += 1;
    if ((await sha256OfFile(join(bundle, name))) !== expected.sha256) result.changed.push(name);
  }
  result.unlisted.push(...present);
  return result;
}

/** Reads the state root of a block by hash, or null when the node does not know the block. */
export type BlockRootReader = (chainId: number, blockHash: Hex) => Promise<Hex | null>;

/** What a re-verification found. */
export type StorageVerification = {
  verified: number;
  invalid: Array<{ chainId: number; blockNumber: number; blockHash: string; reason: string }>;
  /** No RPC for the chain, or the node does not have the block (an orphan, or a node without it). */
  unchecked: Array<{ chainId: number; blockNumber: number; blockHash: string; reason: string }>;
};

/**
 * Re-verifies storage proof records (of a bundle or of the mirror) against the state root of each block, read from a
 * node by block hash. Headers stay available on every node, so this works long after the proof window closed.
 */
export async function verifyStorageProofs(records: AsyncIterable<unknown>, stateRoot: BlockRootReader): Promise<StorageVerification> {
  const result: StorageVerification = { verified: 0, invalid: [], unchecked: [] };
  for await (const raw of records) {
    const parsed = storageProofRecordSchema.safeParse(raw);
    if (!parsed.success) {
      result.invalid.push({ chainId: 0, blockNumber: 0, blockHash: "", reason: "the record does not parse" });
      continue;
    }
    const record: StorageProofRecord = parsed.data;
    const where = { chainId: record.chainId, blockNumber: record.blockNumber, blockHash: record.blockHash };
    let root: Hex | null;
    try {
      root = await stateRoot(record.chainId, record.blockHash as Hex);
    } catch (error) {
      result.unchecked.push({ ...where, reason: (error as Error).message });
      continue;
    }
    if (root === null) {
      result.unchecked.push({ ...where, reason: "the node does not have the block" });
      continue;
    }
    // The record must prove the key of the head it names (executionBlockHashes[storedSlot], opening.rs), not just any key.
    const requiredKey = openingStorageKey(BigInt(record.storedSlot));
    if (!record.storageKeys.some((key) => key.toLowerCase() === requiredKey)) {
      result.invalid.push({ ...where, reason: "no proof of the stored slot's key" });
      continue;
    }
    const verdict = verifyAccountProof({ stateRoot: root, address: record.address as Hex, storageKeys: [requiredKey, ...(record.storageKeys as Hex[])], answer: record.proof });
    if (verdict.ok) result.verified += 1;
    else result.invalid.push({ ...where, reason: verdict.reason });
  }
  return result;
}
