import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { secondsPerSlot } from "@zk-bridge/shared";
import { importRecords, lastPublishedLine, listFiles, sha256OfFile } from "./bundle";
import { canonicalJson } from "./public";
import type { IngestTally } from "./backend-rows";
import type { ProofArchive } from "./store";

/**
 * The private mirror of the proof archive (deploy/app-server/proofs.sh, docs/proof-archive.md). Owner, 2026-11-02:
 * "ok, so lets plan to do 30 days of everything".
 *
 * One file per record, in the per-file layout of the public tree, but with the whole record (source host, job id, fetch
 * time): `<public stem>.<SHA-256 of the file>.json`. The name carries the content, so a file is written once and never
 * again; a record that a later source filled in (a posting transaction, say) is a new file beside the old one. Beside the
 * records: the verified beacon states of the services, SQLite snapshots of the backend and one manifest a day. Records
 * stay for good; beacon states, snapshots and manifests stay for a window of days.
 */

/** The record directories: never pruned. */
export const RECORD_DIRECTORIES = ["storage-proofs", "light-client-proofs", "evidence", "handoff-updates", "conflicts"] as const;
/** The directories that keep a window of days. */
export const PRUNED_DIRECTORIES = ["beacon-states", "snapshots", "manifests"] as const;
export const MIRROR_DIRECTORIES = [...RECORD_DIRECTORIES, ...PRUNED_DIRECTORIES] as const;

export type RecordDirectory = (typeof RECORD_DIRECTORIES)[number];

const sha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** A UTC stamp as proofs.sh writes it: 20261102T033000Z. */
const STAMP = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
const BEACON_FILE = /^(\d+)\/(\d{12})-0x[0-9a-f]{64}\.(ssz|summary)$/;
const SNAPSHOT_FILE = /^\d{8}T\d{6}Z\.sqlite$/;
const RECORD_FILE = /^(.+)\.([0-9a-f]{64})\.json$/;
/** A temporary file of {@link writeOnce}: `.<name>.tmp-<pid>-<n>`. */
const TEMPORARY_FILE = /^\..+\.tmp-\d+-\d+$/;

/** A path part from a record: letters, digits, `.`, `_` and `-`, never starting with a dot. */
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

function segment(value: unknown): string {
  const text = String(value);
  if (!SEGMENT.test(text)) throw new Error("a record names an unsafe path part");
  return text;
}

const lower = (value: unknown) => String(value).toLowerCase();

/** The file of one record in the mirror: its path and its bytes (canonical JSON). */
export function mirrorFile(kind: RecordDirectory, record: Record<string, unknown>): { readonly path: string; readonly text: string } {
  const text = canonicalJson(record);
  let stem: unknown[];
  if (kind === "storage-proofs") stem = [record.chainId, lower(record.address), `${record.blockNumber}-${lower(record.blockHash)}`];
  else if (kind === "light-client-proofs") stem = [record.pair, record.direction, `${record.startSlot}-${record.newSlot}-${lower(record.proofHash)}`];
  else if (kind === "evidence") stem = [record.pair, record.direction, `${lower(record.messageId)}-${lower(record.bodyHash).slice(2)}`];
  else if (kind === "handoff-updates") stem = [record.chainId, record.period];
  else stem = ["conflict"];
  return { path: `${kind}/${stem.map(segment).join("/")}.${sha256(text)}.json`, text };
}

/** What a write-once did. */
export type WriteOutcome = "written" | "identical" | "conflict";

let temporaryCounter = 0;

/**
 * Writes `bytes` to `root/relative` when no file is there: through a temporary file and a rename, mode 0644 whatever the
 * umask (the pull and the publication read what the archive user writes). An equal file is left alone ("identical"); a
 * file with other content is never replaced ("conflict").
 */
