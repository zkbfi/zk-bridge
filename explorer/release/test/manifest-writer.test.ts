import { describe, expect, it } from "vitest";
import type { ReleaseEntry, ReleaseManifest } from "../../landing/src/manifest.ts";
import { downloadEntry, writeManifest } from "../src/manifest-writer.ts";

const releases: ReleaseEntry[] = [
  { name: "dapp", version: "1.0.0", commit: "abc1234", cid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", archiveSha256: "a".repeat(64), publishedAt: "2026-10-28T00:00:00Z" },
];

describe("writeManifest", () => {
  it("the sequence only goes up", () => {
    const first = writeManifest({ previous: null, releases, downloads: [] });
    expect(first.sequence).toBe(1);
    const second = writeManifest({ previous: first, releases, downloads: [] });
    expect(second.sequence).toBe(2);
    const later: ReleaseManifest = { ...first, sequence: 41 };
    expect(writeManifest({ previous: later, releases, downloads: [] }).sequence).toBe(42);
  });

  it("names the stable channel after the release version, and copies nothing it was not given", () => {
    const manifest = writeManifest({ previous: null, releases, downloads: [] });
    expect(manifest).toEqual({ schema: 1, sequence: 1, channels: { stable: "1.0.0" }, releases, downloads: [] });
  });

  it("refuses releases that disagree on the version, or no releases", () => {
    const other: ReleaseEntry = { ...releases[0]!, name: "docs", version: "1.0.1" };
    expect(() => writeManifest({ previous: null, releases: [...releases, other], downloads: [] })).toThrow(/one version/);
    expect(() => writeManifest({ previous: null, releases: [], downloads: [] })).toThrow(/one version/);
  });
});

describe("downloadEntry", () => {
  it("reads the platform from the file name", () => {
    expect(downloadEntry("zk-bridge-terminal-darwin-arm64", "1".repeat(64))).toEqual({
      name: "zk-bridge-terminal",
      platform: "darwin-arm64",
      file: "zk-bridge-terminal-darwin-arm64",
      sha256: "1".repeat(64),
    });
    expect(downloadEntry("zk-bridge-terminal-windows-x64.exe", "2".repeat(64))).toMatchObject({
      name: "zk-bridge-terminal",
      platform: "windows-x64",
    });
  });

  it("marks a file with no platform, such as a guest program, as any", () => {
    expect(downloadEntry("light-client.elf", "3".repeat(64))).toMatchObject({ name: "light-client.elf", platform: "any" });
  });
});
