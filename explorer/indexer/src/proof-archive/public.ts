import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { evidenceRecordSchema, forkProofArchiveRecord, forkProofRecordSchema, handoffRecord, handoffRecordSchema, lightClientProofRecordSchema, storageProofRecordSchema, type EvidenceRecord, type LightClientProofRecord, type StorageProofRecord } from "./records";
import { listFiles, recordsOf } from "./bundle";
import { mergedMirrorRecords, mirrorRecords } from "./mirror";
import type { ProofArchive } from "./store";

/**
 * The public bundle: the chain data of the archive as a tree that anyone can browse on IPFS and check, published by
 * `deploy/app-server/proofs.sh publish`. Owner, 2026-11-01: "can we do ipfs as well? that could be cool. we have to
 * publish the data though".
 *
 * Only an allowlist goes in: storage proofs (the `eth_getProof` answer and what it proves), light client update proofs
 * (proof, public values, slots, direction, the posting transaction), the delivery evidence of messages, and verified
 * beacon states (copied in by the script). No source host, no fetch time, no job id, nothing of the backend's
 * bookkeeping. Every file is canonical JSON (sorted keys, one line) in a fixed place, so unchanged content gives the same
 * bytes and the same CIDs. {@link checkPublicTree} refuses a tree with anything else in it.
 */

/** Where the records come from: the archive database, the archive files of a backup bundle, or the private mirror. */
export type PublicSource =
  | { readonly kind: "archive"; readonly archive: ProofArchive }
  | { readonly kind: "bundle"; readonly bundle: string }
  | { readonly kind: "mirror"; readonly mirror: string };

const MIRROR_DIRECTORY = { storage_proofs: "storage-proofs", light_client_proofs: "light-client-proofs", message_evidence: "evidence", handoff_updates: "handoff-updates", fork_proofs: "fork-proofs" } as const;

async function* rowsOf(source: PublicSource, table: "storage_proofs" | "light_client_proofs" | "message_evidence" | "handoff_updates" | "fork_proofs"): AsyncGenerator<unknown> {
  if (source.kind === "archive") {
    for await (const page of source.archive.pages(table)) yield* page;
  } else if (source.kind === "bundle") {
    yield* recordsOf(join(source.bundle, "archive", `${table}.ndjson`));
  } else if (table === "storage_proofs") {
    // Storage proofs never change once archived; a copy of the same answer is dropped when the file is written.
    yield* mirrorRecords(source.mirror, MIRROR_DIRECTORY[table]);
  } else {
    // A light client proof or evidence can have versions (filled in later): one public file holds them merged.
    yield* mergedMirrorRecords(source.mirror, MIRROR_DIRECTORY[table]);
  }
}

/** JSON with sorted keys at every level, on one line, with a final newline. */
export function canonicalJson(value: unknown): string {
  const sorted = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sorted);
    if (typeof item === "object" && item !== null) return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sorted((item as Record<string, unknown>)[key])]));
    return item;
  };
  return `${JSON.stringify(sorted(value))}\n`;
}