export async function writeOnce(root: string, relative: string, bytes: string | Buffer): Promise<WriteOutcome> {
  const target = join(root, relative);
  const content = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
  const existing = await readFile(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing !== null) return existing.equals(content) ? "identical" : "conflict";
  await mkdir(dirname(target), { recursive: true });
  temporaryCounter += 1;
  const temporary = join(dirname(target), `.${basename(target)}.tmp-${process.pid}-${temporaryCounter}`);
  await writeFile(temporary, content, { flag: "wx", mode: 0o644 });
  await chmod(temporary, 0o644);
  await rename(temporary, target);
  return "written";
}

/** The archive tables and the mirror directory of each. */
const TABLES = [
  ["storage_proofs", "storage-proofs"],
  ["light_client_proofs", "light-client-proofs"],
  ["message_evidence", "evidence"],
  ["handoff_updates", "handoff-updates"],
  ["conflicts", "conflicts"],
] as const;

/** What {@link writeMirrorRecords} did. A conflict is a file that exists with other content; it was not rewritten. */
export type MirrorWrite = { readonly written: Record<RecordDirectory, number>; identical: number; readonly conflicts: string[] };

/** Writes every row of the archive as a record file into the mirror. */
export async function writeMirrorRecords(archive: ProofArchive, mirror: string): Promise<MirrorWrite> {
  const result: MirrorWrite = { written: { "storage-proofs": 0, "light-client-proofs": 0, evidence: 0, "handoff-updates": 0, conflicts: 0 }, identical: 0, conflicts: [] };
  for (const [table, kind] of TABLES) {
    for await (const page of archive.pages(table)) {
      for (const row of page) {
        const file = mirrorFile(kind, row as Record<string, unknown>);
        const outcome = await writeOnce(mirror, file.path, file.text);
        if (outcome === "written") result.written[kind] += 1;
        else if (outcome === "identical") result.identical += 1;
        else result.conflicts.push(file.path);
      }
    }
  }
  return result;
}

async function filesIfAny(root: string): Promise<string[]> {
  try {
    return await listFiles(root);
  } catch {
    return [];
  }
}

/** The record files of one directory, in path order, with the stem (the path without `.<sha>.json`). */
export async function* mirrorEntries(mirror: string, kind: string): AsyncGenerator<{ readonly stem: string; readonly value: unknown }> {
  for (const name of await filesIfAny(join(mirror, kind))) {
    const match = RECORD_FILE.exec(name);
    if (match === null) continue;
    const bytes = await readFile(join(mirror, kind, name));
    let value: unknown;
    if (sha256(bytes) === match[2]) {
      try {
        value = JSON.parse(bytes.toString("utf8")) as unknown;
      } catch {
        value = undefined;
      }
    }
    yield { stem: match[1] as string, value };
  }
}

