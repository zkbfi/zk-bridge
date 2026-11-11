// @vitest-environment node
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkDist, checkMachineDocs } from "../machine/check";
import { deployment, pageText, sourcesOf, writeTree } from "./machine-tree";
import { buildMachineFiles, defaultSources, type MachineSources } from "../machine/site-files";

const fixture = (path: string): string => fileURLToPath(new URL(`./fixtures/machine/${path}`, import.meta.url));
const examplesFile = fileURLToPath(new URL("../machine/example-addresses.json", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const sources: MachineSources = {
  pagesFolder: fixture("pages"),
  skillsFolder: fixture("skills"),
  docsFolder: fixture("operator"),
  publicPagesFile: fixture("public-pages.json"),
  deploymentsFolder: fixture("deployments"),
};

describe("checkMachineDocs", () => {
  it("passes the fixture", () => {
    expect(checkMachineDocs(sources, { examplesFile })).toEqual([]);
  });

  it("passes the real pages, skills and deployments of the repository", () => {
    expect(checkMachineDocs(defaultSources(repositoryRoot), { examplesFile })).toEqual([]);
  });

  it("reports an address in prose that contracts.json does not hold", () => {
    const root = mkdtempSync(join(tmpdir(), "machine-check-"));
    cpSync(fixture("pages"), join(root, "pages"), { recursive: true });
    writeFileSync(join(root, "pages/02-wrong.md"), '---\ntitle: Wrong\nsummary: x\naudience: user\nchains: all\nverified_release: 0.1.0\n---\n\n# Wrong\n\nSend to 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef now.\n');
    const problems = checkMachineDocs({ ...sources, pagesFolder: join(root, "pages") }, { examplesFile });
    expect(problems).toEqual(["02-wrong.md:11: 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef is not in contracts.json and is not a listed example address"]);
  });

  it("reports front matter that fails the schema, naming the file", () => {
    expect(checkMachineDocs({ ...sources, pagesFolder: fixture("bad-pages") }, { examplesFile })[0]).toMatch(/^01-bad\.md:/);
  });
});

describe("checkDist", () => {
  const write = (files: ReadonlyMap<string, string>, extra: Record<string, string> = {}): string => {
    const root = mkdtempSync(join(tmpdir(), "machine-dist-"));
    for (const [path, text] of [...files, ...Object.entries(extra)]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  };
  const expected = buildMachineFiles(sources);

  it("accepts a dist with exactly the expected files", () => {
    expect(checkDist(write(expected, { "index.html": "<html></html>" }), expected)).toEqual([]);
  });

  it("reports a missing file, a changed file and a page that must not be there", () => {
    const partial = new Map(expected);
    partial.delete("llms.txt");
    partial.set("docs/ops.md", "changed");
    const dist = write(partial, { "docs/secret.md": "# Secret" });
    expect(checkDist(dist, expected).sort()).toEqual([
      "docs/ops.md in the build differs from its source",
      "the build holds docs/secret.md, which is not a public page, skill or data file",
      "the build is missing llms.txt",
    ]);
  });
});

describe("checkMachineDocs on made sources", () => {
  const emptyExamples = (): string => writeTree({ "examples.json": "{}" }) + "/examples.json";

  it("takes an examples file that lists no addresses", () => {
    const made = sourcesOf({ "pages/01-a.md": pageText(), "deployments/demo.json": deployment() });
    expect(checkMachineDocs(made, { examplesFile: emptyExamples() })).toEqual([]);
  });

  it("reports a page whose summary links a file that the release does not emit", () => {
    const text = pageText().replace('summary: "One line."', 'summary: "See [more](docs/nope.md)."');
    const made = sourcesOf({ "pages/01-a.md": text, "deployments/demo.json": deployment() });
    expect(checkMachineDocs(made, { examplesFile: emptyExamples() })).toEqual(["llms.txt links docs/nope.md, which is not emitted"]);
  });

  it("reports unreadable sources as one problem", () => {
    const made = sourcesOf({ "pages/bad-name.md": pageText(), "deployments/demo.json": deployment() });
    expect(checkMachineDocs(made, { examplesFile: emptyExamples() })).toEqual(['The help file "bad-name.md" needs a name like 01-getting-started.md.']);
  });
});

describe("checkDist on a folder without docs or data", () => {
  it("reports only the files that are missing", () => {
    const dist = writeTree({ "index.html": "x" });
    expect(checkDist(dist, new Map([["llms.txt", "x"]]))).toEqual(["the build is missing llms.txt"]);
  });
});
