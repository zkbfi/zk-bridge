/**
 * Builds the first release log of a channel from the history of the release repository.
 *
 * Every signed `version.json` ever pushed is a commit of the channel's branch (main for stable, next for next). Each one
 * is read with its signature, checked against the trusted keys, and its sites become log entries in sequence order.
 * What the history does not hold is not invented: a missing sequence is reported as a gap and left out.
 */
import { execFileSync } from "node:child_process";
import { parseManifest, verifyManifestSignature, type ReleaseManifest } from "../../landing/src/manifest.ts";
import { appendRelease, manifestChannel, type ReleaseLog } from "./release-log.ts";

/** One commit of the release branch that changed `version.json`. The signature is null when the commit has none. */
export type HistoryItem = { commit: string; manifestBytes: Uint8Array; signature: Uint8Array | null };

function git(directory: string, args: string[]): Buffer {
  return execFileSync("git", ["-C", directory, ...args], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

function show(directory: string, commit: string, file: string): Buffer | null {
  try {
    return git(directory, ["show", `${commit}:${file}`]);
  } catch {
    return null;
  }
}

/**
 * Reads, oldest first, every commit of `branch` (a branch, remote branch or any revision) that changed `version.json`.
 * @throws Error when git cannot read the branch.
 */
export function readHistory(directory: string, branch: string): HistoryItem[] {
  const commits = git(directory, ["log", "--reverse", "--format=%H", branch, "--", "version.json"]).toString("utf8").split("\n").filter(Boolean);
  const items: HistoryItem[] = [];
  for (const commit of commits) {
    const manifest = show(directory, commit, "version.json");
    if (manifest === null) continue; // the commit removed version.json
    const signature = show(directory, commit, "version.json.sig");
    items.push({ commit, manifestBytes: new Uint8Array(manifest), signature: signature === null ? null : new Uint8Array(signature) });
  }
  return items;
}

/** The result of a bootstrap: the log, what went in, what was left out and why, and the missing sequences. */
export type BootstrapResult = {
  log: ReleaseLog;
  included: { commit: string; sequence: number; version: string }[];
  skipped: { commit: string; reason: string }[];
  gaps: number[];
};

/**
 * Turns the history into the first log of `channel`. A commit is left out (and named in `skipped`) when its signature
 * is missing or matches no trusted key, its version.json does not parse, it names another channel, or it repeats a
 * sequence already taken (the same bytes pushed again are left out silently). Sequences between 1 and the highest one
 * that no commit holds are `gaps`.
 */
export async function bootstrapLog(history: readonly HistoryItem[], channel: string, publicKeys: readonly JsonWebKey[]): Promise<BootstrapResult> {
  const skipped: BootstrapResult["skipped"] = [];
  const bySequence = new Map<number, { commit: string; manifest: ReleaseManifest; bytes: string }>();
  for (const item of history) {
    const short = item.commit.slice(0, 12);
    if (item.signature === null) {
      skipped.push({ commit: short, reason: "no version.json.sig" });
      continue;
    }
    if (!(await verifyManifestSignature({ manifestBytes: item.manifestBytes, signature: item.signature, publicKeys }))) {
      skipped.push({ commit: short, reason: "the signature matches no trusted key" });
      continue;
    }
    let manifest: ReleaseManifest;
    let named: string;
    try {
      manifest = parseManifest(Buffer.from(item.manifestBytes).toString("utf8"));
      named = manifestChannel(manifest);
    } catch (error) {
      skipped.push({ commit: short, reason: (error as Error).message });
      continue;
    }
    if (named !== channel) {
      skipped.push({ commit: short, reason: `on the channel ${named}, not ${channel}` });
      continue;
    }
    const bytes = Buffer.from(item.manifestBytes).toString("hex");
    const taken = bySequence.get(manifest.sequence);
    if (taken !== undefined) {
      if (taken.bytes !== bytes) skipped.push({ commit: short, reason: `sequence ${manifest.sequence} is already taken by ${taken.commit.slice(0, 12)}` });
      continue;
    }
    bySequence.set(manifest.sequence, { commit: item.commit, manifest, bytes });
  }
  const sequences = [...bySequence.keys()].sort((a, b) => a - b);
  let log: ReleaseLog = { schema: 1, channel, entries: [] };
  const included: BootstrapResult["included"] = [];
  for (const sequence of sequences) {
    const { commit, manifest } = bySequence.get(sequence)!;
    log = appendRelease(log, manifest);
    included.push({ commit: commit.slice(0, 12), sequence, version: manifest.channels[channel]! });
  }
  const highest = sequences.at(-1) ?? 0;
  const gaps: number[] = [];
  for (let sequence = 1; sequence <= highest; sequence += 1) if (!bySequence.has(sequence)) gaps.push(sequence);
  return { log, included, skipped, gaps };
}
