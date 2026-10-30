/**
 * Promotes a staging release (the next channel, signed with the staging key) to a production release directory.
 *
 * The dapp and the docs are not rebuilt: their archives are copied, so their content addresses stay exactly what was
 * tried on next.zkb.fi. Only the landing page differs, because it embeds the keys it trusts (the production landing
 * trusts the production key only), so the caller passes a landing archive built with the production configuration.
 * The result is unsigned: sign it with the production key, then verify it, as release.sh does.
 */
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalManifestBytes, parseManifest, type ReleaseEntry, type ReleaseManifest } from "../../landing/src/manifest.ts";
import { readArchive } from "./car.ts";
import { formatSha256Sums, sha256Bytes, type ChecksumEntry } from "./checksums.ts";
import { writeManifest } from "./manifest-writer.ts";
import { RELEASE_LAYOUT } from "./verify.ts";

/** The sites whose archives a promotion copies unchanged. */
const KEPT_SITES = ["dapp", "docs"] as const;

async function isEmptyOrMissing(directory: string): Promise<boolean> {
  try {
    return (await readdir(directory)).length === 0;
  } catch {
    return true;
  }
}

/**
 * Checks the staging release, then writes the production version.json, SHA256SUMS and archives into `out`.
 * Nothing is written unless every check passes.
 * @throws Error when the staging release is not on the next channel, a kept archive differs from the staging
 *   manifest, a download is missing or changed, or `out` is not empty.
 */
export async function promoteRelease(input: {
  staging: string;
  out: string;
  landingArchive: string;
  version: string;
  publishedAt: string;
  previous: ReleaseManifest | null;
}): Promise<ReleaseManifest> {
  const staging = parseManifest(await readFile(join(input.staging, RELEASE_LAYOUT.manifest), "utf8"));
  if (Object.keys(staging.channels).join() !== "next") {
    throw new Error("the staging release is not on the next channel: only a next release can be promoted");
  }
  if (!(await isEmptyOrMissing(input.out))) throw new Error(`${input.out} is not empty: a promotion starts from an empty directory`);

  const kept: { entry: ReleaseEntry; bytes: Uint8Array }[] = [];
  for (const name of KEPT_SITES) {
    const entry = staging.releases.find((release) => release.name === name);
    if (entry === undefined) throw new Error(`the staging release has no ${name}`);
    const bytes = new Uint8Array(await readFile(join(input.staging, RELEASE_LAYOUT.archives, `${name}.car`)));
    const { root } = await readArchive(bytes);
    if (sha256Bytes(bytes) !== entry.archiveSha256 || root.toString() !== entry.cid) {
      throw new Error(`${name}: the archive differs from what the staging manifest names (${entry.cid}); nothing is promoted`);
    }
    kept.push({ entry, bytes });
  }
  const downloads = [];
  for (const download of staging.downloads) {
    const bytes = new Uint8Array(await readFile(join(input.staging, RELEASE_LAYOUT.downloads, download.file)));
    if (sha256Bytes(bytes) !== download.sha256) throw new Error(`${download.file}: the download differs from the staging manifest`);
    downloads.push(download);
  }
  const landingBytes = new Uint8Array(await readFile(input.landingArchive));
  const landingRoot = (await readArchive(landingBytes)).root.toString();

  const commit = kept[0]!.entry.commit;
  const releases: ReleaseEntry[] = [
    ...kept.map(({ entry }) => ({ ...entry, version: input.version, publishedAt: input.publishedAt })),
    { name: "landing", version: input.version, commit, cid: landingRoot, archiveSha256: sha256Bytes(landingBytes), publishedAt: input.publishedAt },
  ];
  const manifest = writeManifest({ previous: input.previous, releases, downloads, channel: "stable" });

  await mkdir(join(input.out, RELEASE_LAYOUT.archives), { recursive: true });
  const sums: ChecksumEntry[] = [];
  for (const { entry, bytes } of kept) {
    await writeFile(join(input.out, RELEASE_LAYOUT.archives, `${entry.name}.car`), bytes);
    sums.push({ file: `${RELEASE_LAYOUT.archives}/${entry.name}.car`, sha256: entry.archiveSha256 });
  }
  await writeFile(join(input.out, RELEASE_LAYOUT.archives, "landing.car"), landingBytes);
  sums.push({ file: `${RELEASE_LAYOUT.archives}/landing.car`, sha256: sha256Bytes(landingBytes) });
  if (downloads.length > 0) await mkdir(join(input.out, RELEASE_LAYOUT.downloads), { recursive: true });
  for (const download of downloads) {
    await copyFile(join(input.staging, RELEASE_LAYOUT.downloads, download.file), join(input.out, RELEASE_LAYOUT.downloads, download.file));
    sums.push({ file: `${RELEASE_LAYOUT.downloads}/${download.file}`, sha256: download.sha256 });
  }
  await writeFile(join(input.out, RELEASE_LAYOUT.manifest), canonicalManifestBytes(manifest));
  await writeFile(join(input.out, RELEASE_LAYOUT.sums), formatSha256Sums(sums));
  return manifest;
}
