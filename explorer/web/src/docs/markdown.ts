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

/**
 * Reads a page into blocks.
 *
 * @param source The Markdown text.
 */
export const parseMarkdown = (source: string): readonly Block[] => {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (line.trim() === "") {
      index += 1;
    } else if (line.startsWith("```")) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").startsWith("```")) body.push(lines[index++] ?? "");
      index += 1;
      blocks.push({ kind: "code", text: body.join("\n") });
    } else if (heading !== null) {
      const text = (heading[2] ?? "").trim();
      blocks.push({ kind: "heading", level: (heading[1] ?? "#").length as 1 | 2 | 3 | 4, id: slugify(text), text });
      index += 1;
    } else if (isTableRow(line)) {
      const rows: string[] = [];
      while (index < lines.length && isTableRow(lines[index] ?? "")) rows.push(lines[index++] ?? "");
      const [headerLine = "", ...rest] = rows;
      const body = rest.filter((row) => !isTableRule(row));
      blocks.push({ kind: "table", header: cellsOf(headerLine), rows: body.map(cellsOf) });
    } else if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = NUMBERED.test(line);
      const pattern = ordered ? NUMBERED : BULLET;
      const items: (readonly Inline[])[] = [];
      while (index < lines.length && pattern.test(lines[index] ?? "")) items.push(parseInline((pattern.exec(lines[index++] ?? "")?.[1] ?? "").trim()));
      blocks.push({ kind: "list", ordered, items });
    } else if (line.startsWith(">")) {
      const quoted: string[] = [];
      while (index < lines.length && (lines[index] ?? "").startsWith(">")) quoted.push((lines[index++] ?? "").replace(/^>\s?/, ""));
      blocks.push({ kind: "quote", children: parseInline(quoted.join(" ")) });
    } else {
      const paragraph: string[] = [];
      while (index < lines.length && (lines[index] ?? "").trim() !== "" && !/^(#{1,4}\s|```|>|\s*[-*]\s|\s*\d+\.\s)/.test(lines[index] ?? "") && !isTableRow(lines[index] ?? "")) {
        paragraph.push((lines[index++] ?? "").trim());
      }
      blocks.push({ kind: "paragraph", children: parseInline(paragraph.join(" ")) });
    }
  }
  return blocks;
};
