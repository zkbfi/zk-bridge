import { describe, expect, it } from "vitest";
import {
  appendRelease,
  canonicalLogBytes,
  checkSignedLog,
  entryHash,
  extensionProblems,
  LogError,
  logProblems,
  manifestChannel,
  manifestProblems,
  parseLog,
  type ReleaseLog,
} from "../src/release-log.ts";
import { signBytes } from "../src/sign.ts";
import { manifestOf, throwawayKey } from "./helpers.ts";

const cid = (n: number, site: string) => `bafy${site}${String(n).padStart(8, "0")}`;

/** The log of releases 1..count on `channel`. */
function logOf(count: number, channel = "next"): ReleaseLog {
  let log: ReleaseLog | null = null;
  for (let sequence = 1; sequence <= count; sequence += 1) log = appendRelease(log, manifestOf(sequence, channel));
  return log!;
}

/** Re-chains every entry after an edit, as someone rewriting history would. */
function rechain(log: ReleaseLog): ReleaseLog {
  const entries = log.entries.map((entry) => ({ ...entry }));
  entries.forEach((entry, index) => {
    entry.previous = index === 0 ? null : entryHash(entries[index - 1]!);
  });
  return { ...log, entries };
}

const roundTrip = (log: ReleaseLog) => parseLog(Buffer.from(canonicalLogBytes(log)).toString("utf8"));

describe("appendRelease", () => {
  it("starts a log with the sites of the first release, chained from null", () => {
    const log = appendRelease(null, manifestOf(1));
    expect(log.channel).toBe("next");
    expect(log.entries.map((entry) => [entry.sequence, entry.name, entry.cid])).toEqual([
      [1, "dapp", cid(1, "dapp")],
      [1, "landing", cid(1, "landing")],
    ]);
    expect(log.entries[0]!.previous).toBeNull();
    expect(log.entries[1]!.previous).toBe(entryHash(log.entries[0]!));
    expect(logProblems(log)).toEqual([]);
  });

  it("appends the next release, keeping every earlier entry and chaining to the last", () => {
    const one = logOf(1);
    const two = appendRelease(one, manifestOf(2));
    expect(two.entries.slice(0, 2)).toEqual(one.entries);
    expect(two.entries[2]!.previous).toBe(entryHash(one.entries[1]!));
    expect(extensionProblems(one, two)).toEqual([]);
    expect(manifestProblems(two, manifestOf(2))).toEqual([]);
  });

  it("refuses a sequence the log already reaches, another channel, or a broken previous log", () => {
    const log = logOf(2);
    expect(() => appendRelease(log, manifestOf(2))).toThrow("the log already reaches 2");
    expect(() => appendRelease(log, manifestOf(1))).toThrow(LogError);
    expect(() => appendRelease(log, manifestOf(3, "stable"))).toThrow("the previous release log is on next, the release on stable");
    const broken = { ...log, entries: [log.entries[1]!, log.entries[0]!] };
    expect(() => appendRelease(broken, manifestOf(3))).toThrow("the previous release log is broken");
  });

  it("refuses a release that names one site twice, and a manifest without exactly one channel", () => {
    expect(() => appendRelease(null, manifestOf(1, "next", ["dapp", "dapp"]))).toThrow("the release cannot be logged: entries[1]: sequence 1 names dapp twice");
    expect(() => appendRelease(null, { ...manifestOf(1), channels: { next: "1", stable: "1" } })).toThrow("exactly one channel");
    expect(() => manifestChannel({ ...manifestOf(1), channels: {} })).toThrow("exactly one channel");
  });
});

