import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "../../src/docs/markdown";

describe("parseMarkdown, the block kinds that the first test leaves out", () => {
  it("reads a block quote, joins its lines and strips the marker", () => {
    expect(parseMarkdown("> one\n>two\n> **three**")).toEqual([
      { kind: "quote", children: [{ kind: "text", text: "one two " }, { kind: "bold", children: [{ kind: "text", text: "three" }] }] },
    ]);
  });

  it("ends a quote at the first line without the marker", () => {
    expect(parseMarkdown("> q\nafter").map((block) => block.kind)).toEqual(["quote", "paragraph"]);
  });

  it("reads headings of level 1 to 4 and trims the text, and leaves five hashes as a paragraph", () => {
    const blocks = parseMarkdown("# A\n## B b\n### C\n####   D  \n##### E");
    expect(blocks.map((block) => block.kind === "heading" ? [block.level, block.id, block.text] : block.kind)).toEqual([
      [1, "a", "A"],
      [2, "b-b", "B b"],
      [3, "c", "C"],
      [4, "d", "D"],
      "paragraph",
    ]);
  });

  it("reads a table: the header, the body, and no row for the rule line", () => {
    const [table] = parseMarkdown("| A | `b` |\n|:--|--:|\n| 1 | **2** |\n| 3 | 4 |");
    expect(table).toEqual({
      kind: "table",
      header: [[{ kind: "text", text: "A" }], [{ kind: "code", text: "b" }]],
      rows: [
        [[{ kind: "text", text: "1" }], [{ kind: "bold", children: [{ kind: "text", text: "2" }] }]],
        [[{ kind: "text", text: "3" }], [{ kind: "text", text: "4" }]],
      ],
    });
  });

  it("keeps the code of an unclosed code block to the end of the page", () => {
    expect(parseMarkdown("```\na\n\nb")).toEqual([{ kind: "code", text: "a\n\nb" }]);
  });

  it("reads an empty code block", () => {
    expect(parseMarkdown("```\n```")).toEqual([{ kind: "code", text: "" }]);
  });

  it("reads bulleted lists with a dash or a star, and numbered lists, and keeps the kinds apart", () => {
    const blocks = parseMarkdown("- a\n* b\n1. c\n2. d\n- e");
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ kind: "list", ordered: false });
    expect(blocks[1]).toMatchObject({ kind: "list", ordered: true });
    expect(blocks[2]).toMatchObject({ kind: "list", ordered: false });
  });

  it("stops a paragraph at a heading, a fence, a quote, a list or a table", () => {
    for (const next of ["# H", "```", "> q", "- i", "1. i", "| a |"]) {
      expect(parseMarkdown(`text\n${next}`)[0]).toEqual({ kind: "paragraph", children: [{ kind: "text", text: "text" }] });
    }
  });

  it("reads windows line endings like unix ones", () => {
    expect(parseMarkdown("a\r\n\r\nb")).toEqual(parseMarkdown("a\n\nb"));
  });

  it("gives no blocks for an empty page", () => {
    expect(parseMarkdown("")).toEqual([]);
  });
});

describe("parseInline, edge cases", () => {
  it("reads nested marks, italic with an underscore, and keeps unmatched marks as text", () => {
    expect(parseInline("**a _b_**")).toEqual([{ kind: "bold", children: [{ kind: "text", text: "a " }, { kind: "italic", children: [{ kind: "text", text: "b" }] }] }]);
    expect(parseInline("**a *b***")).toEqual([{ kind: "bold", children: [{ kind: "text", text: "a " }, { kind: "italic", children: [{ kind: "text", text: "b" }] }] }]);
    expect(parseInline("**a** and **b**").map((item) => item.kind)).toEqual(["bold", "text", "bold"]);
    expect(parseInline("_x_")).toEqual([{ kind: "italic", children: [{ kind: "text", text: "x" }] }]);
    expect(parseInline("2 * 3 and a_b")).toEqual([{ kind: "text", text: "2 * 3 and a_b" }]);
  });

  it("does not read marks inside code", () => {
    expect(parseInline("`**x**`")).toEqual([{ kind: "code", text: "**x**" }]);
  });

  it("gives nothing for empty text", () => {
    expect(parseInline("")).toEqual([]);
  });
});
