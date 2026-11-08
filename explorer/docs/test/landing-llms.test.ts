// @vitest-environment node
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildLandingLlmsFullTxt, buildLandingLlmsTxt, checkLandingLlmsTxt, type LandingRelease } from "../machine/landing-llms";
import { buildLlmsFullTxt, defaultSources, filesOfContent, readMachineContent } from "../machine/site-files";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const content = readMachineContent(defaultSources(repositoryRoot));
const emitted = new Set(filesOfContent(content).keys());
const next: LandingRelease = { channel: "next", version: "0.1.2-next.16", dappCid: "bafybeiggwi27xqoo5wu4wnzepydbqr5ipgqc7mbcntmbl3ymqyqdupkohe" };
const stable: LandingRelease = { channel: "stable", version: "1.0.0", dappCid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi" };

describe("landing llms.txt", () => {
  for (const release of [next, stable]) {
    it(`follows the spec and links only emitted files and public hosts (${release.channel})`, () => {
      expect(checkLandingLlmsTxt(buildLandingLlmsTxt(content, release), release, emitted)).toEqual([]);
    });
  }

  it("names every page and skill of the dapp at its CID, so the list cannot drift", () => {
    const text = buildLandingLlmsTxt(content, next);
    for (const page of content.pages) expect(text).toContain(`(https://${next.dappCid}.ipfs.zkb.fi/docs/${page.slug}.md)`);
    for (const skill of content.skills) expect(text).toContain(`(https://${next.dappCid}.ipfs.zkb.fi/docs/skills/${skill.name}/SKILL.md)`);
  });

  it("states the channel and links the right site and key branch", () => {
    const text = buildLandingLlmsTxt(content, next);
    expect(text).toContain("staging");
    expect(text).toContain("(https://next.zkb.fi/version.json)");
    expect(text).toContain("/zkbfi/releases/next/public-keys.json");
    expect(buildLandingLlmsTxt(content, stable)).toContain("(https://zkb.fi/version.json)");
  });

  it("does not link the private repository or a docs page that is not public", () => {
    const text = buildLandingLlmsTxt(content, next);
    expect(text).not.toContain("zkbfi/zk-bridge");
    expect(text).not.toMatch(/superpowers|red-team|redeploy/);
  });

  it("refuses a CID that is not a host-safe string", () => {
    expect(() => buildLandingLlmsTxt(content, { ...next, dappCid: "evil.example/x" })).toThrow();
  });

  it("the checker reports a bad shape, an unknown host, a missing file and http", () => {
    const good = buildLandingLlmsTxt(content, next);
    expect(checkLandingLlmsTxt(good.replace("# zkb.fi", "zkb.fi"), next, emitted)).not.toEqual([]);
    expect(checkLandingLlmsTxt(`${good}- [x](https://evil.example/a): y\n`, next, emitted).join()).toMatch(/not public/);
    expect(checkLandingLlmsTxt(`${good}- [x](https://${next.dappCid}.ipfs.zkb.fi/docs/nope.md): y\n`, next, emitted).join()).toMatch(/does not emit/);
    expect(checkLandingLlmsTxt(`${good}- [x](http://zkb.fi/a): y\n`, next, emitted).join()).toMatch(/not https/);
    expect(checkLandingLlmsTxt(good.replace("## Optional", "## Extra"), next, emitted).join()).toMatch(/Optional/);
  });

  it("llms-full.txt is the index followed by the full docs", () => {
    const full = buildLandingLlmsFullTxt(content, next, buildLlmsFullTxt(content));
    expect(full.startsWith(buildLandingLlmsTxt(content, next))).toBe(true);
    expect(full).toContain("Source: docs/");
  });

  it("the script writes llms.txt, llm.txt and llms-full.txt from a release's version.json", () => {
    const release = mkdtempSync(join(tmpdir(), "rel-"));
    const site = mkdtempSync(join(tmpdir(), "site-"));
    writeFileSync(join(release, "version.json"), JSON.stringify({ releases: [{ name: "dapp", version: next.version, cid: next.dappCid }] }));
    execFileSync("node", [join(repositoryRoot, "explorer/docs/scripts/build-landing-llms.ts"), release, "next", site]);
    expect(readFileSync(join(site, "llm.txt"), "utf8")).toBe(readFileSync(join(site, "llms.txt"), "utf8"));
    expect(readFileSync(join(site, "llms.txt"), "utf8")).toBe(buildLandingLlmsTxt(content, next));
    expect(readFileSync(join(site, "llms-full.txt"), "utf8")).toContain("Source: docs/");
  });
});