describe("the append-only rule (extensionProblems)", () => {
  const published = logOf(3);
  const next = appendRelease(published, manifestOf(4));

  it("accepts the published log with one more release appended", () => {
    expect(extensionProblems(published, next)).toEqual([]);
  });

  it("rejects entries reordered, even when re-chained", () => {
    const entries = [...next.entries];
    [entries[0], entries[2]] = [entries[2]!, entries[0]!];
    const reordered = rechain({ ...next, entries });
    expect(extensionProblems(published, reordered).join("\n")).toContain("entries[0]: the published entry is changed, moved or removed");
  });

  it("rejects an edited entry, re-chained or not", () => {
    const edited = { ...next, entries: next.entries.map((entry, index) => (index === 1 ? { ...entry, cid: "bafyevil0000000000" } : entry)) };
    const problems = extensionProblems(published, edited);
    expect(problems).toContain("entries[1]: the published entry is changed, moved or removed");
    expect(problems).toContain("the new log: entries[2]: previous does not chain to the entry before it");
    // Re-chaining hides nothing: every later published entry now differs too, because each names the hash before it.
    expect(extensionProblems(published, rechain(edited))).toEqual([1, 2, 3, 4, 5].map((index) => `entries[${index}]: the published entry is changed, moved or removed`));
  });

  it("rejects a removed entry, and a log that adds nothing", () => {
    const removed = rechain({ ...next, entries: next.entries.filter((_, index) => index !== 0) });
    expect(extensionProblems(published, removed)).toContain("entries[0]: the published entry is changed, moved or removed");
    expect(extensionProblems(published, published)).toEqual(["the new log has 6 entries, the published one 6: it must add at least one"]);
    const shorter = logOf(2);
    expect(extensionProblems(published, shorter)).toContain("entries[4]: the published entry is changed, moved or removed");
  });

  it("rejects a broken chain in either log", () => {
    const broken = { ...next, entries: next.entries.map((entry, index) => (index === 7 ? { ...entry, previous: "0".repeat(64) } : entry)) };
    expect(extensionProblems(published, broken)).toEqual(["the new log: entries[7]: previous does not chain to the entry before it"]);
    const brokenPublished = { ...published, entries: published.entries.map((entry, index) => (index === 0 ? { ...entry, previous: "0".repeat(64) } : entry)) };
    expect(extensionProblems(brokenPublished, next)).toContain("the published log: entries[0]: previous does not chain to the entry before it");
  });

  it("rejects a new release whose sequence does not go up", () => {
    const same = rechain({ ...next, entries: next.entries.map((entry, index) => (index >= 6 ? { ...entry, sequence: 3, version: "0.1.3" } : entry)) });
    const problems = extensionProblems(published, same);
    expect(problems).toContain("the first new entry has sequence 3, not above the published 3");
    expect(problems.join("\n")).toContain("sequence 3 names dapp twice");
    const lower = rechain({ ...next, entries: next.entries.map((entry, index) => (index >= 6 ? { ...entry, sequence: 2, version: "0.1.2" } : entry)) });
    expect(extensionProblems(published, lower)).toContain("the new log: entries[6]: sequence 2 goes down from 3");
  });

  it("rejects another channel, and accepts any log extending an empty one", () => {
    const empty: ReleaseLog = { schema: 1, channel: "next", entries: [] };
    expect(extensionProblems(empty, next)).toEqual([]);
    const stable = logOf(4, "stable");
    expect(extensionProblems(published, stable)).toContain("the new log is on stable, the published one on next");
  });
});

describe("logProblems", () => {
  it("names an entry on another channel and two versions under one sequence", () => {
    const log = logOf(1);
    const mixed = rechain({ ...log, entries: [log.entries[0]!, { ...log.entries[1]!, channel: "stable", version: "9.9.9" }] });
    expect(logProblems(mixed)).toEqual(["entries[1]: the channel is stable, the log is next", "entries[1]: sequence 1 names two versions"]);
  });
});

describe("manifestProblems", () => {
  it("accepts a log whose last release is the manifest, and refuses anything else", () => {
    const log = logOf(3);
    expect(manifestProblems(log, manifestOf(3))).toEqual([]);
    const tail = ["the last entries of the log are not the sites of version.json (sequence 2)"];
    expect(manifestProblems(log, manifestOf(2))).toEqual(tail);
    expect(manifestProblems(log, manifestOf(4))).toEqual(["the last entries of the log are not the sites of version.json (sequence 4)"]);
    const changed = manifestOf(3);
    changed.releases[1] = { ...changed.releases[1]!, cid: "bafyother000000000" };
    expect(manifestProblems(log, changed)).toEqual(["the last entries of the log are not the sites of version.json (sequence 3)"]);
    expect(manifestProblems(log, manifestOf(3, "next", ["dapp"]))).toEqual(["the last entries of the log are not the sites of version.json (sequence 3)"]);
    expect(manifestProblems(log, manifestOf(3, "stable"))).toEqual(["version.json is not on the log's channel next"]);
    expect(manifestProblems(log, { ...manifestOf(3), channels: { next: "a", stable: "b" } })).toEqual(["version.json is not on the log's channel next"]);
  });
});

