/**
 * The release log in the release scripts, run for real against fixture repositories on disk (file:// remotes), a local
 * stand-in for the kubo node and throwaway keys. Nothing here reaches a real remote, node or key.
 */
import { spawn } from "node:child_process";
import { chmod, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseManifest } from "../../landing/src/manifest.ts";
import { run, type Io } from "../src/main.ts";
import { appendRelease, canonicalLogBytes, parseLog, type ReleaseLog } from "../src/release-log.ts";
import { signBytes } from "../src/sign.ts";
import { commitRelease, git, manifestOf, sampleSite, streamOf, temporaryDirectory, throwawayKey, writeTree } from "./helpers.ts";

const scripts = fileURLToPath(new URL("../../../script/release/", import.meta.url));

function io(stdin: AsyncIterable<Uint8Array> = streamOf()) {
  const err: string[] = [];
  const value: Io = { stdin, env: {}, out: () => {}, err: (line) => err.push(line) };
  return { value, err };
}

/**
 * Runs a release script with real git (no global or system git configuration, so no commit signing prompt) and with
 * stand-ins for the build and deploy tools that only record that they ran. Asynchronous, so a fake server in this
 * process can answer it.
 */
async function runScript(name: string, args: string[], env: Record<string, string>, stdin = "", tools: Record<string, string> = {}) {
  const bin = await temporaryDirectory();
  const marker = join(bin, "ran");
  for (const tool of ["npx", "wrangler", "pnpm", "cargo", "curl"]) {
    await writeFile(join(bin, tool), `#!/bin/sh\n${tools[tool] ?? `echo "${tool} $*" >> "${marker}"\nexit 99`}\n`);
    await chmod(join(bin, tool), 0o755);
  }
  const emptyConfig = join(bin, "gitconfig");
  await writeFile(emptyConfig, "");
  const child = spawn("bash", [join(scripts, name), ...args], {
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME!, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: "1", ...env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  child.stdin.end(stdin);
  const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
  const ran = (await readdir(bin)).includes("ran") ? await readFile(marker, "utf8") : "";
  return { status, stdout, stderr, ran };
}

async function keysFile(...keys: JsonWebKey[]): Promise<string> {
  const path = join(await temporaryDirectory(), "keys.json");
  await writeFile(path, JSON.stringify(keys));
  return path;
}

async function signedLogBytes(log: ReleaseLog, privateKey: JsonWebKey) {
  const bytes = canonicalLogBytes(log);
  return { bytes, signature: await signBytes({ bytes, privateKey }) };
}

/** A bare release repository whose `next` branch holds the given commits (made by `fill` in a working copy). */
async function releaseRemote(fill: (work: string) => Promise<void>): Promise<string> {
  const bare = await temporaryDirectory();
  git(bare, "init", "--quiet", "--bare", "--initial-branch", "next");
  const work = await temporaryDirectory();
  git(work, "init", "--quiet", "--initial-branch", "next");
  await fill(work);
  git(work, "push", "--quiet", bare, "next");
  return bare;
}

/** A complete release on the next channel at `sequence`, with its log appended to `previous`, signed. */
async function signedRelease(sequence: number, previous: ReleaseLog | null, privateKey: JsonWebKey): Promise<string> {
  const site = await temporaryDirectory();
  const release = await temporaryDirectory();
  await writeTree(site, sampleSite);
  for (const name of ["dapp", "landing"]) expect(await run(["pack", site, join(release, "archives", `${name}.car`)], io().value)).toBe(0);
  const previousManifest = join(await temporaryDirectory(), "previous.json");
  await writeFile(previousManifest, JSON.stringify({ ...manifestOf(sequence - 1), sequence: sequence - 1 }));
  const args = ["--version", `0.1.${sequence}`, "--commit", "c".repeat(40), "--published-at", "2026-11-07T00:00:00Z", "--channel", "next", "--previous", previousManifest];
  expect(await run(["manifest", release, ...args], io().value)).toBe(0);
  const manifest = parseManifest(await readFile(join(release, "version.json"), "utf8"));
  await writeFile(join(release, "releases-log.json"), canonicalLogBytes(appendRelease(previous, manifest)));
  expect(await run(["sign", release], io(streamOf(JSON.stringify(privateKey))).value)).toBe(0);
  return release;
}

const servers: ReturnType<typeof createServer>[] = [];
afterEach(() => {
  servers.splice(0).forEach((server) => server.close());
});

/** A kubo node that imports and pins any archive whose root is `root`. */
async function healthyKubo(root: string): Promise<{ endpoint: string; calls: string[] }> {
  const calls: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://kubo");
    calls.push(url.pathname);
    request.resume();
    request.on("end", () => {
      response.writeHead(url.pathname === "/api/v0/files/stat" ? 500 : 200, { "content-type": "application/json" });
      if (url.pathname === "/api/v0/dag/import") response.end(`${JSON.stringify({ Root: { Cid: { "/": root }, PinErrorMsg: "" } })}\n`);
      else if (url.pathname === "/api/v0/pin/ls") response.end(JSON.stringify({ Keys: { [url.searchParams.get("arg")!]: { Type: "recursive" } } }));
      else if (url.pathname === "/api/v0/files/stat") response.end(JSON.stringify({ Message: "file does not exist" }));
      else response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls };
}

const identity = { RELEASE_GIT_NAME: "release-test", RELEASE_GIT_EMAIL: "release@example.org" };

describe("bootstrap-log.sh", () => {
  it("builds the first log from the branch history, signs it with the key on standard input, and pushes it once", async () => {
    const { privateKey, publicKey } = await throwawayKey();
    const remote = await releaseRemote(async (work) => {
      await commitRelease(work, manifestOf(1), privateKey);
      await commitRelease(work, manifestOf(2), privateKey);
      await commitRelease(work, manifestOf(4), privateKey);
    });
    const env = { RELEASE_CHANNEL: "next", RELEASE_REMOTE: `file://${remote}`, RELEASE_PUBLIC_KEYS: await keysFile(publicKey), ...identity };
    const out = await temporaryDirectory();
    const result = await runScript("bootstrap-log.sh", [out], { ...env, BOOTSTRAP_PUBLISH: "1" }, JSON.stringify(privateKey));
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("gaps: 3");
    expect(result.stdout).toContain("release log verified: 6 entries, last sequence 4");
    expect(result.stdout).toContain("published the next release log to the next branch");
    expect(result.stdout).not.toContain(privateKey.d!);

    const pushed = git(remote, "show", "next:releases-log.json");
    expect(pushed).toBe(await readFile(join(out, "releases-log.json"), "utf8"));
    expect(parseLog(pushed).entries.map((entry) => entry.sequence)).toEqual([1, 1, 2, 2, 4, 4]);
    expect(git(remote, "log", "-1", "--format=%an", "next").trim()).toBe("release-test");

    const again = await runScript("bootstrap-log.sh", [await temporaryDirectory()], env, JSON.stringify(privateKey));
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("the next branch already holds releases-log.json");
  });

  it("refuses without a channel, a remote, an identity to publish with, or an empty output directory", async () => {
    const out = await temporaryDirectory();
    expect((await runScript("bootstrap-log.sh", [out], {})).stderr).toContain("no release channel is set");
    expect((await runScript("bootstrap-log.sh", [out], { RELEASE_CHANNEL: "next" })).stderr).toContain("set RELEASE_REMOTE");
    const noIdentity = await runScript("bootstrap-log.sh", [out], { RELEASE_CHANNEL: "next", RELEASE_REMOTE: "file:///nowhere", BOOTSTRAP_PUBLISH: "1" });
    expect(noIdentity.stderr).toContain("set RELEASE_GIT_NAME and RELEASE_GIT_EMAIL");
    await writeTree(out, { "old.txt": "x" });
    expect((await runScript("bootstrap-log.sh", [out], { RELEASE_CHANNEL: "next", RELEASE_REMOTE: "file:///nowhere" })).stderr).toContain("is not empty");
    expect((await runScript("bootstrap-log.sh", [], {})).status).toBe(2);
  });
});

describe("publish.sh and the release log", () => {
  async function publishEnv(remote: string, publicKey: JsonWebKey, kubo = "http://127.0.0.1:9") {
    return {
      RELEASE_CHANNEL: "next",
      RELEASE_REMOTE: `file://${remote}`,
      RELEASE_PUBLIC_KEYS: await keysFile(publicKey),
      RELEASE_PIN_PROVIDER: "kubo",
      KUBO_API_URL: kubo,
      ...identity,
    };
  }

  it("pushes a release whose log extends the published log exactly, log and all", async () => {
    const { privateKey, publicKey } = await throwawayKey();
    const published = appendRelease(null, manifestOf(1));
    const { bytes, signature } = await signedLogBytes(published, privateKey);
    const remote = await releaseRemote(async (work) => {
      await writeFile(join(work, "releases-log.json"), bytes);
      await writeFile(join(work, "releases-log.json.sig"), signature);
      await commitRelease(work, manifestOf(1), privateKey);
    });
    const release = await signedRelease(2, published, privateKey);
    const root = parseManifest(await readFile(join(release, "version.json"), "utf8")).releases[0]!.cid;
    const kubo = await healthyKubo(root);
    const result = await runScript("publish.sh", [release], await publishEnv(remote, publicKey, kubo.endpoint));
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("release log verified: 4 entries, last sequence 2");
    expect(result.stdout).toContain("published 0.1.2 (sequence 2) on next");
    expect(git(remote, "show", "next:releases-log.json")).toBe(await readFile(join(release, "releases-log.json"), "utf8"));
    expect(git(remote, "cat-file", "-s", "next:releases-log.json.sig").trim()).toBe("64");
    expect(kubo.calls.filter((path) => path === "/api/v0/dag/import")).toHaveLength(2);
  });

  it("refuses, before pinning or pushing, a log that does not extend the published one", async () => {
    const { privateKey, publicKey } = await throwawayKey();
    const published = appendRelease(appendRelease(null, manifestOf(1)), manifestOf(2));
    const { bytes, signature } = await signedLogBytes(published, privateKey);
    const remote = await releaseRemote(async (work) => {
      await writeFile(join(work, "releases-log.json"), bytes);
      await writeFile(join(work, "releases-log.json.sig"), signature);
      await commitRelease(work, manifestOf(2), privateKey);
    });
    const head = git(remote, "rev-parse", "next");
    // Built on release 1's log only: it drops release 2.
    const release = await signedRelease(3, appendRelease(null, manifestOf(1)), privateKey);
    const kubo = await healthyKubo("bafyunused");
    const result = await runScript("publish.sh", [release], await publishEnv(remote, publicKey, kubo.endpoint));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("entries[2]: the published entry is changed, moved or removed");
    expect(result.stderr).toContain("release log NOT verified");
    expect(kubo.calls).toEqual([]);
    expect(git(remote, "rev-parse", "next")).toBe(head);
  });

  it("refuses a branch that has releases but no log yet, pointing at bootstrap-log.sh", async () => {
    const { privateKey, publicKey } = await throwawayKey();
    const remote = await releaseRemote((work) => commitRelease(work, manifestOf(1), privateKey));
    const release = await signedRelease(2, null, privateKey);
    const result = await runScript("publish.sh", [release], await publishEnv(remote, publicKey));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the next branch has releases but no releases-log.json: make the first log with script/release/bootstrap-log.sh");
  });
});

describe("release.sh and the release log", () => {
  it("stops before any build when the channel's branch has releases but no log", async () => {
    const { privateKey } = await throwawayKey();
    const remote = await releaseRemote((work) => commitRelease(work, manifestOf(1), privateKey));
    const result = await runScript("release.sh", [await temporaryDirectory()], { RELEASE_CHANNEL: "next", RELEASE_REMOTE: `file://${remote}` }, JSON.stringify(privateKey));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the next branch of the release repository has releases but no releases-log.json");
    expect(result.ran).toBe("");
  });

  it("stops before any build when the published log is not signed by the channel's trusted key", async () => {
    const stranger = await throwawayKey();
    const { bytes, signature } = await signedLogBytes(appendRelease(null, manifestOf(1)), stranger.privateKey);
    const remote = await releaseRemote(async (work) => {
      await writeFile(join(work, "releases-log.json"), bytes);
      await writeFile(join(work, "releases-log.json.sig"), signature);
      await commitRelease(work, manifestOf(1), stranger.privateKey);
    });
    const result = await runScript("release.sh", [await temporaryDirectory()], { RELEASE_CHANNEL: "next", RELEASE_REMOTE: `file://${remote}` });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the signature does not match any trusted release key");
    expect(result.ran).toBe("");
  });

  it("stops when the release repository cannot be read", async () => {
    const result = await runScript("release.sh", [await temporaryDirectory()], { RELEASE_CHANNEL: "next", RELEASE_REMOTE: "file:///nowhere/at/all" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not read the release repository to fetch the next release log");
    expect(result.ran).toBe("");
  });
});

describe("publish-pages.sh serves the log next to version.json", () => {
  it("puts releases-log.json and its signature in the deployed site", async () => {
    const { privateKey, publicKey } = await throwawayKey();
    const release = await signedRelease(1, null, privateKey);
    // A wrangler stand-in that lists the files of the site it would deploy, instead of deploying.
    const listSite = `node -e 'console.log(require("fs").readdirSync(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).assets.directory).sort().join(" "))' "$5" > "$(dirname "$0")/ran"`;
    const result = await runScript(
      "publish-pages.sh",
      [release],
      { RELEASE_CHANNEL: "next", RELEASE_PAGES_LANDING: "zkb-fi-next", RELEASE_PUBLIC_KEYS: await keysFile(publicKey) },
      "",
      { npx: listSite },
    );
    expect(result.status).toBe(0);
    expect(result.ran.trim().split(" ")).toEqual(expect.arrayContaining(["index.html", "version.json", "version.json.sig", "releases-log.json", "releases-log.json.sig"]));
  });
});

describe("repin-from-log.sh", () => {
  it("refuses without a channel or a kubo address, and checks a log file against the channel's keys", async () => {
    const { privateKey, publicKey } = await throwawayKey();
    expect((await runScript("repin-from-log.sh", [], {})).stderr).toContain("no release channel is set");
    expect((await runScript("repin-from-log.sh", [], { RELEASE_CHANNEL: "next" })).stderr).toContain("set KUBO_API_URL");
    expect((await runScript("repin-from-log.sh", ["a", "b"], {})).status).toBe(2);

    const directory = await temporaryDirectory();
    const log = appendRelease(null, manifestOf(1));
    const { bytes, signature } = await signedLogBytes(log, privateKey);
    await writeFile(join(directory, "releases-log.json"), bytes);
    await writeFile(join(directory, "releases-log.json.sig"), signature);
    const kubo = await healthyKubo("bafyunused");
    const env = { RELEASE_CHANNEL: "next", KUBO_API_URL: kubo.endpoint, RELEASE_PUBLIC_KEYS: await keysFile(publicKey) };
    const checked = await runScript("repin-from-log.sh", [join(directory, "releases-log.json")], env);
    expect(checked.stderr).toBe("");
    expect(checked.status).toBe(0);
    expect(checked.stdout).toContain("2 CIDs in the log, 2 pinned, 0 missing (check only: --mode apply pins them)");

    const untrusted = await runScript("repin-from-log.sh", [join(directory, "releases-log.json")], { ...env, RELEASE_PUBLIC_KEYS: await keysFile((await throwawayKey()).publicKey) });
    expect(untrusted.status).toBe(1);
    expect(untrusted.stderr).toContain("the signature does not match any trusted release key");
    expect(kubo.calls.filter((path) => path === "/api/v0/pin/ls")).toHaveLength(2);
  });

  it("reads the log from the channel's branch of RELEASE_REMOTE, and refuses a branch without one", async () => {
    const { privateKey, publicKey } = await throwawayKey();
    const { bytes, signature } = await signedLogBytes(appendRelease(null, manifestOf(1)), privateKey);
    const withLog = await releaseRemote(async (work) => {
      await writeFile(join(work, "releases-log.json"), bytes);
      await writeFile(join(work, "releases-log.json.sig"), signature);
      await commitRelease(work, manifestOf(1), privateKey);
    });
    const kubo = await healthyKubo("bafyunused");
    const env = { RELEASE_CHANNEL: "next", KUBO_API_URL: kubo.endpoint, RELEASE_PUBLIC_KEYS: await keysFile(publicKey) };
    const fromRemote = await runScript("repin-from-log.sh", [], { ...env, RELEASE_REMOTE: `file://${withLog}` });
    expect(fromRemote.status).toBe(0);
    expect(fromRemote.stdout).toContain("2 CIDs in the log, 2 pinned");

    const withoutLog = await releaseRemote((work) => commitRelease(work, manifestOf(1), privateKey));
    const refused = await runScript("repin-from-log.sh", [], { ...env, RELEASE_REMOTE: `file://${withoutLog}` });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("the next branch of the release repository holds no releases-log.json");
  });
});
