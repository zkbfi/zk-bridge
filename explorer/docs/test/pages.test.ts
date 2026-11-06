import { describe, expect, it } from "vitest";
import type { Block, Inline } from "@web/docs/markdown";
import { slugOfPageId } from "@web/docs/slug";
import { collectPages, describePage, findUnresolvedLinks, joinPath, markdownPathOf, routeOf, SITE_INPUT, SITE_PAGES, type DocsSiteInput } from "../src/pages";
import { parseMarkdown } from "@web/docs/markdown";

const small = (overrides: Partial<DocsSiteInput> = {}): DocsSiteInput => ({
  userPages: { "../../web/docs/pages/01-first.md": "# First\n\nSee [second](02-second.md#part) and [tools](../tools.md).", "../../web/docs/pages/02-second.md": "# Second\n\n## Part\n\ntext" },
  operatorPages: { "../../../docs/tools.md": "# Tools\n\nBack to [first](../explorer/web/docs/pages/01-first.md) or the [readme](../README.md) or [here](#tools).", "../../../docs/audit/notes.md": "# Notes\n\n[tools](../tools.md)" },
  ...overrides,
});

const inlinesOf = (blocks: readonly Block[]): Inline[] =>
  blocks.flatMap((block) => (block.kind === "paragraph" || block.kind === "quote" ? [...block.children] : block.kind === "list" ? block.items.flat() : []));
const linksIn = (blocks: readonly Block[]): string[] => inlinesOf(blocks).flatMap((item) => (item.kind === "link" ? [item.href] : []));

