// @vitest-environment node
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import { publicPagesPlugin, readAllowlist, refusedDocsImport } from "../public-pages";
import { SITE_INPUT, SITE_PAGES } from "../src/pages";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const docsFolder = join(repositoryRoot, "docs");
const folders: string[] = [];
afterEach(() => folders.splice(0).forEach((folder) => rmSync(folder, { recursive: true, force: true })));

/** Builds a one-file entry with the plugin and the given list, and returns the bundled code. */
const buildEntry = async (entry: string | ((root: string) => string), list: unknown): Promise<string> => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "docs-allowlist-")));
  folders.push(root);
  writeFileSync(join(root, "entry.js"), typeof entry === "string" ? entry : entry(root));
  const output = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [publicPagesPlugin({ repositoryRoot, list })],
    build: { write: false, lib: { entry: join(root, "entry.js"), formats: ["es"], fileName: "out" } },
  });
  const results = Array.isArray(output) ? output : [output];
  return results.flatMap((result) => ("output" in result ? result.output : [])).map((chunk) => ("code" in chunk ? chunk.code : "")).join("\n");
};

describe("readAllowlist", () => {
  it("takes Markdown paths below docs/", () => {
    expect(readAllowlist({ operator: [] })).toEqual([]);
    expect(readAllowlist({ operator: ["bots.md", "audit/known-issues.md"] })).toEqual(["bots.md", "audit/known-issues.md"]);
  });

  it("refuses a wrong shape, a path that climbs out, a rooted path, a file that is not Markdown and docs/superpowers", () => {
    expect(() => readAllowlist({})).toThrow(/operator/);
    expect(() => readAllowlist({ operator: [1] })).toThrow(/operator/);
    expect(() => readAllowlist(null)).toThrow(/operator/);
    for (const path of ["../README.md", "a/../b.md", "/etc/x.md", "notes.txt", "a//b.md", "./a.md"]) expect(() => readAllowlist({ operator: [path] }), path).toThrow(/not a Markdown path/);
    expect(() => readAllowlist({ operator: ["superpowers/specs/x.md"] })).toThrow(/never published/);
  });
});

describe("refusedDocsImport", () => {
  it("refuses a docs/ Markdown file outside the list, with or without a query", () => {
    expect(refusedDocsImport(join(docsFolder, "deployment-plan.md?raw"), docsFolder, [])).toBe("deployment-plan.md");
    expect(refusedDocsImport(join(docsFolder, "audit/known-issues.md"), docsFolder, ["bots.md"])).toBe("audit/known-issues.md");
  });

  it("lets through a listed file and anything outside docs/", () => {
    expect(refusedDocsImport(join(docsFolder, "bots.md?raw"), docsFolder, ["bots.md"])).toBeNull();
    expect(refusedDocsImport(join(repositoryRoot, "explorer/web/docs/pages/01-getting-started.md?raw"), docsFolder, [])).toBeNull();
    expect(refusedDocsImport(join(repositoryRoot, "README.md"), docsFolder, [])).toBeNull();
    expect(refusedDocsImport(join(docsFolder, "x.ts"), docsFolder, [])).toBeNull();
  });
});

describe("the build", () => {
  it("fails when the site imports a docs/ page that is not in the list", async () => {
    const page = join(docsFolder, "deployment-plan.md");
    await expect(buildEntry(`import text from ${JSON.stringify(`${page}?raw`)}; console.log(text);`, { operator: [] })).rejects.toThrow(/not in explorer\/docs\/public-pages\.json/);
  });

  it("fails when a glob reaches docs/ pages that are not in the list", async () => {
    const glob = (root: string) => `console.log(import.meta.glob(${JSON.stringify(`${relative(root, docsFolder)}/*.md`)}, { query: "?raw", eager: true }));`;
    await expect(buildEntry(glob, { operator: ["bots.md"] })).rejects.toThrow(/not in explorer\/docs\/public-pages\.json/);
  });

  it("bundles a listed page through the virtual module, and only that page", async () => {
    const code = await buildEntry(`import pages from "virtual:public-operator-pages"; console.log(pages);`, { operator: ["bots.md"] });
    const firstLine = readFileSync(join(docsFolder, "bots.md"), "utf8").split("\n")[0] as string;
    expect(code).toContain(JSON.stringify(firstLine).slice(1, -1));
    expect(code).toContain("docs/bots.md");
    expect(code).not.toContain("docs/deployment-plan.md");
  });

  it("fails when the list names a file that does not exist", async () => {
    await expect(buildEntry(`import pages from "virtual:public-operator-pages"; console.log(pages);`, { operator: ["no-such-page.md"] })).rejects.toThrow(/does not exist/);
  });
});

describe("the real list", () => {
  const list = readAllowlist(JSON.parse(readFileSync(join(repositoryRoot, "explorer/docs/public-pages.json"), "utf8")));

  it("the site's operator pages are exactly the listed files", () => {
    expect(Object.keys(SITE_INPUT.operatorPages).sort()).toEqual(list.map((path) => `docs/${path}`).sort());
    expect(SITE_PAGES.filter((page) => page.group === "operator").map((page) => `${page.id}.md`).sort()).toEqual([...list].sort());
  });

  it("publishes no internal document unless the list names it", () => {
    const ids = SITE_PAGES.map((page) => page.id);
    for (const internal of ["deployment-plan", "audit/known-issues", "superpowers/specs/2026-10-30-dapp-bridge-first-design"]) {
      if (!list.includes(`${internal}.md`)) expect(ids).not.toContain(internal);
    }
  });
});
