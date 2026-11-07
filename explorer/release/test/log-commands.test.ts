import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalManifestBytes } from "../../landing/src/manifest.ts";
import { run, type Io } from "../src/main.ts";
import { kuboPinsFromEnvironment, PinError } from "../src/pin.ts";
import { appendRelease, canonicalLogBytes, parseLog, type ReleaseLog } from "../src/release-log.ts";
import { signBytes } from "../src/sign.ts";
import { commitRelease, git, manifestOf, sampleSite, streamOf, temporaryDirectory, throwawayKey, writeTree } from "./helpers.ts";

function io(stdin: AsyncIterable<Uint8Array> = streamOf(), env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = { stdin, env, out: (line) => out.push(line), err: (line) => err.push(line) };
  return { value, out, err };
}

async function keysFile(...keys: JsonWebKey[]): Promise<string> {
  const path = join(await temporaryDirectory(), "keys.json");
  await writeFile(path, JSON.stringify(keys));
  return path;
}

/** Writes a log and its signature to `<directory>/releases-log.json(.sig)` and returns the log path. */
async function writeSignedLog(directory: string, log: ReleaseLog, privateKey: JsonWebKey): Promise<string> {
  const bytes = canonicalLogBytes(log);
  const path = join(directory, "releases-log.json");
  await writeFile(path, bytes);
  await writeFile(`${path}.sig`, await signBytes({ bytes, privateKey }));
  return path;
}

function logOf(...sequences: number[]): ReleaseLog {
  let log: ReleaseLog | null = null;
  for (const sequence of sequences) log = appendRelease(log, manifestOf(sequence));
  return log ?? { schema: 1, channel: "next", entries: [] };
}

/** A packed, manifested release on the next channel at `sequence` (unsigned). */
async function packedRelease(sequence: number): Promise<string> {
  const site = await temporaryDirectory();
  const release = await temporaryDirectory();
  await writeTree(site, sampleSite);
  for (const name of ["dapp", "landing"]) expect(await run(["pack", site, join(release, "archives", `${name}.car`)], io().value)).toBe(0);
  const previous = join(await temporaryDirectory(), "previous.json");
  await writeFile(previous, canonicalManifestBytes({ ...manifestOf(sequence - 1), sequence: sequence - 1 }));
  const args = ["--version", `0.1.${sequence}`, "--commit", "c".repeat(40), "--published-at", "2026-11-07T00:00:00Z", "--channel", "next"];
  expect(await run(["manifest", release, ...args, ...(sequence > 1 ? ["--previous", previous] : [])], io().value)).toBe(0);
  return release;
}

