/**
 * A small Markdown reader for the documentation pages. It reads only what the pages use: headings, paragraphs, bulleted
 * and numbered lists, tables, block quotes, code blocks, and inline bold, italic and code. It builds a tree of data, not
 * HTML, so the page renders it as React elements and nothing is ever injected as markup.
 */

/** A piece of text inside a block. */
export type Inline =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "bold"; readonly children: readonly Inline[] }
  | { readonly kind: "italic"; readonly children: readonly Inline[] }
  | { readonly kind: "code"; readonly text: string };

/** One block of a page. */
export type Block =
  | { readonly kind: "heading"; readonly level: 1 | 2 | 3 | 4; readonly id: string; readonly text: string }
  | { readonly kind: "paragraph"; readonly children: readonly Inline[] }
  | { readonly kind: "list"; readonly ordered: boolean; readonly items: readonly (readonly Inline[])[] }
  | { readonly kind: "table"; readonly header: readonly (readonly Inline[])[]; readonly rows: readonly (readonly (readonly Inline[])[])[] }
  | { readonly kind: "quote"; readonly children: readonly Inline[] }
  | { readonly kind: "code"; readonly text: string };

/**
 * Turns a heading into an identifier for a link: lowercase words joined by dashes.
 *
 * @param text The heading text.
 */
export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const INLINE_PATTERN = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/;

/**
 * Reads the inline marks of one line of text.
 *
 * @param text The text.
 */
export const parseInline = (text: string): readonly Inline[] =>
  text
    .split(INLINE_PATTERN)
    .filter((part) => part !== "")
    .map((part): Inline => {
      if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return { kind: "bold", children: parseInline(part.slice(2, -2)) };
      if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return { kind: "code", text: part.slice(1, -1) };
      if ((part.startsWith("*") && part.endsWith("*")) || (part.startsWith("_") && part.endsWith("_"))) {
        return { kind: "italic", children: parseInline(part.slice(1, -1)) };
      }
      return { kind: "text", text: part };
    });

const isTableRow = (line: string): boolean => line.trim().startsWith("|") && line.trim().endsWith("|");
const isTableRule = (line: string): boolean => /^\|[\s:|-]+\|$/.test(line.trim());
const cellsOf = (line: string): readonly (readonly Inline[])[] =>
  line.trim().slice(1, -1).split("|").map((cell) => parseInline(cell.trim()));

const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d+\.\s+(.*)$/;
const HEADING = /^(#{1,4})\s+(.*)$/;

/** The text of a capture group that the pattern always fills. */
const captured = (match: RegExpExecArray, group: number): string => match[group] as string;

/**
 * Reads a page into blocks.
 *
 * @param source The Markdown text.
 */
export const parseMarkdown = (source: string): readonly Block[] => {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  // A line past the end reads as an empty line. Every loop below stops at an empty line, so none needs a length check.
  const at = (position: number): string => lines[position] ?? "";
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = at(index);
    const heading = HEADING.exec(line);
    if (line.trim() === "") {
      index += 1;
    } else if (line.startsWith("```")) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !at(index).startsWith("```")) body.push(at(index++));
      index += 1;
      blocks.push({ kind: "code", text: body.join("\n") });
    } else if (heading !== null) {
      const text = captured(heading, 2).trim();
      blocks.push({ kind: "heading", level: captured(heading, 1).length as 1 | 2 | 3 | 4, id: slugify(text), text });
      index += 1;
    } else if (isTableRow(line)) {
      const rows: string[] = [];
      while (isTableRow(at(index))) rows.push(at(index++));
      const body = rows.slice(1).filter((row) => !isTableRule(row));
      blocks.push({ kind: "table", header: cellsOf(line), rows: body.map(cellsOf) });
    } else if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = NUMBERED.test(line);
      const pattern = ordered ? NUMBERED : BULLET;
      const items: (readonly Inline[])[] = [];
      for (let match = pattern.exec(at(index)); match !== null; match = pattern.exec(at(index))) {
        items.push(parseInline(captured(match, 1).trim()));
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
    } else if (line.startsWith(">")) {
      const quoted: string[] = [];
      while (at(index).startsWith(">")) quoted.push(at(index++).replace(/^>\s?/, ""));
      blocks.push({ kind: "quote", children: parseInline(quoted.join(" ")) });
    } else {
      const paragraph: string[] = [];
      while (at(index).trim() !== "" && !/^(#{1,4}\s|```|>|\s*[-*]\s|\s*\d+\.\s)/.test(at(index)) && !isTableRow(at(index))) {
        paragraph.push(at(index++).trim());
      }
      blocks.push({ kind: "paragraph", children: parseInline(paragraph.join(" ")) });
    }
  }
  return blocks;
};
