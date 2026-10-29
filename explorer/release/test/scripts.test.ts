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

  it("refuses a release that does not verify, before any upload or push", async () => {
    const release = await temporaryDirectory();
    const result = await runScript("publish.sh", [release], {
      RELEASE_REMOTE: "file:///nowhere",
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
    const result = await runScript("publish-pages.sh", [release], { RELEASE_PAGES_LANDING: "landing" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the release does not verify, so nothing is deployed");
    expect(result.ran).toBe(false);
  });

  it("prints usage without a directory", async () => {
    expect((await runScript("publish-pages.sh", [])).status).toBe(2);
  });
});

describe("release.sh", () => {
  it("refuses a directory that is not empty, and prints usage without one", async () => {
    const release = await temporaryDirectory();
    await writeTree(release, { "old.txt": "x" });
    const result = await runScript("release.sh", [release]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is not empty");
    expect((await runScript("release.sh", [])).status).toBe(2);
  });
});