describe("collectPages", () => {
  it("puts the help pages first in order of their number, then the operator pages by path", () => {
    expect(collectPages(small()).map((page) => [page.group, page.id, page.title])).toEqual([
      ["help", "help/first", "First"],
      ["help", "help/second", "Second"],
      ["operator", "audit/notes", "Notes"],
      ["operator", "tools", "Tools"],
    ]);
  });

  it("the site leaves out docs/superpowers", () => {
    const pages = collectPages(small({ operatorPages: { "../../../docs/superpowers/plan.md": "# Plan", "docs/superpowers/specs/x.md": "# X", "../../../docs/kept.md": "# Kept" } }));
    expect(pages.map((page) => page.id)).toEqual(["help/first", "help/second", "kept"]);
  });

  it("a link between operator pages becomes a route", () => {
    const notes = collectPages(small()).find((page) => page.id === "audit/notes");
    expect(linksIn(notes?.blocks ?? [])).toEqual(["#/docs/tools"]);
  });

  it("a relative .md link becomes a docs route, with the heading after a slash", () => {
    const [first] = collectPages(small());
    expect(linksIn(first?.blocks ?? [])).toEqual(["#/docs/second/part", "#/docs/tools"]);
  });

  it("a link to a file above the published folders becomes plain text, and an anchor link points into its own page", () => {
    const tools = collectPages(small()).find((page) => page.id === "tools");
    expect(linksIn(tools?.blocks ?? [])).toEqual(["#/docs/tools/tools"]);
    expect(JSON.stringify(tools?.blocks)).toContain("readme");
  });

  it("keeps an https link and turns a link to a missing page or heading into text", () => {
    const pages = collectPages(small({ operatorPages: { "../../../docs/a.md": "# A\n\n[x](https://example.org) [y](nowhere.md) [z](tools.md#nothing) [w](a.md#a)" } }));
    expect(linksIn(pages.find((page) => page.id === "a")?.blocks ?? [])).toEqual(["https://example.org", "#/docs/a/a"]);
  });

  it("rewrites links inside bold text, lists, tables and quotes", () => {
    const [page] = collectPages({ userPages: { "01-a.md": "# A\n\n**[x](01-a.md#a)**\n\n- [y](01-a.md)\n\n> [q](01-a.md)\n\n| h |\n|---|\n| [t](01-a.md) |\n\n| [h2](01-a.md) |\n|---|\n| c |" }, operatorPages: {} });
    const text = JSON.stringify(page?.blocks);
    expect(text.match(/"href":"#\/docs\/a/g)).toHaveLength(5);
    expect(text).not.toContain("01-a.md");
  });

  it("refuses two pages that would share one address", () => {
    expect(() => collectPages({ userPages: { "01-tools.md": "# A" }, operatorPages: { "../../../docs/tools.md": "# B" } })).toThrow(/Two files make the address "tools"/);
  });

  it("lists the headings below the title", () => {
    const second = collectPages(small()).find((page) => page.id === "help/second");
    expect(second?.headings).toEqual([{ id: "part", text: "Part", level: 2 }]);
  });

  it("rejects a help file with no order number and two files that make one page", () => {
    expect(() => collectPages({ userPages: { "readme.md": "# T" }, operatorPages: {} })).toThrow(/needs a name/);
    expect(() => collectPages({ userPages: {}, operatorPages: { "docs/a.md": "# A", "../docs/a.md": "# A again" } })).toThrow(/Two files/);
  });

  it("uses the path as the title of a page with no title", () => {
    expect(collectPages({ userPages: { "01-x.md": "text" }, operatorPages: { "a/b.md": "text" } }).map((page) => page.title)).toEqual(["x", "a/b.md"]);
  });
});

describe("sections and descriptions", () => {
  it("puts operator pages under running it and other help pages under using the bridge", () => {
    const pages = collectPages(small());
    expect(pages.map((page) => [page.id, page.section])).toEqual([
      ["help/first", "use"],
      ["help/second", "use"],
      ["audit/notes", "run"],
      ["tools", "run"],
    ]);
  });

  it("describes a page by the first sentence of its first paragraph", () => {
    expect(describePage(parseMarkdown("# T\n\nThis page explains the fees. More text."))).toBe("Explains the fees.");
    expect(describePage(parseMarkdown("# T\n\nThe bridge charges **no** fee. The rest."))).toBe("The bridge charges no fee.");
    expect(describePage(parseMarkdown("# T\n\n- a list only"))).toBe("");
  });

  it("a link to an operator document that is not published becomes text and is not reported", () => {
    const input = { userPages: { "01-a.md": "# A\n\nSee [the plan](../../../../docs/deployment-plan.md)." }, operatorPages: {} };
    expect(findUnresolvedLinks(input)).toEqual([]);
    expect(JSON.stringify(collectPages(input)[0]?.blocks)).not.toContain("href");
  });
});

describe("joinPath and routeOf", () => {
  it("joins onto the folder of the page and removes dot segments", () => {
    expect(joinPath("audit/notes.md", "../tools.md")).toBe("tools.md");
    expect(joinPath("audit/notes.md", "./x//y.md")).toBe("audit/x/y.md");
    expect(joinPath("a.md", "../../b.md")).toBe("../../b.md");
    expect(joinPath("a/b/c.md", "../../../d.md")).toBe("../d.md");
  });

  it("builds a route with and without a heading", () => {
    expect(routeOf("", "")).toBe("#/docs");
    expect(routeOf("tools", "")).toBe("#/docs/tools");
    expect(routeOf("tools", "top")).toBe("#/docs/tools/top");
    expect(routeOf("help/fees-explained", "top")).toBe("#/docs/fees-explained/top");
    expect(routeOf("audit/known-issues", "top")).toBe("#/docs/audit%2Fknown-issues/top");
  });
});

describe("the real pages (moved here from the dapp's old docs view, with the checks they had)", () => {
  const helpPages = SITE_PAGES.filter((page) => page.group === "help");

  it("holds every help page, in reading order", () => {
    expect(helpPages.map((page) => slugOfPageId(page.id))).toEqual(["getting-started", "how-the-bridge-works", "bridging-tokens", "sending-messages", "fees-explained", "safety", "running-a-bot", "settings-and-explore", "glossary"]);
  });

  it("gives every help page a title and at least two headings that the search can find", () => {
    for (const page of helpPages) {
      expect(page.title.length).toBeGreaterThan(2);
      expect(page.headings.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("explains exact versus estimate and the data source of the tip, and names no bridge fee schedule", () => {
    const headings = (helpPages.find((page) => page.id === "help/fees-explained")?.headings ?? []).map((heading) => heading.text.toLowerCase()).join("|");
    expect(headings).toContain("exact and estimate");
    expect(headings).not.toContain("schedule");
    expect(headings).not.toContain("bridge fee");
    expect(headings).toContain("data source");
  });

  it("uses no acronym that the owner forbade in prose", () => {
    const forbidden = [/\bAMB\b/, /\bSTE\b/, /\bUR4A\b/, /\bPR\b/, /\bRPC\b(?!\s+endpoint)/];
    const text = helpPages.flatMap((page) => page.blocks.map((block) => JSON.stringify(block))).join("\n");
    for (const pattern of forbidden) expect(text).not.toMatch(pattern);
  });

  it("holds no email address, no home path and no key-like value", () => {
    const source = Object.values(SITE_INPUT.userPages).join("\n");
    expect(source).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(source).not.toMatch(/\/Users\//);
    expect(source).not.toMatch(/0x[0-9a-fA-F]{64}/);
  });
});

describe("the real pages", () => {
  it("every link between pages resolves", () => {
    expect(findUnresolvedLinks(SITE_INPUT)).toEqual([]);
  });

  it("every link in the built pages is an https address or a route of an existing page", () => {
    const slugs = new Set(SITE_PAGES.map((page) => slugOfPageId(page.id)));
    const hrefs = SITE_PAGES.flatMap((page) => linksIn(page.blocks));
    for (const href of hrefs) {
      const isRoute = href.startsWith("#/docs/") && slugs.has(decodeURIComponent(href.slice("#/docs/".length).split("/")[0] as string));
      expect(isRoute || href.startsWith("https:"), href).toBe(true);
    }
  });

  it("publishes every help page, and nothing from docs/superpowers", () => {
    const ids = SITE_PAGES.map((page) => page.id);
    expect(ids).toContain("help/getting-started");
    expect(ids.filter((id) => id.startsWith("help/"))).toHaveLength(9);
    expect(ids.filter((id) => id.startsWith("superpowers"))).toEqual([]);
    expect(Object.keys(SITE_INPUT.operatorPages).filter((key) => key.includes("superpowers"))).toEqual([]);
  });

  it("every page has a description and a reading time", () => {
    for (const page of SITE_PAGES) {
      expect(page.description, page.id).not.toBe("");
      expect(page.minutes, page.id).toBeGreaterThanOrEqual(1);
    }
  });

  it("groups the help pages: using the bridge, how it works and what you trust, running it", () => {
    const sectionOf = (id: string) => SITE_PAGES.find((page) => page.id === id)?.section;
    expect(sectionOf("help/getting-started")).toBe("use");
    expect(sectionOf("help/fees-explained")).toBe("use");
    expect(sectionOf("help/how-the-bridge-works")).toBe("trust");
    expect(sectionOf("help/safety")).toBe("trust");
    expect(sectionOf("help/running-a-bot")).toBe("run");
  });

  it("the front matter of a file is not part of the page, and the page gets the address of its Markdown file", () => {
    const source = "---\ntitle: First\nsummary: x\naudience: user\nchains: all\nverified_release: 0.1.0\n---\n\n# First\n\nHello there.";
    const [page] = collectPages({ userPages: { "01-first.md": source }, operatorPages: {} });
    expect(page?.title).toBe("First");
    expect(page?.description).toBe("Hello there.");
    expect(JSON.stringify(page?.blocks)).not.toContain("verified_release");
    expect(page?.slug).toBe("first");
    expect(markdownPathOf("help/first")).toBe("docs/first.md");
    expect(markdownPathOf("audit/known-issues")).toBe("docs/audit/known-issues.md");
  });

  it("every real page holds no placeholder that the build left unresolved and no front matter text", () => {
    for (const source of Object.values(SITE_INPUT.userPages)) expect(source).not.toContain("{{");
    for (const page of SITE_PAGES) expect(JSON.stringify(page.blocks), page.id).not.toContain("verified_release");
  });
});
