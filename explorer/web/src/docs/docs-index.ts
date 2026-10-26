/**
 * The documentation pages. They are Markdown files in `explorer/web/docs/pages`. Vite reads them as text at build time.
 * The page title is the first heading. The palette searches the title and every heading.
 */
import { parseMarkdown, type Block } from "./markdown";

/** One heading of a page. */
export type DocHeading = { readonly id: string; readonly text: string; readonly level: 2 | 3 | 4 };

/** One page of the documentation. */
export type DocPage = {
  /** The part of the file name after the order number, such as `fees-explained`. */
  readonly slug: string;
  readonly title: string;
  readonly blocks: readonly Block[];
  /** The headings below the title. */
  readonly headings: readonly DocHeading[];
};

const FILE_NAME = /(?:^|\/)(\d+)-([a-z0-9-]+)\.md$/;

/**
 * Reads the pages from a map of file path to file text, ordered by the number at the start of the file name.
 *
 * @param files File path to text.
 * @throws When a file name has no order number or a page has no title.
 */
export const parseDocPages = (files: Readonly<Record<string, string>>): readonly DocPage[] =>
  Object.entries(files)
    .map(([path, source]) => {
      const match = FILE_NAME.exec(path);
      if (match === null) throw new Error(`The documentation file "${path}" needs a name like 01-getting-started.md.`);
      const blocks = parseMarkdown(source);
      const title = blocks.find((block) => block.kind === "heading" && block.level === 1);
      if (title === undefined || title.kind !== "heading") throw new Error(`The documentation file "${path}" has no title.`);
      const headings = blocks.flatMap((block): DocHeading[] =>
        block.kind === "heading" && block.level > 1 ? [{ id: block.id, text: block.text, level: block.level as 2 | 3 | 4 }] : [],
      );
      // The pattern always fills group 2, so the cast hides no missing value.
      return { order: Number(match[1]), page: { slug: match[2] as string, title: title.text, blocks, headings } satisfies DocPage };
    })
    .sort((left, right) => left.order - right.order)
    .map((entry) => entry.page);

const files = import.meta.glob("../../docs/pages/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** Every page, in reading order. */
export const DOC_PAGES: readonly DocPage[] = parseDocPages(files);

/**
 * Finds a page by slug.
 *
 * @param slug The slug.
 * @param pages The pages. Default: all.
 */
export const findDocPage = (slug: string, pages: readonly DocPage[] = DOC_PAGES): DocPage | null =>
  pages.find((page) => page.slug === slug) ?? null;
