import { spawnSync } from "node:child_process";
import { chmod, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { temporaryDirectory, writeTree } from "./helpers.ts";

const scripts = fileURLToPath(new URL("../../../script/release/", import.meta.url));

/**
 * Runs a release script with a clean environment, and with `npx` and `git` on PATH replaced by stand-ins that only
 * record that they ran. Only the refusal paths are tested: nothing here may deploy, pin or push.
 */
async function runScript(name: string, args: string[], env: Record<string, string> = {}) {
  const bin = await temporaryDirectory();
  const marker = join(bin, "ran");
  for (const tool of ["npx", "git", "wrangler"]) {
    await writeFile(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> "${marker}"\nexit 99\n`);
    await chmod(join(bin, tool), 0o755);
  }
  const result = spawnSync("bash", [join(scripts, name), ...args], {
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME!, ...env },
    encoding: "utf8",
  });
  const ran = (await readdir(bin)).includes("ran");
  return { status: result.status, stderr: result.stderr, stdout: result.stdout, ran };
}

describe("publish.sh", () => {
  it("refuses until both a release remote and a pinning account are configured", async () => {
    const release = await temporaryDirectory();
    const settings: Record<string, string>[] = [{}, { RELEASE_REMOTE: "file:///nowhere" }, { RELEASE_PIN_PROVIDER: "filebase" }];
    for (const env of settings) {
      const result = await runScript("publish.sh", [release], env);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("no release remote or pinning account is configured");
      expect(result.ran).toBe(false);
    }
  });

  it("refuses without the identity that signs the release commit, before any upload or push", async () => {
    const release = await temporaryDirectory();
    const base = { RELEASE_REMOTE: "file:///nowhere", RELEASE_PIN_PROVIDER: "filebase" };
    for (const env of [base, { ...base, RELEASE_GIT_NAME: "zkbfidev" }, { ...base, RELEASE_GIT_EMAIL: "release@example.org" }]) {
      const result = await runScript("publish.sh", [release], env);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("set RELEASE_GIT_NAME and RELEASE_GIT_EMAIL");
      expect(result.ran).toBe(false);
    }
  });

  it("refuses a release that does not verify, before any upload or push", async () => {
    const release = await temporaryDirectory();
    const result = await runScript("publish.sh", [release], {
      RELEASE_CHANNEL: "stable",
      RELEASE_REMOTE: "file:///nowhere",
      RELEASE_GIT_NAME: "zkbfidev",
      RELEASE_GIT_EMAIL: "release@example.org",
      RELEASE_PIN_PROVIDER: "filebase",
      FILEBASE_ACCESS_KEY: "a",
      FILEBASE_SECRET_KEY: "b",
      FILEBASE_BUCKET: "c",
      FILEBASE_ENDPOINT: "http://127.0.0.1:9",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("release NOT verified");
    expect(result.ran).toBe(false);
  });

  it("prints usage without a directory", async () => {
    expect((await runScript("publish.sh", [])).status).toBe(2);
  });
});

describe("publish-pages.sh", () => {
  it("refuses without the landing project name", async () => {
    const release = await temporaryDirectory();
    const result = await runScript("publish-pages.sh", [release]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no Cloudflare Pages project is configured (set RELEASE_PAGES_LANDING)");
    expect(result.ran).toBe(false);
  });

  it("refuses a release that does not verify, and never starts wrangler", async () => {
    const release = await temporaryDirectory();
    await writeTree(release, { "version.json": "{}", "version.json.sig": "x" });
    const result = await runScript("publish-pages.sh", [release], { RELEASE_CHANNEL: "stable", RELEASE_PAGES_LANDING: "landing" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the release does not verify, so nothing is deployed");
    expect(result.ran).toBe(false);
  });

  it("prints usage without a directory", async () => {
    expect((await runScript("publish-pages.sh", [])).status).toBe(2);
  });
});

describe("channels: the operator's intent, never the artifact's", () => {
  const nextManifest = JSON.stringify({ schema: 1, sequence: 1, channels: { next: "0.1.2-next.1" }, releases: [], downloads: [] });
  const stableManifest = JSON.stringify({ schema: 1, sequence: 1, channels: { stable: "0.1.2" }, releases: [], downloads: [] });
  const publishBase = { RELEASE_REMOTE: "file:///nowhere", RELEASE_PIN_PROVIDER: "kubo", RELEASE_GIT_NAME: "zkbfidev", RELEASE_GIT_EMAIL: "release@example.org" };

  async function releaseNaming(manifest: string) {
    const release = await temporaryDirectory();
    await writeTree(release, { "version.json": manifest, "version.json.sig": "x" });
    return release;
  }

  it("publish-pages.sh refuses without RELEASE_CHANNEL", async () => {
    const result = await runScript("publish-pages.sh", [await releaseNaming(nextManifest)], { RELEASE_PAGES_LANDING: "zkb-fi-next" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no release channel is set (set RELEASE_CHANNEL to stable or next)");
    expect(result.ran).toBe(false);
  });

  it("publish-pages.sh refuses a release that names another channel than RELEASE_CHANNEL", async () => {
    const result = await runScript("publish-pages.sh", [await releaseNaming(nextManifest)], { RELEASE_CHANNEL: "stable", RELEASE_PAGES_LANDING: "zkb-fi" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('the release names the channel "next" but RELEASE_CHANNEL is stable');
    expect(result.ran).toBe(false);
  });

  it("publish-pages.sh refuses a next release aimed at the production Worker or domains", async () => {
    const release = await releaseNaming(nextManifest);
    const worker = await runScript("publish-pages.sh", [release], { RELEASE_CHANNEL: "next", RELEASE_PAGES_LANDING: "zkb-fi" });
    expect(worker.status).toBe(1);
    expect(worker.stderr).toContain("a next release may not deploy to the Worker zkb-fi");
    const domain = await runScript("publish-pages.sh", [release], { RELEASE_CHANNEL: "next", RELEASE_PAGES_LANDING: "zkb-fi-next", RELEASE_LANDING_DOMAINS: "next.zkb.fi,zkb.fi" });
    expect(domain.status).toBe(1);
    expect(domain.stderr).toContain("a next release may not deploy to zkb.fi");
    expect(worker.ran || domain.ran).toBe(false);
  });

  it("publish-pages.sh refuses a stable release aimed at the staging Worker or domain", async () => {
    const release = await releaseNaming(stableManifest);
    const worker = await runScript("publish-pages.sh", [release], { RELEASE_CHANNEL: "stable", RELEASE_PAGES_LANDING: "zkb-fi-next" });
    expect(worker.status).toBe(1);
    expect(worker.stderr).toContain("a stable release may not deploy to the Worker zkb-fi-next");
    const domain = await runScript("publish-pages.sh", [release], { RELEASE_CHANNEL: "stable", RELEASE_PAGES_LANDING: "zkb-fi", RELEASE_LANDING_DOMAINS: "next.zkb.fi" });
    expect(domain.status).toBe(1);
    expect(domain.stderr).toContain("a stable release may not deploy to next.zkb.fi");
    expect(worker.ran || domain.ran).toBe(false);
  });

  it("publish.sh refuses without RELEASE_CHANNEL, and a release naming another channel", async () => {
    const missing = await runScript("publish.sh", [await releaseNaming(nextManifest)], publishBase);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("no release channel is set");
    const mismatch = await runScript("publish.sh", [await releaseNaming(nextManifest)], { ...publishBase, RELEASE_CHANNEL: "stable" });
    expect(mismatch.status).toBe(1);
    expect(mismatch.stderr).toContain('the release names the channel "next" but RELEASE_CHANNEL is stable');
    expect(missing.ran || mismatch.ran).toBe(false);
  });
});

describe("promote.sh", () => {
  it("prints usage without both directories", async () => {
    expect((await runScript("promote.sh", [])).status).toBe(2);
    expect((await runScript("promote.sh", [await temporaryDirectory()])).status).toBe(2);
  });

  it("refuses a staging release that does not verify against the staging key, before any build, push or deploy", async () => {
    const staging = await temporaryDirectory();
    await writeTree(staging, { "version.json": "{}", "version.json.sig": "x" });
    const result = await runScript("promote.sh", [staging, await temporaryDirectory()]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the staging release does not verify against the staging key, so nothing is promoted");
    expect(result.ran).toBe(false);
  });
});

describe("release.sh", () => {
  it("refuses a channel other than stable or next", async () => {
    const result = await runScript("release.sh", [await temporaryDirectory()], { RELEASE_CHANNEL: "beta" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("RELEASE_CHANNEL must be stable or next, not beta");
  });

  it("refuses a directory that is not empty, and prints usage without one", async () => {
    const release = await temporaryDirectory();
    await writeTree(release, { "old.txt": "x" });
    const result = await runScript("release.sh", [release]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is not empty");
    expect((await runScript("release.sh", [])).status).toBe(2);
  });
});