async function put(root: string, path: string, text: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

/** The README of the public tree. Plain text, no addresses of any service. */
export const PUBLIC_README = `zk-bridge proof archive (public part)

The proofs a zk-bridge deployment collected, so that nobody has to compute them again. Every file is public chain data.
Nothing here is trusted: check each file before you use it.

manifest.json
  The format version, the commit of the code that wrote the tree, the time, the number of files per folder, and the
  SHA-256 of every file. Check a file with: sha256sum <file>, and compare with its entry.

storage-proofs/<chain id>/<account>/<block number>-<block hash>.json
  A list of eth_getProof answers for the account in that block: chainId, blockNumber, blockHash, address, storedSlot
  (the light client head whose executionBlockHashes entry the storage key opens), storageKeys, and proof (the answer
  as the node sent it). Check: read the header of the block by its hash from any node, and verify accountProof against
  its stateRoot and each storageProof against the account's storageHash (Merkle Patricia proofs, EIP-1186).

light-client-proofs/<pair>/<direction>/<start slot>-<new slot>-<proof hash>.json
  One SP1 light client update proof: proof (Groth16, as the verifier contract reads it), publicValues (the encoded
  LightClientOutput), the slots and roots read from them, proofHash (keccak256 of proof), the proof message (payload)
  and program key when known, and the update transaction that posted it when there was one. Check: call verifyProof of
  the SP1 verifier with the program key, the public values and the proof, or compare the calldata of the posting
  transaction.

evidence/<pair>/<direction>/<message id>-<sha256 of the file>.json
  The delivery evidence of a message, byte for byte as it was built. The name holds the SHA-256 of the file.

handoff-updates/<chain id>/<period>.json
  The handoff update of one sync-committee period of a source chain: a complete light client update that carries the
  committee of the next period, as a prover needs it to move a light client over that period. A prover reads the update
  of period N of chain C at <this tree>/handoff-updates/C/N.json. Nobody has to trust the file: the zk proof checks the
  committee signatures, and a wrong update gives no valid proof.

fork-proofs/<chain id>/<state root>.json
  The fork proof of one source beacon block: the fork version and the genesis validators root of the chain, each with
  its branch up to the state root of the block (the record names the slot, the block root, the execution block and the
  shape of the state). A prover reads the proof of the block with state root S of chain C at
  <this tree>/fork-proofs/C/S.json when no beacon node serves that state any more. Check: the two branches against the
  state root (the same rule the bridge runs on chain); a wrong record gives no valid proof.

beacon-states/<chain id>/<slot>-<state root>.ssz (and .summary)
  Beacon states that a prover verified and kept, as SSZ. Check: hash_tree_root of the state equals the root in the name.
`;

/**
 * The public fields of a storage proof: what it proves and the answer, as a proof cache entry without the fetch time.
 * The read routes of the indexer and the public tree both use these projections, so both show the same fields.
 */
export function publicStorageProof(record: StorageProofRecord) {
  return {
    schemaVersion: record.schemaVersion,
    chainId: record.chainId,
    blockNumber: record.blockNumber,
    blockHash: record.blockHash,
    address: record.address,
    storedSlot: record.storedSlot,
    storageKeys: record.storageKeys,
    proof: record.proof,
  };
}

/** The public fields of a light client proof: everything but where the archive got it and the backend's job id. */
export function publicLightClientProof(record: LightClientProofRecord) {
  const { source: _source, backendJobId: _job, ...rest } = record;
  return rest;
}

/** The public fields of a piece of evidence: the body and what names it, not the backend's time or the source. */
export function publicEvidence(record: EvidenceRecord) {
  return { messageId: record.messageId, bodyHash: record.bodyHash, pair: record.pair, direction: record.direction, body: record.body };
}

/** What the public list of fork proofs and the public tree show of one record: where it is and what names it. */
export function publicForkProofEntry(entry: { readonly slot: number; readonly stateRoot: string; readonly blockRoot: string; readonly executionBlockNumber: number }) {
  return { slot: entry.slot, stateRoot: entry.stateRoot, blockRoot: entry.blockRoot, executionBlockNumber: entry.executionBlockNumber };
}

/** Writes the public tree of the records into `out` (which should be empty). Returns the files per kind. */
export async function exportPublicTree(source: PublicSource, out: string): Promise<Record<"storageProofs" | "lightClientProofs" | "evidence" | "handoffUpdates" | "forkProofs", number>> {
  const counts = { storageProofs: 0, lightClientProofs: 0, evidence: 0, handoffUpdates: 0, forkProofs: 0 };
  await mkdir(out, { recursive: true });
  await put(out, "README.txt", PUBLIC_README);

  // The records come in key order, so the answers of one block are next to each other.
  const open: { group: { path: string; entries: unknown[]; seen: Set<string> } | null } = { group: null };
  const flush = async () => {
    if (open.group === null) return;
    await put(out, open.group.path, canonicalJson(open.group.entries));
    counts.storageProofs += 1;
  };
  for await (const raw of rowsOf(source, "storage_proofs")) {
    const parsed = storageProofRecordSchema.safeParse(raw);
    if (!parsed.success) throw new Error("a storage proof record does not parse");
    const record = parsed.data;
    const path = `storage-proofs/${record.chainId}/${record.address.toLowerCase()}/${record.blockNumber}-${record.blockHash.toLowerCase()}.json`;
    const entry = publicStorageProof(record);
    const text = canonicalJson(entry);
    if (open.group?.path === path) {
      if (!open.group.seen.has(text)) open.group.entries.push(entry);
      open.group.seen.add(text);
    } else {
      await flush();
      open.group = { path, entries: [entry], seen: new Set([text]) };
    }
  }
  await flush();

  for await (const raw of rowsOf(source, "light_client_proofs")) {
    const parsed = lightClientProofRecordSchema.safeParse(raw);
    if (!parsed.success) throw new Error("a light client proof record does not parse");
    const record = publicLightClientProof(parsed.data);
    await put(out, `light-client-proofs/${record.pair}/${record.direction}/${record.startSlot}-${record.newSlot}-${record.proofHash.toLowerCase()}.json`, canonicalJson(record));
    counts.lightClientProofs += 1;
  }

  for await (const raw of rowsOf(source, "message_evidence")) {
    const parsed = evidenceRecordSchema.safeParse(raw);
    if (!parsed.success) throw new Error("an evidence record does not parse");
    const record = publicEvidence(parsed.data);
    await put(out, `evidence/${record.pair}/${record.direction}/${record.messageId.toLowerCase()}-${record.bodyHash.slice(2).toLowerCase()}.json`, record.body);
    counts.evidence += 1;
  }

  for await (const raw of rowsOf(source, "handoff_updates")) {
    const parsed = handoffRecordSchema.safeParse(raw);
    if (!parsed.success || !handoffRecord(parsed.data).ok) throw new Error("a handoff update record does not parse");
    // The file is the record text exactly as the backend stored it.
    await put(out, `handoff-updates/${parsed.data.chainId}/${parsed.data.period}.json`, parsed.data.record);
    counts.handoffUpdates += 1;
  }

  for await (const raw of rowsOf(source, "fork_proofs")) {
    const parsed = forkProofRecordSchema.safeParse(raw);
    if (!parsed.success || !forkProofArchiveRecord(parsed.data).ok) throw new Error("a fork proof record does not parse");
    // The file is the record text exactly as the backend stored it.
    await put(out, `fork-proofs/${parsed.data.chainId}/${parsed.data.stateRoot}.json`, parsed.data.record);
    counts.forkProofs += 1;
  }
  return counts;
}

const DIRECTION = "(first-to-second|second-to-first)";
const HASH = "0x[0-9a-f]{64}";
const ALLOWED_PATHS = [
  /^README\.txt$/,
  /^manifest\.json$/,
  new RegExp(`^storage-proofs/\\d+/0x[0-9a-f]{40}/\\d+-${HASH}\\.json$`),
  new RegExp(`^light-client-proofs/[a-z0-9-]+/${DIRECTION}/\\d+-\\d+-${HASH}\\.json$`),
  new RegExp(`^evidence/[a-z0-9-]+/${DIRECTION}/${HASH}-[0-9a-f]{64}\\.json$`),
  /^handoff-updates\/\d+\/\d+\.json$/,
  new RegExp(`^fork-proofs/\\d+/${HASH}\\.json$`),
  /^beacon-states\/\d+\/\d{12}-0x[0-9a-f]{64}\.(ssz|summary)$/,
];

/** Field names that never belong in public data. */
const FORBIDDEN_FIELDS = /^(source_?host|host|hostname|url|uri|endpoint|rpc(_?url)?|email|ip|caller|requester|job_?id|backend_?job_?id|token|secret|api_?key|password)$/i;

/** What a string must not look like. The value itself is never reported. */
const SUSPICIOUS: ReadonlyArray<readonly [string, RegExp]> = [
  ["a URL", /[a-z][a-z0-9+.-]*:\/\//i],
  ["an email address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/],
  ["an IPv4 address", /\b(?:\d{1,3}\.){3}\d{1,3}\b/],
  // Three colons at least, or "::": a clock time such as 03:30:00 has two.
  ["an IPv6 address", /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b|[0-9a-f]{0,4}::[0-9a-f]{1,4}/i],
  ["a key or token", /\b(vk_|sk-|sk_live|rpa_|gh[pousr]_|xox[abposr]-|AKIA|AIza)[A-Za-z0-9_-]{6,}|Bearer\s+\S|PRIVATE KEY/],
];

/** Whether a word looks like a random secret: long, mixed letters and digits, and not a 0x hex value or a number. */
function looksLikeSecret(word: string): boolean {
  if (word.length < 20 || /^0x[0-9a-fA-F]*$/.test(word) || /^\d+$/.test(word)) return false;
  return /[A-Za-z]/.test(word) && /\d/.test(word);
}

/** The reason a string fails, or null. */
export function suspiciousReason(text: string): string | null {
  for (const [reason, pattern] of SUSPICIOUS) if (pattern.test(text)) return `looks like ${reason}`;
  for (const word of text.split(/[^A-Za-z0-9_+/=-]+/)) if (looksLikeSecret(word)) return "looks like a key or token";
  return null;
}

/** One problem of a public tree. */
export type PublicProblem = { readonly file: string; readonly reason: string };

function scanJson(value: unknown, problems: string[]): void {
  if (typeof value === "string") {
    const reason = suspiciousReason(value);
    if (reason !== null) problems.push(reason);
  } else if (Array.isArray(value)) {
    for (const item of value) scanJson(item, problems);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_FIELDS.test(key)) problems.push(`has the field "${key}"`);
      else scanJson(item, problems);
    }
  }
}

/**
 * A handoff update holds only hex, numbers and fixed key names. Its `format` tag is a fixed 20 character word that the
 * general rule would take for a key, so it must be exactly the tag; the rest is scanned as usual. The record must also
 * be valid for the chain and period its path names.
 */
function scanHandoff(file: string, text: string, problems: string[]): void {
  const match = /^handoff-updates\/(\d+)\/(\d+)\.json$/.exec(file) as RegExpExecArray;
  if (!handoffRecord({ chainId: Number(match[1]), period: Number(match[2]), record: text, storedAt: null, source: "public" }).ok) {
    problems.push("is not a valid handoff update for its path");
    return;
  }
  const { format: _format, ...rest } = JSON.parse(text) as Record<string, unknown>;
  scanJson(rest, problems);
}

/**
 * A fork proof holds only hex, numbers and fixed key names. It must pass the whole check of `checkForkProofRecord` for the
 * chain and state root its path names (the branches included); the text is then scanned as usual.
 */
function scanForkProof(file: string, text: string, problems: string[]): void {
  const match = /^fork-proofs\/(\d+)\/(0x[0-9a-f]{64})\.json$/.exec(file) as RegExpExecArray;
  if (!forkProofArchiveRecord({ chainId: Number(match[1]), stateRoot: match[2] as string, record: text, storedAt: null, source: "public" }).ok) {
    problems.push("is not a valid fork proof for its path");
    return;
  }
  scanJson(JSON.parse(text), problems);
}

/**
 * The manifest lists files by path with their SHA-256 in plain hex, which the general rule would take for keys. Its
 * `files` must name allowed paths with 64 hex digits and a size; everything else in it is scanned as usual.
 */
/** A git commit hash, or "unknown" when the release names none. */
const COMMIT = /^(?:[0-9a-f]{40}|unknown)$/;

/** "<ISO time> <CIDv1 in base32> <count> <commit>", as proofs.sh appends it to the publication log. */
const LAST_PUBLISHED = /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z b[a-z2-7]{20,} \d+ (?:[0-9a-f]{40}|unknown)$/;

function scanManifest(manifest: Record<string, unknown>, problems: string[]): void {
  // The commit of the release is a git hash in plain hex, which the general rule would take for a key: it must be exactly
  // 40 hex digits (or "unknown"), and is not scanned otherwise.
  const { files, commit, lastPublished, ...rest } = manifest;
  if (commit !== undefined && !(typeof commit === "string" && COMMIT.test(commit))) problems.push("has a commit that is not a git hash");
  // The line of the previous publication: its time, its CID (letters and digits, like a key), its count and its commit.
  if (lastPublished !== undefined && lastPublished !== null && !(typeof lastPublished === "string" && LAST_PUBLISHED.test(lastPublished)))
    problems.push("has a lastPublished line of another shape");
  scanJson(rest, problems);
  for (const [path, entry] of Object.entries((files ?? {}) as Record<string, unknown>)) {
    const { sha256, bytes, ...other } = (entry ?? {}) as Record<string, unknown>;
    const shaped = typeof sha256 === "string" && /^[0-9a-f]{64}$/.test(sha256) && typeof bytes === "number" && Object.keys(other).length === 0;
    if (!ALLOWED_PATHS.some((pattern) => pattern.test(path)) || !shaped) problems.push("lists a file it should not");
  }
}

/**
 * The sanitizer of the public tree: every file must sit at an allowed path, and every text in it must not look like a
 * URL, an IP address, an email address or a key. SSZ beacon states are binary chain data and are not scanned.
 */
export async function checkPublicTree(root: string): Promise<PublicProblem[]> {
  const problems: PublicProblem[] = [];
  for (const file of await listFiles(root)) {
    if (!ALLOWED_PATHS.some((pattern) => pattern.test(file))) {
      problems.push({ file, reason: "is not at an allowed path" });
      continue;
    }
    if (file.endsWith(".ssz")) continue;
    const bytes = await readFile(join(root, file));
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      problems.push({ file, reason: "is not UTF-8 text" });
      continue;
    }
    const found: string[] = [];
    if (file === "manifest.json") {
      try {
        scanManifest(JSON.parse(text) as Record<string, unknown>, found);
      } catch {
        found.push("is not JSON");
      }
    } else if (file.startsWith("handoff-updates/")) {
      scanHandoff(file, text, found);
    } else if (file.startsWith("fork-proofs/")) {
      scanForkProof(file, text, found);
    } else if (file.endsWith(".json")) {
      try {
        scanJson(JSON.parse(text), found);
      } catch {
        found.push("is not JSON");
      }
    } else {
      for (const line of text.split("\n")) {
        const reason = suspiciousReason(line);
        if (reason !== null) found.push(reason);
      }
    }
    for (const reason of new Set(found)) problems.push({ file, reason });
  }
  return problems;
}