/** The records of one directory. A file whose content does not match its name, or is not JSON, reads as `undefined`. */
export async function* mirrorRecords(mirror: string, kind: string): AsyncGenerator<unknown> {
  for await (const entry of mirrorEntries(mirror, kind)) yield entry.value;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * The versions of one record (same stem, so same key) as one: a field that one version leaves null takes the value of
 * another. Used for the public tree, where each record is one file. Versions sort next to each other, since they share
 * the whole stem.
 */
export async function* mergedMirrorRecords(mirror: string, kind: string): AsyncGenerator<unknown> {
  let held: { stem: string; value: unknown } | null = null;
  for await (const entry of mirrorEntries(mirror, kind)) {
    if (held !== null && entry.stem === held.stem) {
      const [first, second] = [held.value, entry.value];
      held.value = isRecord(first) && isRecord(second) ? { ...first, ...Object.fromEntries(Object.entries(second).filter(([key, value]) => value !== null && first[key] === null)) } : first;
      continue;
    }
    if (held !== null) yield held.value;
    held = { ...entry };
  }
  if (held !== null) yield held.value;
}

/** Upserts every record file of the mirror; the same rules as an import of a bundle. */
export function importMirror(archive: ProofArchive, mirror: string): Promise<Record<"storage_proofs" | "light_client_proofs" | "message_evidence" | "handoff_updates", IngestTally>> {
  return importRecords(archive, {
    storage: mirrorRecords(mirror, "storage-proofs"),
    lightClient: mirrorRecords(mirror, "light-client-proofs"),
    evidence: mirrorRecords(mirror, "evidence"),
    handoffs: mirrorRecords(mirror, "handoff-updates"),
  });
}

/** What {@link addToMirror} did. */
export type MirrorAdd = { added: number; identical: number; skipped: number; readonly conflicts: string[] };

/**
 * Copies the files of `from` into `<mirror>/<to>` once each: beacon states (`<chain id>/<slot>-<root>.ssz|.summary`) or
 * snapshots (`<stamp>.sqlite`). Other names and links are skipped. A file that exists with other content is a conflict.
 */
export async function addToMirror(mirror: string, from: string, to: string): Promise<MirrorAdd> {
  const names = to === "beacon-states" ? BEACON_FILE : to === "snapshots" ? SNAPSHOT_FILE : null;
  if (names === null) throw new Error(`cannot add files to ${to}`);
  const result: MirrorAdd = { added: 0, identical: 0, skipped: 0, conflicts: [] };
  for (const name of await filesIfAny(from)) {
    if (!names.test(name)) {
      result.skipped += 1;
      continue;
    }
    const outcome = await writeOnce(mirror, `${to}/${name}`, await readFile(join(from, name)));
    if (outcome === "written") result.added += 1;
    else if (outcome === "identical") result.identical += 1;
    else result.conflicts.push(`${to}/${name}`);
  }
  return result;
}

/**
 * The time of a beacon state's slot: the genesis time that the state carries (an SSZ BeaconState starts with
 * genesis_time, then genesis_validators_root, then slot) plus the slot times the chain's slot length. Null when the file
 * is too short or holds another slot than its name.
 */
export async function stateTime(path: string, chainId: number, slot: number): Promise<number | null> {
  const file = await open(path, "r");
  try {
    const head = Buffer.alloc(48);
    const { bytesRead } = await file.read(head, 0, 48, 0);
    if (bytesRead < 48 || head.readBigUInt64LE(40) !== BigInt(slot)) return null;
    return Number(head.readBigUInt64LE(0)) + slot * secondsPerSlot(chainId);
  } finally {
    await file.close();
  }
}

const stampTime = (stamp: string): number | null => {
  const match = STAMP.exec(stamp);
  if (match === null) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number) as number[];
  return Date.UTC(year as number, (month as number) - 1, day, hour, minute, second) / 1000;
};

/** What {@link pruneMirror} did. */
export type MirrorPrune = {
  readonly deleted: { beaconStates: number; snapshots: number; manifests: number; temporary: number };
  readonly kept: { beaconStates: number; snapshots: number; manifests: number };
  /** Files kept because their time is unknown (a state without its own slot, an odd name). */
  readonly undated: string[];
  /** Beacon states that a service holds and the mirror does not, though they are inside the window. */
  readonly heldMissing: string[];
  /** Beacon states that a service holds and the mirror dropped as older than the window. */
  heldExpired: number;
};

/**
 * Deletes the beacon states whose slot is older than `days` (by the slot's time, not the file time), and the snapshots
 * and manifests whose stamp is; records are never touched. Also removes temporary files a crashed write left. With
 * `held`, the beacon state directories of the services: each state they hold must be in the mirror afterwards, unless the
 * window dropped it.
 */