describe("sign, log and verify with the release log", () => {
  it("appends the release to the published log, signs both files with one key read, and verifies them", async () => {
    const { privateKey, publicKey } = await throwawayKey();
    const keys = await keysFile(publicKey);
    const published = await writeSignedLog(await temporaryDirectory(), logOf(1, 2), privateKey);
    const release = await packedRelease(3);

    const logged = io();
    expect(await run(["log", release, "--previous-log", published, "--public-keys", keys], logged.value)).toBe(0);
    expect(logged.out).toEqual(["releases-log.json: 6 entries, 2 new, last sequence 3"]);
    expect(await run(["sign", release], io(streamOf(JSON.stringify(privateKey))).value)).toBe(0);

    const verified = io();
    expect(await run(["verify", release, "--public-keys", keys], verified.value)).toBe(0);
    expect(verified.out).toEqual(["release verified"]);

    const checked = io();
    const logPath = join(release, "releases-log.json");
    expect(await run(["log-check", logPath, "--public-keys", keys, "--extends", published, "--manifest", join(release, "version.json")], checked.value)).toBe(0);
    expect(checked.out).toEqual(["release log verified: 6 entries, last sequence 3"]);
  });

  it("starts a new log when no previous log is given, and needs the trusted keys for a previous log", async () => {
    const release = await packedRelease(1);
    const fresh = io();
    expect(await run(["log", release], fresh.value)).toBe(0);
    expect(fresh.out).toEqual(["releases-log.json: 2 entries, 2 new, last sequence 1, a new log (no previous log given)"]);
    expect(parseLog(await readFile(join(release, "releases-log.json"), "utf8")).entries).toHaveLength(2);
    expect(await run(["log", release, "--previous-log", join(release, "releases-log.json")], io().value)).toBe(2);
  });

  it("refuses to append to a published log that is not signed by a trusted key", async () => {
    const { privateKey } = await throwawayKey();
    const stranger = await throwawayKey();
    const published = await writeSignedLog(await temporaryDirectory(), logOf(1), stranger.privateKey);
    const release = await packedRelease(2);
    const refused = io();
    expect(await run(["log", release, "--previous-log", published, "--public-keys", await keysFile((await throwawayKey()).publicKey)], refused.value)).toBe(1);
    expect(refused.err[0]).toContain("the signature does not match any trusted release key");
    expect(privateKey.d).toBeTypeOf("string");
  });

  it("verify reports a log that does not end with the release, or is signed by another key", async () => {
    const { privateKey, publicKey } = await throwawayKey();
    const keys = await keysFile(publicKey);
    const release = await packedRelease(1);
    expect(await run(["sign", release], io(streamOf(JSON.stringify(privateKey))).value)).toBe(0);
    // A log of another release, signed by the trusted key.
    await writeSignedLog(release, logOf(1), privateKey);
    const mismatch = io();
    expect(await run(["verify", release, "--public-keys", keys], mismatch.value)).toBe(1);
    expect(mismatch.err).toContain("releases-log.json: the last entries of the log are not the sites of version.json (sequence 1)");
    // The same log signed by a stranger.
    await writeSignedLog(release, logOf(1), (await throwawayKey()).privateKey);
    const wrongKey = io();
    expect(await run(["verify", release, "--public-keys", keys], wrongKey.value)).toBe(1);
    expect(wrongKey.err).toContain("releases-log.json.sig: the signature does not match any trusted release key");
  });

  it("sign signs a directory that holds only a log, and refuses a directory that holds neither file", async () => {
    const { privateKey, publicKey } = await throwawayKey();
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "releases-log.json"), canonicalLogBytes(logOf(1)));
    expect(await run(["sign", directory], io(streamOf(JSON.stringify(privateKey))).value)).toBe(0);
    const checked = io();
    expect(await run(["log-check", join(directory, "releases-log.json"), "--public-keys", await keysFile(publicKey)], checked.value)).toBe(0);
    await expect(readFile(join(directory, "version.json.sig"))).rejects.toThrow();

    const empty = await temporaryDirectory();
    const refused = io(streamOf(JSON.stringify(privateKey)));
    expect(await run(["sign", empty], refused.value)).toBe(1);
    expect(refused.err[0]).toBe(`${empty} holds neither version.json nor releases-log.json`);
  });
});

describe("log-check", () => {
  it("refuses a log that rewrites the published one, and names a published log that does not check", async () => {
    const { privateKey, publicKey } = await throwawayKey();
    const keys = await keysFile(publicKey);
    const published = await writeSignedLog(await temporaryDirectory(), logOf(1, 2), privateKey);
    const rewritten = await writeSignedLog(await temporaryDirectory(), logOf(1, 3), privateKey);
    const refused = io();
    expect(await run(["log-check", rewritten, "--public-keys", keys, "--extends", published], refused.value)).toBe(1);
    expect(refused.err).toContain("entries[2]: the published entry is changed, moved or removed");
    expect(refused.err.at(-1)).toBe("release log NOT verified");

    const unsigned = join(await temporaryDirectory(), "releases-log.json");
    await writeFile(unsigned, canonicalLogBytes(logOf(1)));
    const badPublished = io();
    expect(await run(["log-check", rewritten, "--public-keys", keys, "--extends", unsigned], badPublished.value)).toBe(1);
    expect(badPublished.err[0]).toBe(`the published log does not check: ${unsigned}.sig: missing`);
  });

  it("refuses a missing log, a log that does not end with the manifest, and accepts an empty signed log", async () => {
    const { privateKey, publicKey } = await throwawayKey();
    const keys = await keysFile(publicKey);
    const directory = await temporaryDirectory();
    const missing = io();
    expect(await run(["log-check", join(directory, "nope.json"), "--public-keys", keys], missing.value)).toBe(1);
    expect(missing.err).toEqual([`${join(directory, "nope.json")}: missing`, "release log NOT verified"]);

    const log = await writeSignedLog(directory, logOf(1, 2), privateKey);
    const manifest = join(directory, "version.json");
    await writeFile(manifest, canonicalManifestBytes(manifestOf(1)));
    const behind = io();
    expect(await run(["log-check", log, "--public-keys", keys, "--manifest", manifest], behind.value)).toBe(1);
    expect(behind.err[0]).toBe("the last entries of the log are not the sites of version.json (sequence 1)");

    const empty = await writeSignedLog(await temporaryDirectory(), logOf(), privateKey);
    const ok = io();
    expect(await run(["log-check", empty, "--public-keys", keys], ok.value)).toBe(0);
    expect(ok.out).toEqual(["release log verified: 0 entries, last sequence 0"]);
  });
});

