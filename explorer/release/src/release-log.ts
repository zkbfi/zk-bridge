/**
 * The release log: `releases-log.json`, a signed, append-only list of every site ever published on one channel.
 *
 * `version.json` names only the current release. The log keeps every one, with its content address, so any release
 * can always be found and pinned again. It lives next to `version.json` in the release repository (branch main for
 * stable, next for next) and is signed by the same key with the same code: `releases-log.json.sig` is the 64-byte
 * Ed25519 signature of the exact file bytes (keys sorted, no spaces).
 *
 * One entry per published site. Entries are only ever appended. Each entry carries `previous`, the SHA-256 of the
 * canonical bytes of the entry before it (null for the first), so a rewritten history no longer chains to a copy kept
 * earlier, even by someone who never checks a signature. Entries of one release share its sequence; the sequence goes
 * up from one release to the next.
 */
import { createHash } from "node:crypto";
import { canonicalManifestBytes, verifyManifestSignature, type ReleaseEntry, type ReleaseManifest } from "../../landing/src/manifest.ts";

/** One published site. */
export type LogEntry = {
  channel: string;
  version: string;
  sequence: number;
  name: ReleaseEntry["name"];
  cid: string;
  archiveSha256: string;
  commit: string;
  publishedAt: string;
  /** SHA-256 (hex) of the canonical bytes of the entry before this one; null for the first entry. */
  previous: string | null;
};

/** The signed `releases-log.json` document. */
export type ReleaseLog = {
  schema: 1;
  channel: string;
  entries: LogEntry[];
};

/** Where the log lives, in a release directory and in the release repository. */
export const LOG_LAYOUT = { log: "releases-log.json", signature: "releases-log.json.sig" } as const;

/** Thrown when log text does not have the format, or a log breaks a rule. */
export class LogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LogError";
  }
}

const NAMES = ["dapp", "docs", "landing"] as const;
const HEX_64 = /^[0-9a-f]{64}$/;
const CONTENT_ADDRESS = /^[A-Za-z0-9]{10,200}$/;
const CHANNEL = /^[a-z][a-z0-9-]{0,31}$/;

function fail(message: string): never {
  throw new LogError(message);
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, where: string, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length === 0) fail(`${where} must be a non-empty string`);
  if (pattern !== undefined && !pattern.test(value)) fail(`${where} has the wrong form`);
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], where: string): void {
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (extra.length > 0) fail(`${where} has unknown fields: ${extra.join(", ")}`);
}

const ENTRY_KEYS = ["channel", "version", "sequence", "name", "cid", "archiveSha256", "commit", "publishedAt", "previous"] as const;

function parseEntry(value: unknown, index: number): LogEntry {
  const where = `entries[${index}]`;
  const raw = record(value, where);
  exactKeys(raw, ENTRY_KEYS, where);
  const sequence = raw.sequence;
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0) fail(`${where}.sequence must be a whole number`);
  if (!NAMES.includes(raw.name as LogEntry["name"])) fail(`${where}.name is not a known site`);
  const previous = raw.previous === null ? null : text(raw.previous, `${where}.previous`, HEX_64);
  return {
    channel: text(raw.channel, `${where}.channel`, CHANNEL),
    version: text(raw.version, `${where}.version`),
    sequence,
    name: raw.name as LogEntry["name"],
    cid: text(raw.cid, `${where}.cid`, CONTENT_ADDRESS),
    archiveSha256: text(raw.archiveSha256, `${where}.archiveSha256`, HEX_64),
    commit: text(raw.commit, `${where}.commit`),
    publishedAt: text(raw.publishedAt, `${where}.publishedAt`),
    previous,
  };
}

/**
 * Reads log text and checks its shape (not its rules: see logProblems).
 * @throws LogError when the text is not JSON or not the format.
 */
export function parseLog(source: string): ReleaseLog {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return fail("the release log is not valid JSON");
  }
  const document = record(raw, "the release log");
  exactKeys(document, ["schema", "channel", "entries"], "the release log");
  if (document.schema !== 1) fail("the release log schema is not supported");
  if (!Array.isArray(document.entries)) fail("entries must be a list");
  return { schema: 1, channel: text(document.channel, "channel", CHANNEL), entries: document.entries.map(parseEntry) };
}