export async function pruneMirror(mirror: string, input: { readonly days: number; readonly now: Date; readonly held: readonly string[] }): Promise<MirrorPrune> {
  if (!(input.days >= 1)) throw new Error("the window must be at least one day");
  const cutoff = input.now.getTime() / 1000 - input.days * 86_400;
  const result: MirrorPrune = {
    deleted: { beaconStates: 0, snapshots: 0, manifests: 0, temporary: 0 },
    kept: { beaconStates: 0, snapshots: 0, manifests: 0 },
    undated: [],
    heldMissing: [],
    heldExpired: 0,
  };
  const all = await filesIfAny(mirror);
  for (const name of all.filter((file) => TEMPORARY_FILE.test(basename(file)))) {
    await rm(join(mirror, name), { force: true });
    result.deleted.temporary += 1;
  }

  const beacon = all.filter((file) => file.startsWith("beacon-states/") && !TEMPORARY_FILE.test(basename(file))).map((file) => file.slice("beacon-states/".length));
  const states = new Set(beacon.filter((name) => name.endsWith(".ssz")));
  const expired = new Set<string>();
  for (const name of beacon) {
    const match = BEACON_FILE.exec(name);
    if (match === null || (match[3] === "summary" && !states.has(name.replace(/\.summary$/, ".ssz")))) {
      result.undated.push(`beacon-states/${name}`);
      continue;
    }
    if (match[3] === "summary") continue;
    const time = await stateTime(join(mirror, "beacon-states", name), Number(match[1]), Number(match[2]));
    if (time === null) {
      result.undated.push(`beacon-states/${name}`);
      result.kept.beaconStates += 1;
    } else if (time < cutoff) {
      const summary = name.replace(/\.ssz$/, ".summary");
      await rm(join(mirror, "beacon-states", name));
      await rm(join(mirror, "beacon-states", summary), { force: true });
      expired.add(name);
      result.deleted.beaconStates += 1;
    } else {
      result.kept.beaconStates += 1;
    }
  }

  for (const [kind, extension] of [
    ["snapshots", ".sqlite"],
    ["manifests", ".json"],
  ] as const) {
    for (const file of all.filter((path) => path.startsWith(`${kind}/`) && !TEMPORARY_FILE.test(basename(path)))) {
      const name = file.slice(kind.length + 1);
      const time = name.endsWith(extension) ? stampTime(name.slice(0, -extension.length)) : null;
      if (time === null) result.undated.push(file);
      else if (time < cutoff) {
        await rm(join(mirror, file));
        result.deleted[kind] += 1;
      } else result.kept[kind] += 1;
    }
  }

  const present = new Set(await filesIfAny(join(mirror, "beacon-states")));
  const missing = new Set<string>();
  for (const directory of input.held) {
    for (const name of await filesIfAny(directory)) {
      if (!BEACON_FILE.test(name) || present.has(name)) continue;
      if (expired.has(name)) result.heldExpired += 1;
      else missing.add(name);
    }
  }
  result.heldMissing.push(...missing);
  return result;
}

/** The manifest of the mirror on one day. */
export interface MirrorManifest {
  readonly formatVersion: 2;
  readonly kind: "mirror";
  readonly createdAt: string;
  readonly commit: string;
  readonly host: string;
  readonly retentionDays: number;
  /** Files per top-level directory. */
  readonly counts: Record<string, number>;
  readonly files: Record<string, { readonly sha256: string; readonly bytes: number }>;
  readonly lastPublished?: string | null;
}

/** Every file of the mirror that a manifest lists: all but the manifests, and no hidden (temporary) file. */
async function listedFiles(mirror: string): Promise<string[]> {
  return (await filesIfAny(mirror)).filter((name) => !name.startsWith("manifests/") && !name.split("/").some((part) => part.startsWith(".")));
}

/** The bytes of a manifest file, as {@link writeMirrorManifest} writes them (and `mirror-manifest --print` prints them). */
export const manifestText = (manifest: MirrorManifest): string => `${JSON.stringify(manifest, null, 2)}\n`;

/** The name rule of the manifests: a UTC stamp and `.json`. Root's script uses the same rule. */
export const MANIFEST_NAME = /^\d{8}T\d{6}Z\.json$/;

