import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalManifestBytes, type ReleaseManifest } from "../../landing/src/manifest.ts";
import { bootstrapLog, readHistory, type HistoryItem } from "../src/bootstrap-log.ts";
import { appendRelease, logProblems, type ReleaseLog } from "../src/release-log.ts";
import { signManifest } from "../src/sign.ts";
import { commitRelease, git, manifestOf, temporaryDirectory, throwawayKey } from "./helpers.ts";

async function item(manifest: ReleaseManifest, privateKey: JsonWebKey | null, commit: string): Promise<HistoryItem> {
  return {
    commit,
    manifestBytes: canonicalManifestBytes(manifest),
    signature: privateKey === null ? null : await signManifest({ manifest, privateKey }),
  };
}

function expected(...sequences: number[]): ReleaseLog {
  let log: ReleaseLog = { schema: 1, channel: "next", entries: [] };
  for (const sequence of sequences) log = appendRelease(log, manifestOf(sequence));
  return log;
}

describe("readHistory and bootstrapLog on a fixture release repository", () => {
  it("logs every signed version.json in sequence order, and names what it skipped and the gaps", async () => {
    const { privateKey, publicKey } = await throwawayKey();
    const stranger = await throwawayKey();
    const repository = await temporaryDirectory();
    git(repository, "init", "--quiet", "--initial-branch", "next");
    await writeFile(join(repository, "README.md"), "releases\n");
    git(repository, "add", "-A");
    git(repository, "commit", "--quiet", "-m", "Initial commit");

    await commitRelease(repository, manifestOf(1), privateKey);
    await commitRelease(repository, manifestOf(2), privateKey);
    await commitRelease(repository, manifestOf(3), stranger.privateKey); // signed by a key the channel does not trust
    await commitRelease(repository, manifestOf(4, "stable"), privateKey); // another channel's release
    await commitRelease(repository, manifestOf(5), null); // no signature
    await writeFile(join(repository, "SHA256SUMS"), "only the sums changed\n"); // not a version.json change
    git(repository, "add", "-A");
    git(repository, "commit", "--quiet", "-m", "sums");
    git(repository, "rm", "--quiet", "version.json");
    git(repository, "commit", "--quiet", "-m", "removed by mistake");
    await commitRelease(repository, manifestOf(7), privateKey);

    const history = readHistory(repository, "next");
    expect(history.map((entry) => entry.commit)).toHaveLength(6);
    const result = await bootstrapLog(history, "next", [publicKey]);
    expect(result.log).toEqual(expected(1, 2, 7));
    expect(logProblems(result.log)).toEqual([]);
    expect(result.included.map(({ sequence, version }) => [sequence, version])).toEqual([
      [1, "0.1.1"],
      [2, "0.1.2"],
      [7, "0.1.7"],
    ]);
    expect(result.included[0]!.commit).toMatch(/^[0-9a-f]{12}$/);
    expect(result.skipped.map((entry) => entry.reason)).toEqual([
      "the signature matches no trusted key",
      "on the channel stable, not next",
      "no version.json.sig",
    ]);
    expect(result.gaps).toEqual([3, 4, 5, 6]);
  });

  it("fails when git cannot read the branch", async () => {
    const repository = await temporaryDirectory();
    git(repository, "init", "--quiet");
    expect(() => readHistory(repository, "no-such-branch")).toThrow();
  });
});

describe("bootstrapLog", () => {
  it("leaves out the same bytes pushed twice silently, and names another release under a taken sequence", async () => {
    const { privateKey, publicKey } = await throwawayKey();
    const imposter = { ...manifestOf(2), channels: { next: "0.1.2-other" } };
    imposter.releases = imposter.releases.map((release) => ({ ...release, version: "0.1.2-other" }));
    const history = [
      await item(manifestOf(2), privateKey, "b".repeat(40)),
      await item(manifestOf(1), privateKey, "a".repeat(40)),
      await item(manifestOf(2), privateKey, "c".repeat(40)),
      await item(imposter, privateKey, "d".repeat(40)),
    ];
    const result = await bootstrapLog(history, "next", [publicKey]);
    expect(result.log).toEqual(expected(1, 2));
    expect(result.included.map((entry) => entry.commit)).toEqual(["a".repeat(12), "b".repeat(12)]);
    expect(result.skipped).toEqual([{ commit: "d".repeat(12), reason: "sequence 2 is already taken by bbbbbbbbbbbb" }]);
    expect(result.gaps).toEqual([]);
  });

  it("skips a signed text that is not a manifest, and gives an empty log for an empty history", async () => {
    const { privateKey, publicKey } = await throwawayKey();
    const { signBytes } = await import("../src/sign.ts");
    const bytes = new TextEncoder().encode("not json");
    const history: HistoryItem[] = [{ commit: "e".repeat(40), manifestBytes: bytes, signature: await signBytes({ bytes, privateKey }) }];
    const result = await bootstrapLog(history, "next", [publicKey]);
    expect(result.skipped).toEqual([{ commit: "e".repeat(12), reason: "the manifest is not valid JSON" }]);
    expect(result.log.entries).toEqual([]);
    expect(result.gaps).toEqual([]);
    expect((await bootstrapLog([], "stable", [publicKey])).log).toEqual({ schema: 1, channel: "stable", entries: [] });
  });
});