/** The exact bytes the key signs and the file holds: keys sorted, no spaces, UTF-8 (the same rule as version.json). */
export function canonicalLogBytes(log: ReleaseLog): Uint8Array {
  return canonicalManifestBytes(log as unknown as ReleaseManifest);
}

/** The SHA-256 (hex) of the canonical bytes of one entry: what the next entry names as `previous`. */
export function entryHash(entry: LogEntry): string {
  return createHash("sha256").update(canonicalManifestBytes(entry as unknown as ReleaseManifest)).digest("hex");
}

/**
 * Every broken rule of a log, one line each: each entry on the log's channel, each `previous` the hash of the entry
 * before (null only for the first), sequences that never go down and go up from one release to the next (a release's
 * entries are adjacent, share one version, and name each site once).
 */
export function logProblems(log: ReleaseLog): string[] {
  const problems: string[] = [];
  log.entries.forEach((entry, index) => {
    const where = `entries[${index}]`;
    if (entry.channel !== log.channel) problems.push(`${where}: the channel is ${entry.channel}, the log is ${log.channel}`);
    const before = index === 0 ? undefined : log.entries[index - 1]!;
    const expected = before === undefined ? null : entryHash(before);
    if (entry.previous !== expected) problems.push(`${where}: previous does not chain to the entry before it`);
    if (before === undefined) return;
    if (entry.sequence < before.sequence) problems.push(`${where}: sequence ${entry.sequence} goes down from ${before.sequence}`);
    if (entry.sequence === before.sequence) {
      if (entry.version !== before.version) problems.push(`${where}: sequence ${entry.sequence} names two versions`);
      const group = log.entries.slice(0, index).filter((other) => other.sequence === entry.sequence);
      if (group.some((other) => other.name === entry.name)) problems.push(`${where}: sequence ${entry.sequence} names ${entry.name} twice`);
    }
  });
  return problems;
}

/** The channel a manifest names (exactly one). */
export function manifestChannel(manifest: ReleaseManifest): string {
  const names = Object.keys(manifest.channels);
  if (names.length !== 1) fail("version.json must name exactly one channel");
  return names[0]!;
}

/**
 * Appends the sites of `manifest` to `previous` (or starts a log with them), chaining each to the entry before.
 * @throws LogError when the previous log breaks a rule, is on another channel, or already reaches this sequence.
 */
export function appendRelease(previous: ReleaseLog | null, manifest: ReleaseManifest): ReleaseLog {
  const channel = manifestChannel(manifest);
  const log: ReleaseLog = previous ?? { schema: 1, channel, entries: [] };
  const problems = logProblems(log);
  if (problems.length > 0) fail(`the previous release log is broken: ${problems.join("; ")}`);
  if (log.channel !== channel) fail(`the previous release log is on ${log.channel}, the release on ${channel}`);
  const last = log.entries.at(-1);
  if (last !== undefined && manifest.sequence <= last.sequence) {
    fail(`the release has sequence ${manifest.sequence}, but the log already reaches ${last.sequence}: set the previous version.json`);
  }
  const entries = [...log.entries];
  for (const release of manifest.releases) {
    const before = entries.at(-1);
    entries.push({
      channel,
      version: release.version,
      sequence: manifest.sequence,
      name: release.name,
      cid: release.cid,
      archiveSha256: release.archiveSha256,
      commit: release.commit,
      publishedAt: release.publishedAt,
      previous: before === undefined ? null : entryHash(before),
    });
  }
  const next: ReleaseLog = { schema: 1, channel, entries };
  const after = logProblems(next);
  if (after.length > 0) fail(`the release cannot be logged: ${after.join("; ")}`);
  return next;
}

/**
 * Why `next` is not `previous` with entries appended, one line each: the same channel, every earlier entry kept byte
 * for byte in its place, at least one new entry, the first new sequence above the last old one, and no broken rule.
 */
