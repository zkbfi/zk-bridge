/**
 * The machine-readable side of the docs: for every public page a Markdown file with its front matter, for every skill
 * a `SKILL.md` in the Anthropic Agent Skills format, `llms.txt` and `llms-full.txt` (llmstxt.org), and the data files of
 * the release (`chains.json`, `contracts.json`, two OpenAPI documents). All of it comes from the same sources as the
 * pages of the dapp, through the same public list, so a private page never reaches it.
 *
 * Skills live in `explorer/web/docs/skills/`, either as `<name>/SKILL.md` or as `<name>.md`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readAllowlist } from "../public-pages.ts";
import { slugOfPageId } from "../../web/src/docs/slug.ts";
import { allContractAddresses, loadFactsFrom, resolvePlaceholders, type Facts } from "./facts.ts";
import { readFrontMatter, type Audience, type FrontMatter } from "./front-matter.ts";
import { buildBackendSpec, buildIndexerSpec } from "./openapi.ts";

/** Where the sources are. */
export type MachineSources = {
  /** `explorer/web/docs/pages`: the help pages, named `01-name.md`. */
  readonly pagesFolder: string;
  /** `explorer/web/docs/skills`: the skills. A folder that does not exist means no skills. */
  readonly skillsFolder: string;
  /** The repository's `docs/` folder, for the operator pages that the list names. */
  readonly docsFolder: string;
  /** `explorer/docs/public-pages.json`. */
  readonly publicPagesFile: string;
  /** `deploy/deployments`. */
  readonly deploymentsFolder: string;
};

/** The sources of this repository. */
export const defaultSources = (repositoryRoot: string): MachineSources => ({
  pagesFolder: join(repositoryRoot, "explorer/web/docs/pages"),
  skillsFolder: join(repositoryRoot, "explorer/web/docs/skills"),
  docsFolder: join(repositoryRoot, "docs"),
  publicPagesFile: join(repositoryRoot, "explorer/docs/public-pages.json"),
  deploymentsFolder: join(repositoryRoot, "deploy/deployments"),
});

/** One page, ready to publish. */
export type MachinePage = {
  /** The address part: `fees-explained`, or `audit/known-issues` for an operator page. */
  readonly slug: string;
  readonly group: "help" | "operator";
  /** The file the page was read from, relative to its folder, for messages. */
  readonly file: string;
  readonly meta: FrontMatter;
  /** The body, with placeholders resolved. */
  readonly body: string;
  /** The whole file, front matter included, with placeholders resolved. */
  readonly text: string;
};

/** One skill, ready to publish. */
export type MachineSkill = { readonly name: string; readonly file: string; readonly meta: FrontMatter; readonly body: string };

/** Everything read from the sources. */
export type MachineContent = {
  readonly pages: readonly MachinePage[];
  readonly skills: readonly MachineSkill[];
  readonly facts: Facts;
  /** The text of every source as written, for the address check. */
  readonly rawSources: readonly { readonly path: string; readonly text: string }[];
};

const listMarkdown = (folder: string): string[] => (existsSync(folder) ? readdirSync(folder).filter((file) => file.endsWith(".md")).sort() : []);

/**
 * Reads, validates and resolves every source.
 *
 * @param sources Where the sources are.
 * @throws With the file name, when a file's front matter is wrong, a placeholder names nothing, or two files make the same address.
 */
export const readMachineContent = (sources: MachineSources): MachineContent => {
  const facts = loadFactsFrom(sources.deploymentsFolder);
  const rawSources: { path: string; text: string }[] = [];
  const read = (file: string, label: string) => {
    const raw = readFileSync(file, "utf8");
    rawSources.push({ path: label, text: raw });
    const resolved = resolvePlaceholders(raw, facts, label);
    return { raw, resolved, ...readFrontMatter(resolved, label) };
  };

  const pages: MachinePage[] = [];
  for (const file of listMarkdown(sources.pagesFolder)) {
    const match = /^(\d+)-(.+)\.md$/.exec(file);
    if (match === null) throw new Error(`The help file "${file}" needs a name like 01-getting-started.md.`);
    const parsed = read(join(sources.pagesFolder, file), file);
    if (parsed.meta.kind === "skill") throw new Error(`${file}: a skill belongs in the skills folder`);
    pages.push({ slug: slugOfPageId(`help/${match[2]}`), group: "help", file, meta: parsed.meta, body: parsed.body, text: parsed.resolved });
  }
  for (const path of readAllowlist(JSON.parse(readFileSync(sources.publicPagesFile, "utf8")) as unknown)) {
    const parsed = read(join(sources.docsFolder, path), `docs/${path}`);
    pages.push({ slug: path.replace(/\.md$/, ""), group: "operator", file: path, meta: parsed.meta, body: parsed.body, text: parsed.resolved });
  }
  const slugs = new Set<string>();
  for (const page of pages) {
    if (slugs.has(page.slug) || page.slug === "skills" || page.slug.startsWith("skills/")) throw new Error(`Two files make the address "docs/${page.slug}.md" (or it sits in the skills folder).`);
    slugs.add(page.slug);
  }

  const skills: MachineSkill[] = [];
  const skillFiles: { name: string; file: string; path: string }[] = [];
  if (existsSync(sources.skillsFolder)) {
    for (const entry of readdirSync(sources.skillsFolder, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isDirectory() && existsSync(join(sources.skillsFolder, entry.name, "SKILL.md"))) skillFiles.push({ name: entry.name, file: `${entry.name}/SKILL.md`, path: join(sources.skillsFolder, entry.name, "SKILL.md") });
      else if (entry.isFile() && entry.name.endsWith(".md")) skillFiles.push({ name: entry.name.replace(/\.md$/, ""), file: entry.name, path: join(sources.skillsFolder, entry.name) });
    }
  }
  for (const item of skillFiles) {
    const parsed = read(item.path, `skills/${item.file}`);
    if (parsed.meta.kind !== "skill" || parsed.meta.name === undefined) throw new Error(`skills/${item.file}: a skill needs kind: skill and a name`);
    if (parsed.meta.name !== item.name) throw new Error(`skills/${item.file}: the skill is in the folder "${item.name}" but its name is "${parsed.meta.name}"`);
    if (skills.some((skill) => skill.name === item.name)) throw new Error(`Two files make the skill "${item.name}".`);
    skills.push({ name: item.name, file: item.file, meta: parsed.meta, body: parsed.body });
  }
  return { pages, skills, facts, rawSources };
};

