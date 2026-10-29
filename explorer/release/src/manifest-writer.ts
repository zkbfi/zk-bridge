/** Builds the next `version.json` from the previous one. */
import type { DownloadEntry, ReleaseEntry, ReleaseManifest } from "../../landing/src/manifest.ts";

/**
 * The next manifest: sequence = previous + 1, or 1 for the first release.
 * The landing page refuses a sequence lower than one it has seen, so the sequence only goes up.
 * The stable channel names the release version.
 * @throws Error when there is no release or the releases disagree on the version.
 */
export function writeManifest(input: {
  previous: ReleaseManifest | null;
  releases: ReleaseEntry[];
  downloads: DownloadEntry[];
}): ReleaseManifest {
  const versions = new Set(input.releases.map((entry) => entry.version));
  if (versions.size !== 1) throw new Error("a release must name exactly one version");
  return {
    schema: 1,
    sequence: (input.previous?.sequence ?? 0) + 1,
    channels: { stable: [...versions][0]! },
    releases: input.releases,
    downloads: input.downloads,
  };
}

const PLATFORM_SUFFIX = /^(.+)-((?:darwin|linux|windows)-(?:arm64|x64))(?:\.exe)?$/;

/** The download entry of a file: the platform comes from a `-<os>-<arch>` suffix, else `any` (a guest program). */
export function downloadEntry(file: string, sha256: string): DownloadEntry {
  const match = PLATFORM_SUFFIX.exec(file);
  if (!match) return { name: file, platform: "any", file, sha256 };
  return { name: match[1]!, platform: match[2]!, file, sha256 };
}