/** Writes `manifests/<stamp>.json`: the SHA-256 and size of every file present. */
export async function writeMirrorManifest(
  mirror: string,
  input: { readonly stamp: string; readonly commit: string; readonly now: () => Date; readonly ipfsLog?: string; readonly retentionDays: number },
): Promise<MirrorManifest> {
  if (!STAMP.test(input.stamp)) throw new Error(`${input.stamp} is not a UTC stamp (YYYYMMDDTHHMMSSZ)`);
  const files: Record<string, { sha256: string; bytes: number }> = {};
  const counts: Record<string, number> = {};
  for (const name of await listedFiles(mirror)) {
    const path = join(mirror, name);
    files[name] = { sha256: await sha256OfFile(path), bytes: (await stat(path)).size };
    const top = name.split("/")[0] as string;
    counts[top] = (counts[top] ?? 0) + 1;
  }
  const manifest: MirrorManifest = {
    formatVersion: 2,
    kind: "mirror",
    createdAt: input.now().toISOString(),
    commit: input.commit,
    host: hostname(),
    retentionDays: input.retentionDays,
    counts,
    files,
    ...(input.ipfsLog === undefined ? {} : { lastPublished: await lastPublishedLine(input.ipfsLog) }),
  };
  const outcome = await writeOnce(mirror, `manifests/${input.stamp}.json`, manifestText(manifest));
  if (outcome !== "written") throw new Error(`manifests/${input.stamp}.json exists already`);
  return manifest;
}

/** What a check of the mirror against its newest manifest found. */
export type MirrorCheck = { readonly manifest: string; checked: number; readonly missing: string[]; readonly changed: string[]; readonly unlisted: string[]; readonly misnamed: string[] };

/**
 * Checks the mirror against its newest manifest (or the one named, as root's script picks it): every listed file must be there with its hash. Lists the files the
 * manifest does not (on the operator's machine, records the server no longer has), and record files whose content does
 * not match the hash in their name.
 */
export async function checkMirror(mirror: string, name?: string): Promise<MirrorCheck> {
  if (name !== undefined && !MANIFEST_NAME.test(name)) throw new Error(`${name} is not a manifest name (YYYYMMDDTHHMMSSZ.json)`);
  const newest = name ?? (await filesIfAny(join(mirror, "manifests"))).filter((file) => MANIFEST_NAME.test(file)).at(-1);
  if (newest === undefined) throw new Error("the mirror has no manifest");
  const manifest = JSON.parse(await readFile(join(mirror, "manifests", newest), "utf8")) as MirrorManifest;
  const present = new Set(await listedFiles(mirror));
  const result: MirrorCheck = { manifest: `manifests/${newest}`, checked: 0, missing: [], changed: [], unlisted: [], misnamed: [] };
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (!present.delete(name)) {
      result.missing.push(name);
      continue;
    }
    result.checked += 1;
    if ((await sha256OfFile(join(mirror, name))) !== expected.sha256) result.changed.push(name);
  }
  result.unlisted.push(...present);
  for (const kind of RECORD_DIRECTORIES) {
    for (const name of await filesIfAny(join(mirror, kind))) {
      const match = RECORD_FILE.exec(name);
      if (match !== null && (await sha256OfFile(join(mirror, kind, name))) !== match[2]) result.misnamed.push(`${kind}/${name}`);
    }
  }
  return result;
}

/**
 * Copies the newest `newest` beacon states of each chain (by slot), with their summaries, into `out`, mode 0644, for the
 * service users to take into their own caches (an import onto a fresh server). The services keep 16 by default.
 */
export async function stageNewestStates(mirror: string, out: string, newest: number): Promise<{ staged: number }> {
  const byChain = new Map<string, string[]>();
  for (const name of await filesIfAny(join(mirror, "beacon-states"))) {
    const match = BEACON_FILE.exec(name);
    if (match === null || match[3] !== "ssz") continue;
    byChain.set(match[1] as string, [...(byChain.get(match[1] as string) ?? []), name]);
  }
  let staged = 0;
  for (const names of byChain.values()) {
    for (const name of names.sort().reverse().slice(0, newest)) {
      await writeOnce(out, name, await readFile(join(mirror, "beacon-states", name)));
      const summary = name.replace(/\.ssz$/, ".summary");
      const text = await readFile(join(mirror, "beacon-states", summary)).catch(() => null);
      if (text !== null) await writeOnce(out, summary, text);
      staged += 1;
    }
  }
  return { staged };
}
