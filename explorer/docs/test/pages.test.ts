import { describe, expect, it } from "vitest";
import type { Block, Inline } from "@web/docs/markdown";
import { collectPages, findUnresolvedLinks, joinPath, routeOf, SITE_INPUT, SITE_PAGES, type DocsSiteInput } from "../src/pages";

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
    expect(linksIn(notes?.blocks ?? [])).toEqual(["#/tools"]);
  });

  it("a relative .md link becomes a hash route, with the heading after a second hash", () => {
    const [first] = collectPages(small());
    expect(linksIn(first?.blocks ?? [])).toEqual(["#/help/second#part", "#/tools"]);
  });

  it("a link to a file above the published folders becomes plain text, and an anchor link points into its own page", () => {
    const tools = collectPages(small()).find((page) => page.id === "tools");
    expect(linksIn(tools?.blocks ?? [])).toEqual(["#/tools#tools"]);
    expect(JSON.stringify(tools?.blocks)).toContain("readme");
  });

  it("keeps an https link and turns a link to a missing page or heading into text", () => {
    const pages = collectPages(small({ operatorPages: { "../../../docs/a.md": "# A\n\n[x](https://example.org) [y](nowhere.md) [z](tools.md#nothing) [w](a.md#a)" } }));
    expect(linksIn(pages.find((page) => page.id === "a")?.blocks ?? [])).toEqual(["https://example.org", "#/a#a"]);
  });

  it("rewrites links inside bold text, lists, tables and quotes", () => {
    const [page] = collectPages({ userPages: { "01-a.md": "# A\n\n**[x](01-a.md#a)**\n\n- [y](01-a.md)\n\n> [q](01-a.md)\n\n| h |\n|---|\n| [t](01-a.md) |\n\n| [h2](01-a.md) |\n|---|\n| c |" }, operatorPages: {} });
    const text = JSON.stringify(page?.blocks);
    expect(text.match(/"href":"#\/help\/a/g)).toHaveLength(5);
    expect(text).not.toContain("01-a.md");
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

describe("joinPath and routeOf", () => {
  it("joins onto the folder of the page and removes dot segments", () => {
    expect(joinPath("audit/notes.md", "../tools.md")).toBe("tools.md");
    expect(joinPath("audit/notes.md", "./x//y.md")).toBe("audit/x/y.md");
    expect(joinPath("a.md", "../../b.md")).toBe("../../b.md");
    expect(joinPath("a/b/c.md", "../../../d.md")).toBe("../d.md");
  });

  it("builds a route with and without a heading", () => {
    expect(routeOf("tools", "")).toBe("#/tools");
    expect(routeOf("tools", "top")).toBe("#/tools#top");
  });
});

describe("the real pages", () => {
  it("every link between pages resolves", () => {
    expect(findUnresolvedLinks(SITE_INPUT)).toEqual([]);
  });

  it("every link in the built pages is an https address or a route of an existing page", () => {
    const ids = new Set(SITE_PAGES.map((page) => page.id));
    const hrefs = SITE_PAGES.flatMap((page) => linksIn(page.blocks));
    for (const href of hrefs) {
      const isRoute = href.startsWith("#/") && ids.has(href.slice(2).split("#")[0] as string);
      expect(isRoute || href.startsWith("https:"), href).toBe(true);
    }
  });

  it("publishes the help pages and the operator documents, and nothing from docs/superpowers", () => {
    const ids = SITE_PAGES.map((page) => page.id);
    expect(ids).toContain("help/getting-started");
    expect(ids).toContain("audit/known-issues");
    expect(ids.filter((id) => id.startsWith("superpowers"))).toEqual([]);
    expect(Object.keys(SITE_INPUT.operatorPages).filter((key) => key.includes("superpowers"))).toEqual([]);
  });
});