export function extensionProblems(previous: ReleaseLog, next: ReleaseLog): string[] {
  const problems = [...logProblems(previous).map((line) => `the published log: ${line}`), ...logProblems(next).map((line) => `the new log: ${line}`)];
  if (next.channel !== previous.channel) problems.push(`the new log is on ${next.channel}, the published one on ${previous.channel}`);
  if (next.entries.length <= previous.entries.length) {
    problems.push(`the new log has ${next.entries.length} entries, the published one ${previous.entries.length}: it must add at least one`);
  }
  previous.entries.forEach((entry, index) => {
    const kept = next.entries[index];
    if (kept === undefined || entryHash(kept) !== entryHash(entry)) problems.push(`entries[${index}]: the published entry is changed, moved or removed`);
  });
  const last = previous.entries.at(-1);
  const first = next.entries[previous.entries.length];
  if (last !== undefined && first !== undefined && first.sequence <= last.sequence) {
    problems.push(`the first new entry has sequence ${first.sequence}, not above the published ${last.sequence}`);
  }
  return problems;
}

/** Why the last release of the log is not the release `manifest` names, one line each. */
export function manifestProblems(log: ReleaseLog, manifest: ReleaseManifest): string[] {
  const channels = Object.keys(manifest.channels);
  if (channels.length !== 1 || channels[0] !== log.channel) return [`version.json is not on the log's channel ${log.channel}`];
  const tail = log.entries.filter((entry) => entry.sequence === manifest.sequence);
  const last = log.entries.slice(-manifest.releases.length);
  const same = (entry: LogEntry, release: ReleaseEntry) =>
    entry.name === release.name &&
    entry.version === release.version &&
    entry.cid === release.cid &&
    entry.archiveSha256 === release.archiveSha256 &&
    entry.commit === release.commit &&
    entry.publishedAt === release.publishedAt;
  const matches =
    tail.length === manifest.releases.length &&
    last.length === manifest.releases.length &&
    last.every((entry, index) => entry.sequence === manifest.sequence && same(entry, manifest.releases[index]!));
  return matches ? [] : [`the last entries of the log are not the sites of version.json (sequence ${manifest.sequence})`];
}

/** True when any of the keys signed the exact log bytes. */
export async function verifyLogSignature(input: { logBytes: Uint8Array; signature: Uint8Array; publicKeys: readonly JsonWebKey[] }): Promise<boolean> {
  return verifyManifestSignature({ manifestBytes: input.logBytes, signature: input.signature, publicKeys: input.publicKeys });
}

/**
 * Checks signed log bytes: the signature against the trusted keys, the format, the canonical form and every rule.
 * @returns the log, or every problem found.
 */
export async function checkSignedLog(input: {
  logBytes: Uint8Array;
  signature: Uint8Array | null;
  publicKeys: readonly JsonWebKey[];
  where?: string;
}): Promise<{ ok: true; log: ReleaseLog } | { ok: false; problems: string[] }> {
  const where = input.where ?? LOG_LAYOUT.log;
  const problems: string[] = [];
  if (input.publicKeys.length === 0) problems.push("no release public key was given");
  if (input.signature === null) problems.push(`${where}.sig: missing`);
  else if (input.publicKeys.length > 0 && !(await verifyLogSignature({ logBytes: input.logBytes, signature: input.signature, publicKeys: input.publicKeys }))) {
    problems.push(`${where}.sig: the signature does not match any trusted release key`);
  }
  let log: ReleaseLog;
  try {
    log = parseLog(Buffer.from(input.logBytes).toString("utf8"));
  } catch (error) {
    return { ok: false, problems: [...problems, `${where}: ${(error as Error).message}`] };
  }
  if (Buffer.compare(Buffer.from(canonicalLogBytes(log)), Buffer.from(input.logBytes)) !== 0) problems.push(`${where}: not written in canonical form`);
  problems.push(...logProblems(log).map((line) => `${where}: ${line}`));
  return problems.length === 0 ? { ok: true, log } : { ok: false, problems };
}