describe("log-bootstrap", () => {
  it("writes the first log of a channel from a fixture repository's history and prints the report", async () => {
    const { privateKey, publicKey } = await throwawayKey();
    const repository = await temporaryDirectory();
    git(repository, "init", "--quiet", "--initial-branch", "next");
    await commitRelease(repository, manifestOf(1), privateKey);
    await commitRelease(repository, manifestOf(3), privateKey);
    await commitRelease(repository, manifestOf(4), null);
    const out = join(await temporaryDirectory(), "log");
    const result = io();
    expect(await run(["log-bootstrap", repository, out, "--branch", "next", "--channel", "next", "--public-keys", await keysFile(publicKey)], result.value)).toBe(0);
    expect(result.out[0]).toMatch(/^included sequence 1 \(0\.1\.1\) from [0-9a-f]{12}$/);
    expect(result.out[1]).toMatch(/^included sequence 3 \(0\.1\.3\) from [0-9a-f]{12}$/);
    expect(result.out[2]).toMatch(/^skipped [0-9a-f]{12}: no version\.json\.sig$/);
    expect(result.out.slice(3)).toEqual(["gaps: 2", "releases-log.json: 4 entries from 2 releases on next; sign it with the next key"]);
    expect(parseLog(await readFile(join(out, "releases-log.json"), "utf8"))).toEqual(logOf(1, 3));

    const clean = io();
    const cleanOut = await temporaryDirectory();
    await rm(cleanOut, { recursive: true });
    const one = await temporaryDirectory();
    git(one, "init", "--quiet", "--initial-branch", "next");
    await commitRelease(one, manifestOf(1), privateKey);
    expect(await run(["log-bootstrap", one, cleanOut, "--branch", "next", "--channel", "next", "--public-keys", await keysFile(publicKey)], clean.value)).toBe(0);
    expect(clean.out.at(-2)).toBe("gaps: none");
  });
});

/** A local stand-in for the kubo RPC API: `pinned` CIDs are pinned; `fetchable` ones can be pinned from the network. */
async function fakeKubo(pinned: Set<string>, fetchable: Set<string>) {
  const calls: { path: string; arg: string | null; name: string | null; auth: string | undefined }[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://kubo");
    const arg = url.searchParams.get("arg");
    calls.push({ path: url.pathname, arg, name: url.searchParams.get("name"), auth: request.headers.authorization });
    request.resume();
    request.on("end", () => {
      const error = (message: string) => {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ Message: message, Code: 0, Type: "error" }));
      };
      if (url.pathname === "/api/v0/pin/ls") {
        if (arg !== null && pinned.has(arg)) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ Keys: { [arg]: { Type: "recursive" } } }));
        } else error(`path '${arg}' is not pinned`);
      } else if (url.pathname === "/api/v0/pin/add" && arg !== null && fetchable.has(arg)) {
        pinned.add(arg);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ Pins: [arg] }));
      } else error("context deadline exceeded");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls };
}

const servers: ReturnType<typeof createServer>[] = [];
afterEach(() => {
  servers.splice(0).forEach((server) => server.close());
});

