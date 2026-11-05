import { describe, expect, it } from "vitest";
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

describe("links", () => {
  const linkTo = (source: string) => parseInline(source).find((item) => item.kind === "link");

  it("a relative .md link becomes a link", () => {
    expect(linkTo("see [the guide](../guide.md#top) now")).toEqual({ kind: "link", href: "../guide.md#top", children: [{ kind: "text", text: "the guide" }] });
  });

  it("an anchor and an https address become links, and the text may hold marks", () => {
    expect(linkTo("[x](#part)")).toMatchObject({ href: "#part" });
    expect(linkTo("[**bold** `c`](https://example.org/a_b_c)")).toEqual({
      kind: "link",
      href: "https://example.org/a_b_c",
      children: [{ kind: "bold", children: [{ kind: "text", text: "bold" }] }, { kind: "text", text: " " }, { kind: "code", text: "c" }],
    });
  });

  it("a javascript: link stays text", () => {
    expect(parseInline("[x](javascript:alert(1))").some((item) => item.kind === "link")).toBe(false);
    expect(parseInline("[x](javascript:alert(1))").map((item) => (item.kind === "text" ? item.text : "")).join("")).toContain("[x](javascript:alert(1");
  });

  it("an http:, data:, mailto: or rooted address stays text", () => {
    for (const href of ["http://example.org", "data:text/html,x", "mailto:a@b.c", "/etc/passwd", "//example.org", "JaVaScRiPt:1", "vbscript:1"]) {
      expect(parseInline(`[x](${href})`).some((item) => item.kind === "link")).toBe(false);
    }
  });

  it("an empty address stays text", () => {
    expect(parseInline("[x]()").some((item) => item.kind === "link")).toBe(false);
  });

  it("an address with a control character or DEL stays text, so a hidden scheme cannot get through", () => {
    for (const href of ["\u0001javascript:x", "java\tscript:x", "java\nscript:x", "\u001fhttps://example.org", "a\u007fb.md"]) {
      expect(parseInline(`[x](${href})`).some((item) => item.kind === "link"), JSON.stringify(href)).toBe(false);
    }
  });

  it("an entity-written scheme stays text: a colon in the first path segment is never a relative link", () => {
    expect(parseInline("[x](&#106;avascript:alert(1))").some((item) => item.kind === "link")).toBe(false);
    expect(parseInline("[x](&#x6A;avascript:x)").some((item) => item.kind === "link")).toBe(false);
  });

  it("a colon after the first path segment is still a relative link", () => {
    expect(linkTo("[x](a/b:c.md)")).toMatchObject({ href: "a/b:c.md" });
    expect(linkTo("[x](a.md#x:y)")).toMatchObject({ href: "a.md#x:y" });
  });
});