describe("parseLog", () => {
  it("reads what canonicalLogBytes writes, keys sorted with no spaces", () => {
    const log = logOf(2);
    expect(roundTrip(log)).toEqual(log);
    const text = Buffer.from(canonicalLogBytes(log)).toString("utf8");
    expect(text.startsWith('{"channel":"next","entries":[{"archiveSha256":')).toBe(true);
    expect(text).not.toContain(" ");
  });

  it("refuses text that is not the format", () => {
    const good = JSON.parse(Buffer.from(canonicalLogBytes(logOf(1))).toString("utf8")) as Record<string, unknown>;
    const entry = (good.entries as Record<string, unknown>[])[0]!;
    const cases: [unknown, string][] = [
      ["not json", "not valid JSON"],
      [[], "the release log must be an object"],
      [{ ...good, extra: 1 }, "unknown fields: extra"],
      [{ ...good, schema: 2 }, "schema is not supported"],
      [{ ...good, entries: {} }, "entries must be a list"],
      [{ ...good, channel: "Next!" }, "channel has the wrong form"],
      [{ ...good, channel: "" }, "channel must be a non-empty string"],
      [{ ...good, entries: [5] }, "entries[0] must be an object"],
      [{ ...good, entries: [{ ...entry, sequence: -1 }] }, "entries[0].sequence must be a whole number"],
      [{ ...good, entries: [{ ...entry, sequence: "1" }] }, "entries[0].sequence must be a whole number"],
      [{ ...good, entries: [{ ...entry, sequence: 1.5 }] }, "entries[0].sequence must be a whole number"],
      [{ ...good, entries: [{ ...entry, name: "wallet" }] }, "entries[0].name is not a known site"],
      [{ ...good, entries: [{ ...entry, previous: "abc" }] }, "entries[0].previous has the wrong form"],
      [{ ...good, entries: [{ ...entry, cid: "x" }] }, "entries[0].cid has the wrong form"],
      [{ ...good, entries: [{ ...entry, extra: true }] }, "entries[0] has unknown fields: extra"],
    ];
    for (const [value, message] of cases) {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      expect(() => parseLog(text), message).toThrow(message);
    }
    expect(parseLog(JSON.stringify({ ...good, entries: [{ ...entry, previous: "f".repeat(64) }] })).entries[0]!.previous).toBe("f".repeat(64));
  });
});

describe("checkSignedLog", () => {
  it("accepts a log signed by a trusted key, and refuses a wrong key, a missing signature, no keys, damage and a broken rule", async () => {
    const { privateKey, publicKey } = await throwawayKey();
    const other = await throwawayKey();
    const log = logOf(2);
    const logBytes = canonicalLogBytes(log);
    const signature = await signBytes({ bytes: logBytes, privateKey });

    const good = await checkSignedLog({ logBytes, signature, publicKeys: [other.publicKey, publicKey] });
    expect(good).toEqual({ ok: true, log });

    expect(await checkSignedLog({ logBytes, signature, publicKeys: [other.publicKey] })).toEqual({
      ok: false,
      problems: ["releases-log.json.sig: the signature does not match any trusted release key"],
    });
    expect(await checkSignedLog({ logBytes, signature: null, publicKeys: [publicKey], where: "x.json" })).toEqual({ ok: false, problems: ["x.json.sig: missing"] });
    expect(await checkSignedLog({ logBytes, signature, publicKeys: [] })).toEqual({ ok: false, problems: ["no release public key was given"] });

    const spaced = new TextEncoder().encode(JSON.stringify(log, null, 1));
    const spacedSigned = await signBytes({ bytes: spaced, privateKey });
    expect(await checkSignedLog({ logBytes: spaced, signature: spacedSigned, publicKeys: [publicKey] })).toEqual({
      ok: false,
      problems: ["releases-log.json: not written in canonical form"],
    });

    const garbage = new TextEncoder().encode("{");
    const garbageResult = await checkSignedLog({ logBytes: garbage, signature, publicKeys: [publicKey] });
    expect(garbageResult.ok).toBe(false);
    expect((garbageResult as { problems: string[] }).problems.at(-1)).toBe("releases-log.json: the release log is not valid JSON");

    const broken = { ...log, entries: [log.entries[1]!, log.entries[0]!] };
    const brokenBytes = canonicalLogBytes(broken);
    const brokenResult = await checkSignedLog({ logBytes: brokenBytes, signature: await signBytes({ bytes: brokenBytes, privateKey }), publicKeys: [publicKey] });
    expect(brokenResult.ok).toBe(false);
    expect((brokenResult as { problems: string[] }).problems[0]).toBe("releases-log.json: entries[0]: previous does not chain to the entry before it");
  });
});
