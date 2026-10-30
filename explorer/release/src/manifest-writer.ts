/** Builds the next `version.json` from the previous one. */
import type { DownloadEntry, ReleaseEntry, ReleaseManifest } from "../../landing/src/manifest.ts";

/** A channel name: stable, next, or another lower-case word. */
const CHANNEL_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * The next manifest: sequence = previous + 1, or 1 for the first release.
 * The landing page refuses a sequence lower than one it has seen, so the sequence only goes up.
 * The channel (stable unless another is given, such as next for staging) names the release version.
 * @throws Error when there is no release, the releases disagree on the version, or the channel is not a plain name.
 */
export function writeManifest(input: {
  previous: ReleaseManifest | null;
  releases: ReleaseEntry[];
  downloads: DownloadEntry[];
  channel?: string;
}): ReleaseManifest {
  const channel = input.channel ?? "stable";
  if (!CHANNEL_NAME.test(channel)) throw new Error(`the channel "${channel}" is not a plain lower-case name`);
  const versions = new Set(input.releases.map((entry) => entry.version));
  if (versions.size !== 1) throw new Error("a release must name exactly one version");
  return {
    schema: 1,
    sequence: (input.previous?.sequence ?? 0) + 1,
    channels: { [channel]: [...versions][0]! },
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
