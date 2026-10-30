import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { temporaryDirectory, writeTree } from "./helpers.ts";

const checks = fileURLToPath(new URL("../../../script/release/promote-checks.sh", import.meta.url));
const landingRoot = fileURLToPath(new URL("../../landing/", import.meta.url));

/** Runs one function of promote-checks.sh with the real git and node. */
function check(fn: string, ...args: string[]) {
  const result = spawnSync("bash", ["-c", `. "$0"; ${fn} "$@"`, checks, ...args], { encoding: "utf8", env: { ...process.env } });
  return { status: result.status, stderr: result.stderr };
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.org", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

/** A clone whose origin has main (one commit), plus a second commit that exists only on a side branch. */
async function repositories() {
  const origin = await temporaryDirectory();
  git(origin, "init", "--quiet", "--initial-branch=main");
  await writeTree(origin, { "a.txt": "a" });
  git(origin, "add", "a.txt");
  git(origin, "commit", "--quiet", "-m", "a");
  const onMain = git(origin, "rev-parse", "HEAD");
  git(origin, "checkout", "--quiet", "-b", "side");
  await writeTree(origin, { "b.txt": "b" });
  git(origin, "add", "b.txt");
  git(origin, "commit", "--quiet", "-m", "b");
  const offMain = git(origin, "rev-parse", "HEAD");
  git(origin, "checkout", "--quiet", "main");
  const clone = join(await temporaryDirectory(), "clone");
  git(origin, "clone", "--quiet", "--no-single-branch", origin, clone);
  return { clone, onMain, offMain };
}

describe("promote_check_commit", () => {
  it("accepts a full SHA on origin/main", async () => {
    const { clone, onMain } = await repositories();
    expect(check("promote_check_commit", clone, onMain).status).toBe(0);
  });

  it("refuses anything that is not a full 40-character SHA", async () => {
    const { clone, onMain } = await repositories();
    for (const commit of [onMain.slice(0, 7), "--upload-pack=touch", onMain.toUpperCase(), `${onMain}x`]) {
      const result = check("promote_check_commit", clone, commit);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("not a full 40-character SHA");
    }
  });

  it("refuses a commit that is not on origin/main, even when the repository has it", async () => {
    const { clone, offMain } = await repositories();
    const result = check("promote_check_commit", clone, offMain);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`the staging commit ${offMain} is not on origin/main: merge it to main before promoting`);
  });
});

describe("promote_check_landing_keys", () => {
  const production = join(landingRoot, "landing.config.json");
  const staging = join(landingRoot, "landing.next.config.json");

  async function siteWith(publicKeys: JsonWebKey[]) {
    const site = await temporaryDirectory();
    await writeTree(site, { "main.js": `import { startLanding } from "./page.js";\nstartLanding(${JSON.stringify({ title: "x", publicKeys })});\n` });
    return site;
  }

  it("accepts a page that trusts exactly the production keys", async () => {
    const { publicKeys } = JSON.parse(await readFile(production, "utf8")) as { publicKeys: JsonWebKey[] };
    expect(check("promote_check_landing_keys", await siteWith(publicKeys), production, staging).status).toBe(0);
  });

  it("refuses a page that trusts a staging key, or other keys than the production config", async () => {
    const { publicKeys: productionKeys } = JSON.parse(await readFile(production, "utf8")) as { publicKeys: JsonWebKey[] };
    const { publicKeys: stagingKeys } = JSON.parse(await readFile(staging, "utf8")) as { publicKeys: JsonWebKey[] };
    const withStaging = check("promote_check_landing_keys", await siteWith([...productionKeys, ...stagingKeys]), production, staging);
    expect(withStaging.status).toBe(1);
    expect(withStaging.stderr).toContain("would trust a staging key");
    const other = check("promote_check_landing_keys", await siteWith([{ kty: "OKP", crv: "Ed25519", x: "other" }]), production, staging);
    expect(other.status).toBe(1);
    expect(other.stderr).toContain("trusts other keys than landing.config.json");
    const none = check("promote_check_landing_keys", await siteWith([]), production, staging);
    expect(none.status).toBe(1);
  });
});
