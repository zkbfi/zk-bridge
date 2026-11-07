/**
 * The pages of the documentation site, which the dapp loads lazily at `#/docs/<page>(/<heading>)` (the same app serves
 * docs.zkb.fi; see `explorer/web/src/app/docs-host.ts`). The site publishes two sets of Markdown files: the help pages of the dapp
 * (`explorer/web/docs/pages`, every file) and the operator documents named in `explorer/docs/public-pages.json` (none
 * until the owner picks them; no other file in `docs/` reaches the build). A link from one page to another `.md` file
 * becomes a route of the dapp, so the pages work from any path prefix, an IPFS gateway path included.
 */
import { parseMarkdown, type Block, type Inline } from "@web/docs/markdown";
import { slugOfPageId } from "@web/docs/slug";
import publicOperatorPages from "virtual:public-operator-pages";
import docsFacts from "virtual:docs-facts";
import { splitFrontMatter } from "../machine/front-matter";
import { resolvePlaceholders } from "../machine/placeholders";

/** Which set of files a page comes from. */
export type DocsSiteGroup = "help" | "operator";

/** The groups of the front page, in order. */
export type DocsSiteSection = "use" | "trust" | "run";

/** The heading of each group of the front page. */
export const SECTION_TITLES: Readonly<Record<DocsSiteSection, string>> = {
  use: "Using the bridge",
  trust: "How it works and what you trust",
  run: "Running it",
};

export const SECTIONS: readonly DocsSiteSection[] = ["use", "trust", "run"];

/** Help pages that explain the design and the trust rather than a task. Every other help page is about using the bridge. */
const HELP_SECTIONS: Readonly<Record<string, DocsSiteSection>> = {
  "how-the-bridge-works": "trust",
  safety: "trust",
  "running-a-bot": "run",
};

/** One heading below the title of a page. */
export type DocsSiteHeading = { readonly id: string; readonly text: string; readonly level: 2 | 3 | 4 };

/** One page of the site. */
export type DocsSitePage = {
  /** The identifier of the page, such as `help/fees-explained` or `audit/known-issues`. Its address uses the slug (see `slugOfPageId`). */
  readonly id: string;
  /** The address part of the page, and of its Markdown file `docs/<slug>.md` (see `markdownPathOf`). */
  readonly slug: string;
  readonly group: DocsSiteGroup;
  /** The group of the front page that lists it. Operator pages are about running the bridge. */
  readonly section: DocsSiteSection;
  readonly title: string;
  /** The first sentence of the first paragraph, for the rows of the front page and search. */
  readonly description: string;
  /** Minutes to read, at 200 words a minute, at least one. */
  readonly minutes: number;
  /** The blocks, with links already turned into routes of the site. */
  readonly blocks: readonly Block[];
  /** The headings below the title. */
  readonly headings: readonly DocsSiteHeading[];
};

/** The files to publish. Each key is a file path and each value is the text of the file. */
export type DocsSiteInput = {
  /** The help pages of the dapp. The file names start with an order number, such as `01-getting-started.md`. */
  readonly userPages: Readonly<Record<string, string>>;
  /** The operator documents, with paths that end in their place below `docs/`, such as `audit/known-issues.md`. */
  readonly operatorPages: Readonly<Record<string, string>>;
};

/** A link that points inside the published folders and finds no page or no heading. */
export type UnresolvedLink = { readonly from: string; readonly href: string };

type SourcePage = {
  readonly id: string;
  readonly group: DocsSiteGroup;
  /** The folder-relative path that links resolve against, such as `help/03-bridging-tokens.md`. */
  readonly path: string;
  readonly title: string;
  readonly blocks: readonly Block[];
};

const UNPUBLISHED_FOLDER = "superpowers/";

/**
 * Cuts the leading `./` and `../` segments from a file path, and then a leading `docs/` folder.
 *
 * @param path The file path.
 */
