/** Checks a release directory end to end before anything is published. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalManifestBytes, parseManifest, verifyManifestSignature, type ReleaseManifest } from "../../landing/src/manifest.ts";
import { readArchive } from "./car.ts";
import { parseSha256Sums, sha256Bytes } from "./checksums.ts";
import { siteLoadProblems } from "./site.ts";

/** Where each part of a release lives, relative to the release directory. */
export const RELEASE_LAYOUT = {
  manifest: "version.json",
  signature: "version.json.sig",
  publicKeys: "public-keys.json",
  sums: "SHA256SUMS",
  archives: "archives",
  downloads: "downloads",
} as const;

/** The three sites every release carries. */
export const SITE_NAMES = ["dapp", "docs", "landing"] as const;

async function readOrNull(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    return null;
  }
}

function errorText(error: unknown): string {
  return (error as Error).message;
}

async function archiveProblems(directory: string, manifest: ReleaseManifest): Promise<string[]> {
  const problems: string[] = [];
  for (const name of SITE_NAMES) {
    if (!manifest.releases.some((entry) => entry.name === name)) problems.push(`version.json: the release ${name} is missing`);
  }
  for (const entry of manifest.releases) {
    const file = `${RELEASE_LAYOUT.archives}/${entry.name}.car`;
    const bytes = await readOrNull(join(directory, file));
    if (bytes === null) {
      problems.push(`${file}: missing`);
      continue;
    }
    if (sha256Bytes(bytes) !== entry.archiveSha256) problems.push(`${file}: the SHA-256 differs from version.json`);
    try {
      const archive = await readArchive(bytes);
      if (archive.root.toString() !== entry.cid) {
        problems.push(`${file}: the root is ${archive.root}, version.json says ${entry.cid}`);
      }
      for (const problem of await siteLoadProblems(bytes)) {
        problems.push(`${file}: the site does not load under /ipfs/<cid>/: ${problem}`);
      }
    } catch (error) {
      problems.push(`${file}: the archive is damaged: ${errorText(error)}`);
    }
  }
  return problems;
}

async function downloadProblems(directory: string, manifest: ReleaseManifest): Promise<string[]> {
  const problems: string[] = [];
  for (const entry of manifest.downloads) {
    const file = `${RELEASE_LAYOUT.downloads}/${entry.file}`;
    const bytes = await readOrNull(join(directory, file));
    if (bytes === null) problems.push(`${file}: missing`);
    else if (sha256Bytes(bytes) !== entry.sha256) problems.push(`${file}: the SHA-256 differs from version.json`);
  }
  return problems;
}

async function sumsProblems(directory: string, manifest: ReleaseManifest): Promise<string[]> {
  const text = await readOrNull(join(directory, RELEASE_LAYOUT.sums));
  if (text === null) return [`${RELEASE_LAYOUT.sums}: missing`];
  let sums: Map<string, string>;
  try {
    sums = parseSha256Sums(Buffer.from(text).toString("utf8"));
  } catch (error) {
    return [`${RELEASE_LAYOUT.sums}: ${errorText(error)}`];
  }
  const problems: string[] = [];
  for (const [file, hash] of sums) {
    const bytes = await readOrNull(join(directory, file));
    if (bytes === null || sha256Bytes(bytes) !== hash) problems.push(`${RELEASE_LAYOUT.sums}: ${file} does not match`);
  }
  const expected = [
    ...manifest.releases.map((entry) => `${RELEASE_LAYOUT.archives}/${entry.name}.car`),
    ...manifest.downloads.map((entry) => `${RELEASE_LAYOUT.downloads}/${entry.file}`),
  ];
  for (const file of expected) {
    if (!sums.has(file)) problems.push(`${RELEASE_LAYOUT.sums}: ${file} is not listed`);
  }
  return problems;
}

/**
 * Checks a release directory: the signature of `version.json` against the given keys, its canonical form, all three
 * sites, each archive (hash, content addresses, root, loading under `/ipfs/<cid>/`), each download, and `SHA256SUMS`.
 * @returns ok, or every problem found, one line each.
 */
export async function verifyRelease(
  directory: string,
  publicKeys: readonly JsonWebKey[],
): Promise<{ ok: true } | { ok: false; problems: string[] }> {
  const problems: string[] = [];
  if (publicKeys.length === 0) problems.push("no release public key was given");
  const manifestBytes = await readOrNull(join(directory, RELEASE_LAYOUT.manifest));
  const signature = await readOrNull(join(directory, RELEASE_LAYOUT.signature));
  if (manifestBytes === null) problems.push(`${RELEASE_LAYOUT.manifest}: missing`);
  if (signature === null) problems.push(`${RELEASE_LAYOUT.signature}: missing`);
  if (manifestBytes === null) return { ok: false, problems };
  if (signature !== null && publicKeys.length > 0) {
    if (!(await verifyManifestSignature({ manifestBytes, signature, publicKeys }))) {
      problems.push(`${RELEASE_LAYOUT.signature}: the signature does not match any listed release key`);
    }
  }
  let manifest: ReleaseManifest;
  try {
    manifest = parseManifest(Buffer.from(manifestBytes).toString("utf8"));
  } catch (error) {
    problems.push(`${RELEASE_LAYOUT.manifest}: ${errorText(error)}`);
    return { ok: false, problems };
  }
  if (Buffer.compare(Buffer.from(canonicalManifestBytes(manifest)), Buffer.from(manifestBytes)) !== 0) {
    problems.push(`${RELEASE_LAYOUT.manifest}: not written in canonical form`);
  }
  problems.push(...(await archiveProblems(directory, manifest)));
  problems.push(...(await downloadProblems(directory, manifest)));
  problems.push(...(await sumsProblems(directory, manifest)));
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}