describe("repin", () => {
  const cid = (sequence: number, site: string) => `bafy${site}${String(sequence).padStart(8, "0")}`;

  it("lists each CID of the log once as pinned or MISSING, and pins nothing in check mode", async () => {
    const { privateKey, publicKey } = await throwawayKey();
    const log = await writeSignedLog(await temporaryDirectory(), logOf(1, 2), privateKey);
    const kubo = await fakeKubo(new Set([cid(1, "dapp"), cid(2, "dapp"), cid(2, "landing")]), new Set());
    const result = io(streamOf(), { KUBO_API_URL: kubo.endpoint, KUBO_API_AUTH: "Bearer secret-token" });
    expect(await run(["repin", log, "--public-keys", await keysFile(publicKey)], result.value)).toBe(0);
    expect(result.out).toEqual([
      `pinned   ${cid(1, "dapp")} dapp 0.1.1`,
      `MISSING  ${cid(1, "landing")} landing 0.1.1`,
      `pinned   ${cid(2, "dapp")} dapp 0.1.2`,
      `pinned   ${cid(2, "landing")} landing 0.1.2`,
      "4 CIDs in the log, 3 pinned, 1 missing (check only: --mode apply pins them)",
    ]);
    expect(kubo.calls.every((call) => call.path === "/api/v0/pin/ls" && call.auth === "Bearer secret-token")).toBe(true);
    expect(result.out.join("\n")).not.toContain("secret-token");
  });

  it("pins each missing CID under zkbfi-<site>-<version> in apply mode, reports those the node cannot fetch, and exits 1", async () => {
    const { privateKey, publicKey } = await throwawayKey();
    const log = await writeSignedLog(await temporaryDirectory(), logOf(1, 2), privateKey);
    const kubo = await fakeKubo(new Set([cid(2, "dapp")]), new Set([cid(1, "dapp"), cid(1, "landing")]));
    const result = io(streamOf(), { KUBO_API_URL: kubo.endpoint });
    expect(await run(["repin", log, "--public-keys", await keysFile(publicKey), "--mode", "apply"], result.value)).toBe(1);
    expect(result.out).toEqual([
      `repinned ${cid(1, "dapp")} dapp 0.1.1`,
      `repinned ${cid(1, "landing")} landing 0.1.1`,
      `pinned   ${cid(2, "dapp")} dapp 0.1.2`,
      "4 CIDs in the log, 1 pinned, 3 missing, 2 repinned, 1 failed",
    ]);
    expect(result.err).toEqual([`FAILED   ${cid(2, "landing")} landing 0.1.2: kubo answered 500 to pinning ${cid(2, "landing")}: context deadline exceeded`]);
    expect(kubo.calls.filter((call) => call.path === "/api/v0/pin/add").map((call) => call.name)).toEqual([
      "zkbfi-dapp-0.1.1",
      "zkbfi-landing-0.1.1",
      "zkbfi-landing-0.1.2",
    ]);

    const allPinned = await fakeKubo(new Set(logOf(1, 2).entries.map((entry) => entry.cid)), new Set());
    const done = io(streamOf(), { KUBO_API_URL: allPinned.endpoint });
    expect(await run(["repin", log, "--public-keys", await keysFile(publicKey), "--mode", "apply"], done.value)).toBe(0);
    expect(done.out.at(-1)).toBe("4 CIDs in the log, 4 pinned, 0 missing, 0 repinned, 0 failed");
  });

  it("refuses an unknown mode, a log that does not check, and a missing kubo address", async () => {
    const { privateKey, publicKey } = await throwawayKey();
    const log = await writeSignedLog(await temporaryDirectory(), logOf(1), privateKey);
    const keys = await keysFile(publicKey);
    expect(await run(["repin", log, "--public-keys", keys, "--mode", "everything"], io().value)).toBe(2);
    const stranger = io(streamOf(), { KUBO_API_URL: "http://127.0.0.1:9" });
    expect(await run(["repin", log, "--public-keys", await keysFile((await throwawayKey()).publicKey)], stranger.value)).toBe(1);
    expect(stranger.err[0]).toContain("the signature does not match any trusted release key");
    const noKubo = io();
    expect(await run(["repin", log, "--public-keys", keys], noKubo.value)).toBe(1);
    expect(noKubo.err).toEqual(["the kubo adapter needs KUBO_API_URL"]);
  });
});

describe("kuboPinsFromEnvironment", () => {
  it("fails on a pin list in an unknown shape, and counts a non-recursive pin as not pinned", async () => {
    const shapes: Record<string, string> = { a: "not json", b: JSON.stringify({ Keys: null }), c: JSON.stringify({ Keys: { c: { Type: "direct" } } }) };
    const kubo = await fakeKubo(new Set(), new Set());
    const server = createServer((request, response) => {
      const arg = new URL(request.url!, "http://kubo").searchParams.get("arg")!;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(shapes[arg]);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const pins = kuboPinsFromEnvironment({ KUBO_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    await expect(pins.isPinned("a")).rejects.toThrow(new PinError("kubo answered the pin list of a in an unknown shape"));
    await expect(pins.isPinned("b")).rejects.toThrow("in an unknown shape");
    await expect(pins.isPinned("c")).resolves.toBe(false);
    expect(kuboPinsFromEnvironment({ KUBO_API_URL: kubo.endpoint }).endpoint).toBe(kubo.endpoint);
  });
});
