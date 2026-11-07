// @vitest-environment node
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { checkAddresses } from "../machine/address-check";
import { machineDocsPlugin } from "../machine/plugin";
import { buildMachineFiles, readMachineContent, type MachineSources } from "../machine/site-files";

const fixture = (path: string): string => fileURLToPath(new URL(`./fixtures/machine/${path}`, import.meta.url));
const sources: MachineSources = {
  pagesFolder: fixture("pages"),
  skillsFolder: fixture("skills"),
  docsFolder: fixture("operator"),
  publicPagesFile: fixture("public-pages.json"),
  deploymentsFolder: fixture("deployments"),
};

describe("readMachineContent", () => {
  it("reads help pages, public operator pages and skills, with placeholders resolved", () => {
    const { pages, skills } = readMachineContent(sources);
    expect(pages.map((page) => [page.slug, page.group])).toEqual([["first", "help"], ["ops", "operator"]]);
    expect(pages[0]?.text).toContain("`0x1111111111111111111111111111111111111111`");
    expect(pages[0]?.text).toContain("SepETH");
    expect(pages[0]?.text).not.toContain("{{");
    expect(skills.map((skill) => skill.name)).toEqual(["example-skill"]);
  });

  it("reads a skill kept as skills/<name>.md as well as skills/<name>/SKILL.md", () => {
    const flat = { ...sources, skillsFolder: fixture("skills-flat") };
    expect(readMachineContent(flat).skills.map((skill) => skill.name)).toEqual(["flat-skill"]);
  });

  it("names the file when its front matter is wrong", () => {
    expect(() => readMachineContent({ ...sources, pagesFolder: fixture("bad-pages") })).toThrow(/01-bad\.md: the file has no front matter/);
  });

  it("refuses a skill whose folder and name differ", () => {
    expect(() => readMachineContent({ ...sources, skillsFolder: fixture("bad-skills") })).toThrow(/folder "other-name" but its name is "wrong-name"/);
  });
});

describe("buildMachineFiles", () => {
  const files = buildMachineFiles(sources);

  it("emits the pages, the skills, both llms files and the data files", () => {
    expect([...files.keys()].sort()).toEqual([
      "data/chains.json",
      "data/contracts.json",
      "data/openapi/backend.json",
      "data/openapi/indexer.json",
      "docs/first.md",
      "docs/ops.md",
      "docs/skills/example-skill/SKILL.md",
      "llms-full.txt",
      "llms.txt",
    ]);
  });

  it("keeps the front matter in a page source, and gives a skill only name and description", () => {
    expect(files.get("docs/first.md")).toMatch(/^---\ntitle: First page\n/);
    expect(files.get("docs/skills/example-skill/SKILL.md")).toBe(
      '---\nname: example-skill\ndescription: "A fixture skill for the tests."\n---\n\n# Example skill\n\nSteps for an assistant.\n',
    );
  });

  it("llms.txt follows llmstxt.org with relative links to every page and skill", () => {
    const text = files.get("llms.txt") as string;
    expect(text).toMatch(/^# zkb\.fi\n\n> .+\n/);
    expect(text).toContain("- [First page](docs/first.md): A fixture page: what it says, in one line.");
    expect(text).toContain("- [Ops page](docs/ops.md): A fixture operator page.");
    expect(text).toContain("- [Example skill](docs/skills/example-skill/SKILL.md): A fixture skill for the tests.");
    expect(text).toContain("(data/contracts.json)");
    expect(text).toContain("(data/openapi/indexer.json)");
    for (const link of text.matchAll(/\]\(([^)]+)\)/g)) {
      expect(link[1]).not.toMatch(/^\/|^https?:/);
      expect(files.has(link[1] as string)).toBe(true);
    }
  });

  it("llms-full.txt holds every page and skill with its source path and no front matter", () => {
    const text = files.get("llms-full.txt") as string;
    expect(text).toContain("Source: docs/first.md");
    expect(text).toContain("Source: docs/skills/example-skill/SKILL.md");
    expect(text).toContain("# Ops page");
    expect(text).not.toContain("verified_release");
  });

  it("never holds a private page", () => {
    for (const [path, content] of files) {
      expect(path).not.toContain("secret");
      expect(content).not.toContain("SECRET-PRIVATE-MARKER");
    }
  });

  it("the data files are JSON", () => {
    expect(JSON.parse(files.get("data/contracts.json") as string).chains["943"].bridge).toBe("0x8888888888888888888888888888888888888888");
    expect(JSON.parse(files.get("data/openapi/indexer.json") as string).openapi).toBe("3.1.0");
  });
});

describe("the build plugin", () => {
  it("puts the files in the dist next to the page and serves the facts as a module", async () => {
    const root = mkdtempSync(join(tmpdir(), "machine-docs-"));
    writeFileSync(join(root, "entry.js"), 'import facts from "virtual:docs-facts";\nexport default facts.contracts.chains["943"].bridge;\n');
    const result = await build({
      configFile: false,
      root,
      logLevel: "silent",
      plugins: [machineDocsPlugin({ repositoryRoot: root, sources })],
      build: { write: false, rollupOptions: { input: join(root, "entry.js") } },
    });
    const output = (Array.isArray(result) ? result[0] : result) as { output: { fileName: string; type: string; code?: string }[] };
    const names = output.output.map((item) => item.fileName);
    expect(names).toEqual(expect.arrayContaining(["llms.txt", "llms-full.txt", "docs/first.md", "docs/ops.md", "docs/skills/example-skill/SKILL.md", "data/chains.json", "data/contracts.json", "data/openapi/indexer.json", "data/openapi/backend.json"]));
    expect(names.filter((name) => name.startsWith("docs/")).sort()).toEqual(["docs/first.md", "docs/ops.md", "docs/skills/example-skill/SKILL.md"]);
    expect(output.output.find((item) => item.type === "chunk")?.code).toContain("0x8888888888888888888888888888888888888888");
  });
});

describe("checkAddresses", () => {
  const known = new Set(["0x1111111111111111111111111111111111111111"]);
  const examples = new Set(["0xca11bde05977b3631167028862be2a173976ca11"]);

  it("passes addresses that match a contract or an example, in any letter case", () => {
    const text = "bridge 0x1111111111111111111111111111111111111111 and 0xcA11bde05977b3631167028862bE2a173976CA11";
    expect(checkAddresses([{ path: "a.md", text }], known, examples)).toEqual([]);
  });

  it("reports an unknown address with its file and line, and ignores 32 byte hashes", () => {
    const text = `ok\nwrong 0x2222222222222222222222222222222222222222 here\nhash 0x${"ab".repeat(32)}`;
    expect(checkAddresses([{ path: "a.md", text }], known, examples)).toEqual(["a.md:2: 0x2222222222222222222222222222222222222222 is not in contracts.json and is not a listed example address"]);
  });
});
