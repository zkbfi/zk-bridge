// @vitest-environment node
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildLandingLlmsFullTxt, buildLandingLlmsTxt, checkLandingLlmsTxt, type LandingRelease } from "../machine/landing-llms";
import { deployment, pageText, sourcesOf } from "./machine-tree";
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

  it("states the channel and links the keys and checksums on the site", () => {
    const text = buildLandingLlmsTxt(content, next);
    expect(text).toContain("staging");
    expect(text).toContain("(https://next.zkb.fi/version.json)");
    expect(text).toContain("(https://next.zkb.fi/public-keys.json)");
    expect(text).toContain("(https://next.zkb.fi/SHA256SUMS)");
    expect(text).not.toContain("raw.githubusercontent.com");
    const stableText = buildLandingLlmsTxt(content, stable);
    expect(stableText).toContain("(https://zkb.fi/version.json)");
    expect(stableText).toContain("(https://zkb.fi/public-keys.json)");
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

  it("lists the index of the dapp under the first heading only, and puts later audiences under their own heading", () => {
    const made = readMachineContent(
      sourcesOf({
        "pages/01-a.md": pageText("User page"),
        "pages/02-b.md": pageText("Operator page").replace("audience: [user]", "audience: [operator]"),
        "pages/03-c.md": pageText("Deliverer page").replace("audience: [user]", "audience: [deliverer]"),
        "deployments/demo.json": deployment(),
      }),
    );
    const text = buildLandingLlmsTxt(made, next);
    expect(text.match(/llms\.txt of the dapp/g)).toHaveLength(1);
    const at = (needle: string): number => text.indexOf(needle);
    expect(at("## Docs: using the bridge")).toBeLessThan(at("llms.txt of the dapp"));
    expect(at("llms.txt of the dapp")).toBeLessThan(at("User page"));
    expect(at("User page")).toBeLessThan(at("## Docs: delivering transfers"));
    expect(at("## Docs: delivering transfers")).toBeLessThan(at("Deliverer page"));
    expect(at("Deliverer page")).toBeLessThan(at("## Docs: running and operating"));
    expect(at("## Docs: running and operating")).toBeLessThan(at("Operator page"));
  });

  it("refuses a version with an unexpected form", () => {
    expect(() => buildLandingLlmsTxt(content, { ...next, version: "1.0 beta" })).toThrow("the version has an unexpected form");
  });

  it("the checker reports a missing title, a second H1, a missing summary, a missing Optional section and an empty section", () => {
    const problems = checkLandingLlmsTxt("no title\n\n# Second\n# Third\nplain text\n\n## Empty\n", next, emitted);
    expect(problems).toEqual([
      "the first line must be an H1 title",
      "there must be exactly one H1",
      "a blockquote summary must follow the title",
      'the section "Empty" has no links',
      "the Optional section is missing",
    ]);
  });

  it("the checker reports a title with nothing after it", () => {
    expect(checkLandingLlmsTxt("# T", next, emitted)).toEqual(["a blockquote summary must follow the title", "the Optional section is missing"]);
  });

  it("the checker reports items that are not links, links without a description, links outside a section and urls that are not absolute", () => {
    const text = [
      "# T",
      "",
      "> s",
      "",
      "- [early](https://zkb.fi/a): outside a section",
      "",
      "## Optional",
      "",
      "- just words",
      "- [no description](https://zkb.fi/a)",
      "- [relative](docs/a.md): not absolute",
      "",
    ].join("\n");
    expect(checkLandingLlmsTxt(text, next, emitted)).toEqual([
      "a link outside a section: - [early](https://zkb.fi/a): outside a section",
      'not a "- [name](url): description" item: - just words',
      "link without a description: - [no description](https://zkb.fi/a)",
      "not an absolute URL: docs/a.md",
    ]);
  });

  it("the checker reports a link to the bare dapp host as fine, and key-shaped text as a problem", () => {
    const good = buildLandingLlmsTxt(content, next);
    expect(checkLandingLlmsTxt(`${good}- [dapp](https://${next.dappCid}.ipfs.zkb.fi/): the app\n`, next, emitted)).toEqual([]);
    expect(checkLandingLlmsTxt(`${good}key=abc ?token=x\n`, next, emitted)).toEqual(["the text holds something key-shaped"]);
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
