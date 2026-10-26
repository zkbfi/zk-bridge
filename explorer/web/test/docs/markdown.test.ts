import { describe, expect, it } from "vitest";
import { DOC_PAGES, findDocPage, parseDocPages } from "../../src/docs/docs-index";
import { parseInline, parseMarkdown, slugify } from "../../src/docs/markdown";

describe("parseMarkdown", () => {
  it("reads headings with identifiers, paragraphs, lists, tables and code", () => {
    const blocks = parseMarkdown(["# Title", "", "Some **bold** and `code` text.", "", "- one", "- two", "", "1. first", "2. second", "", "| A | B |", "|---|---|", "| 1 | 2 |", "", "```", "raw", "```"].join("\n"));
    expect(blocks.map((block) => block.kind)).toEqual(["heading", "paragraph", "list", "list", "table", "code"]);
    expect(blocks[0]).toMatchObject({ kind: "heading", level: 1, id: "title", text: "Title" });
    expect(blocks[3]).toMatchObject({ kind: "list", ordered: true });
    expect(blocks[4]).toMatchObject({ kind: "table" });
  });

  it("joins the lines of one paragraph", () => {
    const blocks = parseMarkdown("one\ntwo\n\nthree");
    expect(blocks).toHaveLength(2);
  });

  it("never turns text into markup: a tag stays text", () => {
    const [block] = parseMarkdown("<script>alert(1)</script>");
    expect(block).toEqual({ kind: "paragraph", children: [{ kind: "text", text: "<script>alert(1)</script>" }] });
  });
});

describe("parseInline", () => {
  it("reads bold, italic and code", () => {
    expect(parseInline("a **b** *c* `d`").map((item) => item.kind)).toEqual(["text", "bold", "text", "italic", "text", "code"]);
  });
});

describe("slugify", () => {
  it("makes a stable identifier", () => {
    expect(slugify("The data source line")).toBe("the-data-source-line");
    expect(slugify("Gas multiplier with a ceiling")).toBe("gas-multiplier-with-a-ceiling");
  });
});

describe("the documentation pages", () => {
  const slugs = DOC_PAGES.map((page) => page.slug);

  it("holds every page of the brief, in reading order", () => {
    expect(slugs).toEqual(["getting-started", "how-the-bridge-works", "bridging-tokens", "sending-messages", "fees-explained", "safety", "running-a-bot", "glossary"]);
  });

  it("gives every page a title and at least two headings that the palette can find", () => {
    for (const page of DOC_PAGES) {
      expect(page.title.length).toBeGreaterThan(2);
      expect(page.headings.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("explains exact versus estimate and the fee schedule where a reader looks for them", () => {
    const fees = findDocPage("fees-explained")!;
    const headings = fees.headings.map((heading) => heading.text.toLowerCase()).join("|");
    expect(headings).toContain("exact and estimate");
    expect(headings).toContain("schedule");
    expect(headings).toContain("data source");
  });

  it("uses no acronym that the owner forbade in prose", () => {
    const forbidden = [/\bAMB\b/, /\bSTE\b/, /\bUR4A\b/, /\bPR\b/, /\bRPC\b(?!\s+endpoint)/];
    const text = DOC_PAGES.flatMap((page) => page.blocks.map((block) => JSON.stringify(block))).join("\n");
    for (const pattern of forbidden) expect(text).not.toMatch(pattern);
  });

  it("holds no email address, no home path and no key-like value", () => {
    const source = Object.values(import.meta.glob("../../docs/pages/*.md", { query: "?raw", import: "default", eager: true })).join("\n");
    expect(source).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(source).not.toMatch(/\/Users\//);
    expect(source).not.toMatch(/0x[0-9a-fA-F]{64}/);
  });

  it("rejects a file that has no order number or no title", () => {
    expect(() => parseDocPages({ "/x/readme.md": "# T" })).toThrow(/needs a name/);
    expect(() => parseDocPages({ "/x/01-a.md": "no heading" })).toThrow(/no title/);
  });
});
