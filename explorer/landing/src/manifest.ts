/** Release manifest format, shared by the landing page and the release pipeline. */

/** One released site. */
export type ReleaseEntry = {
  name: "dapp" | "docs" | "landing";
  version: string;
  commit: string;
  cid: string;
  archiveSha256: string;
  publishedAt: string;
};

/** One downloadable terminal or prover program. */
export type DownloadEntry = {
  name: string;
  platform: string;
  file: string;
  sha256: string;
  /** The size in bytes, when the signed list states it. */
  size?: number;
};

/** The signed `version.json` document. */
export type ReleaseManifest = {
  schema: 1;
  sequence: number;
  channels: Record<string, string>;
  releases: ReleaseEntry[];
  downloads: DownloadEntry[];
};

/** Thrown when manifest text does not match the format. */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

// "docs" is no longer released (the docs are inside the dapp) but stays readable: lists signed earlier name it.
const RELEASE_NAMES = ["dapp", "docs", "landing"] as const;
const HEX_64 = /^[0-9a-f]{64}$/;
const CONTENT_ADDRESS = /^[A-Za-z0-9]{10,200}$/;

function fail(message: string): never {
  throw new ManifestError(message);
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function asText(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${where} must be a non-empty string`);
  return value;
}

function asMatching(value: unknown, pattern: RegExp, where: string): string {
  const text = asText(value, where);
  if (!pattern.test(text)) fail(`${where} has the wrong form`);
  return text;
}

function asArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) fail(`${where} must be a list`);
  return value;
}

function parseRelease(value: unknown, index: number): ReleaseEntry {
  const where = `releases[${index}]`;
  const record = asRecord(value, where);
  const name = record.name;
  if (!RELEASE_NAMES.includes(name as ReleaseEntry["name"])) fail(`${where}.name is not a known release`);
  return {
    name: name as ReleaseEntry["name"],
    version: asText(record.version, `${where}.version`),
    commit: asText(record.commit, `${where}.commit`),
    cid: asMatching(record.cid, CONTENT_ADDRESS, `${where}.cid`),
    archiveSha256: asMatching(record.archiveSha256, HEX_64, `${where}.archiveSha256`),
    publishedAt: asText(record.publishedAt, `${where}.publishedAt`),
  };
}

function parseDownload(value: unknown, index: number): DownloadEntry {
  const where = `downloads[${index}]`;
  const record = asRecord(value, where);
  const size = record.size;
  if (size !== undefined && (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0)) {
    fail(`${where}.size must be a whole number of bytes`);
  }
  return {
    name: asText(record.name, `${where}.name`),
    platform: asText(record.platform, `${where}.platform`),
    file: asText(record.file, `${where}.file`),
    sha256: asMatching(record.sha256, HEX_64, `${where}.sha256`),
    ...(size === undefined ? {} : { size }),
  };
}

function parseChannels(value: unknown): Record<string, string> {
  const record = asRecord(value, "channels");
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, asText(entry, `channels.${key}`)]));
}

/**
 * Reads manifest text and checks its shape.
 * @throws ManifestError when the text is not JSON or does not match the format.
 */
export function parseManifest(text: string): ReleaseManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail("the manifest is not valid JSON");
  }
  const record = asRecord(raw, "manifest");
  if (record.schema !== 1) fail("the manifest schema is not supported");
  const sequence = record.sequence;
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0) {
    fail("sequence must be a whole number, zero or more");
  }
  return {
    schema: 1,
    sequence,
    channels: parseChannels(record.channels),
    releases: asArray(record.releases, "releases").map(parseRelease),
    downloads: asArray(record.downloads, "downloads").map(parseDownload),
  };
}

/** Object keys are unique, so two keys are never equal. */
function compareKeys(a: string, b: string): number {
  return a < b ? -1 : 1;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => compareKeys(a, b));
  return Object.fromEntries(entries.map(([key, entry]) => [key, sortKeys(entry)]));
}

/**
 * The exact bytes the release key signs: keys sorted, no spaces, UTF-8.
 * The release pipeline must write `version.json` as these bytes. The page checks the signature over the
 * bytes it fetched, so any other layout fails the check.
 */
export function canonicalManifestBytes(manifest: ReleaseManifest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(sortKeys(manifest)));
}

async function verifyWithKey(manifestBytes: Uint8Array, signature: Uint8Array, jwk: JsonWebKey): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, signature as BufferSource, manifestBytes as BufferSource);
  } catch {
    return false;
  }
}

/**
 * Checks an Ed25519 signature with the browser's WebCrypto.
 * @returns true when any listed key verifies; false for a bad signature or a key that cannot load.
 */
export async function verifyManifestSignature(input: {
  manifestBytes: Uint8Array;
  signature: Uint8Array;
  publicKeys: readonly JsonWebKey[];
}): Promise<boolean> {
  const results = await Promise.all(
    input.publicKeys.map((jwk) => verifyWithKey(input.manifestBytes, input.signature, jwk)),
  );
  return results.includes(true);
}