const placeBelowDocs = (path: string): string => path.replace(/^(?:\.\.?\/)+/, "").replace(/^docs\//, "");

/**
 * Joins a link onto the folder of the page that holds it, and removes `.` and `..` segments.
 *
 * @param fromPath The path of the page that holds the link.
 * @param target The path of the link, with no anchor.
 * @returns The path from the root of the site. A path that climbs above the root starts with `../`.
 */
export const joinPath = (fromPath: string, target: string): string => {
  const segments: string[] = [];
  for (const segment of [...fromPath.split("/").slice(0, -1), ...target.split("/")]) {
    const last = segments[segments.length - 1];
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") segments.push(segment);
    else if (last === undefined || last === "..") segments.push("..");
    else segments.pop();
  }
  return segments.join("/");
};

const titleOf = (blocks: readonly Block[], fallback: string): string => {
  const title = blocks.find((block) => block.kind === "heading" && block.level === 1);
  return title !== undefined && title.kind === "heading" ? title.text : fallback;
};

/** The published Markdown file of a page, relative to the root of the dapp, so it works at every gateway form. */
export const markdownPathOf = (id: string): string => `docs/${slugOfPageId(id)}.md`;

/** The text of a file below its front matter, which the machine-readable files carry and the page does not show. */
const bodyOf = (source: string): string => splitFrontMatter(source).body;

const readUserPage = ([key, source]: readonly [string, string]): SourcePage & { readonly order: number } => {
  const file = key.split("/").pop() as string;
  const match = /^(\d+)-(.+)\.md$/.exec(file);
  if (match === null) throw new Error(`The help file "${key}" needs a name like 01-getting-started.md.`);
  const blocks = parseMarkdown(bodyOf(source));
  return { order: Number(match[1]), id: `help/${match[2]}`, group: "help", path: `help/${file}`, title: titleOf(blocks, match[2] as string), blocks };
};

const readOperatorPage = ([key, source]: readonly [string, string]): SourcePage => {
  const path = placeBelowDocs(key);
  const blocks = parseMarkdown(bodyOf(source));
  return { id: path.replace(/\.md$/, ""), group: "operator", path, title: titleOf(blocks, path), blocks };
};

const readPages = (input: DocsSiteInput): readonly SourcePage[] => {
  const user = Object.entries(input.userPages)
    .map(readUserPage)
    .sort((left, right) => left.order - right.order);
  const operator = Object.entries(input.operatorPages)
    .filter(([key]) => !placeBelowDocs(key).startsWith(UNPUBLISHED_FOLDER))
    .map(readOperatorPage)
    .sort((left, right) => left.path.localeCompare(right.path));
  const pages: readonly SourcePage[] = [...user, ...operator];
  const seen = new Set<string>();
  for (const page of pages) {
    if (seen.has(page.id)) throw new Error(`Two files make the page "${page.id}".`);
    seen.add(page.id);
  }
  // The address of a page is its slug, so two pages with one slug could not both be opened.
  const slugs = new Set<string>();
  for (const page of pages) {
    const slug = slugOfPageId(page.id);
    if (slugs.has(slug)) throw new Error(`Two files make the address "${slug}".`);
    slugs.add(slug);
  }
  return pages;
};

const mapInline = (item: Inline, change: (item: Inline) => readonly Inline[]): readonly Inline[] => {
  if (item.kind === "bold" || item.kind === "italic" || item.kind === "link") {
    return change({ ...item, children: mapInlines(item.children, change) });
  }
  return change(item);
};

const mapInlines = (items: readonly Inline[], change: (item: Inline) => readonly Inline[]): readonly Inline[] =>
  items.flatMap((item) => mapInline(item, change));

const mapBlock = (block: Block, change: (item: Inline) => readonly Inline[]): Block => {
  if (block.kind === "paragraph" || block.kind === "quote") return { ...block, children: mapInlines(block.children, change) };
  if (block.kind === "list") return { ...block, items: block.items.map((item) => mapInlines(item, change)) };
  if (block.kind === "table") {
    return { ...block, header: block.header.map((cell) => mapInlines(cell, change)), rows: block.rows.map((row) => row.map((cell) => mapInlines(cell, change))) };
  }
  return block;
};

/** Every link of the blocks, in reading order. */
const linksOf = (blocks: readonly Block[]): readonly string[] => {
  const hrefs: string[] = [];
  blocks.forEach((block) =>
    mapBlock(block, (item) => {
      if (item.kind === "link") hrefs.push(item.href);
      return [item];
    }),
  );
  return hrefs;
};

/**
 * The address of a page in the dapp, with an optional heading: `#/docs/<slug>` or `#/docs/<slug>/<heading>`. An empty
 * identifier is the front page of the docs, `#/docs`.
 *
 * @param id The page identifier.
 * @param anchor The heading identifier, or an empty text.
 */
export const routeOf = (id: string, anchor: string): string => {
  if (id === "") return "#/docs";
  const page = `#/docs/${encodeURIComponent(slugOfPageId(id))}`;
  return anchor === "" ? page : `${page}/${encodeURIComponent(anchor)}`;
};

type Target = { readonly page: SourcePage; readonly anchor: string };

type Resolution =
  | { readonly kind: "keep" }
  | { readonly kind: "route"; readonly target: Target }
  | { readonly kind: "outside" }
  | { readonly kind: "missing" };

const headingIds = (page: SourcePage): readonly string[] => page.blocks.flatMap((block) => (block.kind === "heading" ? [block.id] : []));

/** Decides what a link of one page points to. */
const resolveLink = (pages: readonly SourcePage[], from: SourcePage, href: string): Resolution => {
  if (href.startsWith("https:")) return { kind: "keep" };
  const hashAt = href.indexOf("#");
  const path = hashAt === -1 ? href : href.slice(0, hashAt);
  const anchor = hashAt === -1 ? "" : href.slice(hashAt + 1);
  const joined = path === "" ? from.path : joinPath(from.path, path);
  if (joined.startsWith("../")) return { kind: "outside" };
  const page = pages.find((candidate) => candidate.path === joined);
  // An operator document that public-pages.json leaves out is not published, so a link to it shows as text.
  if (page === undefined) return joined.startsWith("help/") ? { kind: "missing" } : { kind: "outside" };
  if (anchor !== "" && !headingIds(page).includes(anchor)) return { kind: "missing" };
  return { kind: "route", target: { page, anchor } };
};

const textOf = (items: readonly Inline[]): string =>
  items.map((item) => (item.kind === "text" || item.kind === "code" ? item.text : textOf(item.children))).join("");

/** Every word of the blocks, for the reading time. */
const wordCount = (blocks: readonly Block[]): number =>
  blocks
    .map((block) => {
      if (block.kind === "heading" || block.kind === "code") return block.text;
      if (block.kind === "paragraph" || block.kind === "quote") return textOf(block.children);
      if (block.kind === "list") return block.items.map(textOf).join(" ");
      return [...block.header, ...block.rows.flat()].map(textOf).join(" ");
    })
    .join(" ")
    .split(/\s+/)
    .filter(Boolean).length;

/**
 * The first sentence of the first paragraph. "This page explains how to …" reads as "Explains how to …".
 *
 * @param blocks The blocks of a page.
 */
export const describePage = (blocks: readonly Block[]): string => {
  const first = blocks.find((block) => block.kind === "paragraph");
  if (first === undefined || first.kind !== "paragraph") return "";
  const text = textOf(first.children).trim();
  const sentence = /^.+?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
  const trimmed = sentence.replace(/^This page\s+/, "");
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
};

/** Turns the links of one page into routes. A link with no page behind it becomes plain text. */
const rewriteLinks = (pages: readonly SourcePage[], page: SourcePage): readonly Block[] =>
  page.blocks.map((block) =>
    mapBlock(block, (item): readonly Inline[] => {
      if (item.kind !== "link") return [item];
      const resolution = resolveLink(pages, page, item.href);
      if (resolution.kind === "keep") return [item];
      if (resolution.kind === "route") return [{ ...item, href: routeOf(resolution.target.page.id, resolution.target.anchor) }];
      return item.children;
    }),
  );

/**
 * Reads the files into the pages of the site: the help pages in order of their number, then the operator pages in
 * order of their path. Files below `superpowers/` are left out. A link to another page becomes a route that starts with
 * `#/docs`. A link to a file that the site does not publish becomes plain text. An `https:` link stays a link.
 *
 * @param input The help files and the operator files.
 * @throws When a help file has no order number, or two files make the same page.
 */
export const collectPages = (input: DocsSiteInput): DocsSitePage[] => {
  const pages = readPages(input);
  return pages.map((page) => {
    const blocks = rewriteLinks(pages, page);
    const headings = blocks.flatMap((block): DocsSiteHeading[] =>
      block.kind === "heading" && block.level > 1 ? [{ id: block.id, text: block.text, level: block.level as 2 | 3 | 4 }] : [],
    );
    const section: DocsSiteSection = page.group === "operator" ? "run" : (HELP_SECTIONS[page.id.slice("help/".length)] ?? "use");
    const minutes = Math.max(1, Math.round(wordCount(page.blocks) / 200));
    return { id: page.id, slug: slugOfPageId(page.id), group: page.group, section, title: page.title, description: describePage(page.blocks), minutes, blocks, headings };
  });
};

/**
 * Lists the links that point inside the published folders and find no page or no heading. A link to a file above the
 * published folders, such as the readme of the repository, is not listed: the site shows it as text.
 *
 * @param input The help files and the operator files.
 */
export const findUnresolvedLinks = (input: DocsSiteInput): UnresolvedLink[] => {
  const pages = readPages(input);
  return pages.flatMap((page) =>
    linksOf(page.blocks)
      .filter((href) => resolveLink(pages, page, href).kind === "missing")
      .map((href) => ({ from: page.path, href })),
  );
};

/** The pages of the real files, read when the site is built. */
const withFacts = (pages: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(pages).map(([key, source]) => [key, resolvePlaceholders(source, docsFacts, key)]));

export const SITE_INPUT: DocsSiteInput = {
  // A placeholder such as {{contracts.943.bridge}} is filled from the deployment files (machine/facts.ts), as in the Markdown files.
  userPages: withFacts(import.meta.glob("../../web/docs/pages/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>),
  // Only the files named in public-pages.json; the plugin in public-pages.ts reads them, and refuses any other docs/ import.
  operatorPages: withFacts(publicOperatorPages),
};

/** Every page of the site, in reading order. */
export const SITE_PAGES: readonly DocsSitePage[] = collectPages(SITE_INPUT);