const skillText = (skill: MachineSkill): string => `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.meta.summary)}\n---\n\n${skill.body.trim()}\n`;

const AUDIENCE_SECTIONS: readonly { readonly audience: Audience; readonly title: string }[] = [
  { audience: "user", title: "Using the bridge" },
  { audience: "deliverer", title: "Delivering transfers" },
  { audience: "operator", title: "Running and operating" },
  { audience: "integrator", title: "Integrating with the SDK and the APIs" },
];

/** The title of the site in both text files. */
const SITE_TITLE = "zkb.fi";
const SITE_SUMMARY =
  "zkb.fi is a bridge between Ethereum and PulseChain that needs no validators and no signers: each chain checks the other with a light client and a zero-knowledge proof. These files are its documentation as Markdown, with machine-readable facts about the chains and contracts.";

/**
 * The text of `llms.txt`: the title, a summary, and one section per audience that links every page with its one-line
 * summary, then the skills and the data files. Links are relative, so they work at the root of a domain and under an
 * IPFS gateway path alike.
 */
export const buildLlmsTxt = (content: MachineContent): string => {
  const lines = [`# ${SITE_TITLE}`, "", `> ${SITE_SUMMARY}`, "", "Every page below is plain Markdown with a front matter block (title, summary, audience, chains, verified_release). Links are relative to this file.", ""];
  const placed = new Set<MachinePage>();
  for (const section of AUDIENCE_SECTIONS) {
    const members = content.pages.filter((page) => !placed.has(page) && page.meta.audience[0] === section.audience);
    if (members.length === 0) continue;
    lines.push(`## ${section.title}`, "");
    for (const page of members) {
      placed.add(page);
      lines.push(`- [${page.meta.title}](docs/${page.slug}.md): ${page.meta.summary}`);
    }
    lines.push("");
  }
  if (content.skills.length > 0) {
    lines.push("## Skills", "", "Agent Skills (SKILL.md files) that an assistant can load to carry out a task with the bridge.", "");
    for (const skill of content.skills) lines.push(`- [${skill.meta.title}](docs/skills/${skill.name}/SKILL.md): ${skill.meta.summary}`);
    lines.push("");
  }
  lines.push(
    "## Data",
    "",
    "- [chains.json](data/chains.json): The chains: ids, names, native coin, explorers and slot and finality timing.",
    "- [contracts.json](data/contracts.json): The deployed contracts of each pair, per chain, with the test tokens.",
    "- [indexer.json](data/openapi/indexer.json): OpenAPI 3.1 description of the indexer API.",
    "- [backend.json](data/openapi/backend.json): OpenAPI 3.1 description of the backend API.",
    "",
    "## Optional",
    "",
    "- [llms-full.txt](llms-full.txt): Every page and skill above in one file.",
    "",
  );
  return lines.join("\n");
};

/** The text of `llms-full.txt`: every page, then every skill, each under its own heading with its source path. */
export const buildLlmsFullTxt = (content: MachineContent): string => {
  const parts = [`# ${SITE_TITLE}\n\n> ${SITE_SUMMARY}\n`];
  for (const page of content.pages) parts.push(`Source: docs/${page.slug}.md\nAudience: ${page.meta.audience.join(", ")}\n\n${page.body.trim()}\n`);
  for (const skill of content.skills) parts.push(`Source: docs/skills/${skill.name}/SKILL.md\nAudience: ${skill.meta.audience.join(", ")}\n\n${skill.body.trim()}\n`);
  return `${parts.join("\n---\n\n")}`;
};

const asJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Every file of a release, by published path. */
export const filesOfContent = (content: MachineContent): Map<string, string> => {
  const files = new Map<string, string>();
  for (const page of content.pages) files.set(`docs/${page.slug}.md`, page.text.endsWith("\n") ? page.text : `${page.text}\n`);
  for (const skill of content.skills) files.set(`docs/skills/${skill.name}/SKILL.md`, skillText(skill));
  files.set("llms.txt", buildLlmsTxt(content));
  files.set("llms-full.txt", buildLlmsFullTxt(content));
  files.set("data/chains.json", asJson(content.facts.chains));
  files.set("data/contracts.json", asJson(content.facts.contracts));
  files.set("data/openapi/indexer.json", asJson(buildIndexerSpec()));
  files.set("data/openapi/backend.json", asJson(buildBackendSpec()));
  return files;
};

/**
 * Builds every machine-readable file.
 *
 * @param sources Where the sources are.
 * @returns The files by published path, relative to the root of the dapp (next to `index.html`).
 */
export const buildMachineFiles = (sources: MachineSources): Map<string, string> => filesOfContent(readMachineContent(sources));

export { allContractAddresses };
