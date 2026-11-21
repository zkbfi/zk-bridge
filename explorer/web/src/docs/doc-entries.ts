/**
 * What the command palette knows of the docs: each page's slug and title and the headings of the page. The pages
 * themselves live in the lazy docs chunk (`explorer/docs`), so this file imports them only when a search needs them.
 */
import { slugOfPageId } from "./slug";

/** One heading of a page. */
export type DocEntryHeading = { readonly id: string; readonly text: string };

/** One page of the docs, as the palette lists it. */
export type DocEntry = {
  /** The address part after `#/docs/`, such as `fees-explained`. */
  readonly slug: string;
  readonly title: string;
  /** The headings below the title. */
  readonly headings: readonly DocEntryHeading[];
};

/** The shape of a page of the docs site that the palette reads. */
type SitePageLike = { readonly id: string; readonly title: string; readonly headings: readonly DocEntryHeading[] };

/**
 * Turns pages of the docs site into palette entries.
 *
 * @param pages The pages, in reading order.
 */
export const entriesOf = (pages: readonly SitePageLike[]): readonly DocEntry[] =>
  pages.map((page) => ({ slug: slugOfPageId(page.id), title: page.title, headings: page.headings.map((heading) => ({ id: heading.id, text: heading.text })) }));

/**
 * Downloads the docs pages (a separate chunk) and lists them for the palette. Call it when a search needs the docs,
 * never while the page starts.
 *
 * @param chainIds The chain ids of the pair the app runs on: a page about other chains (the testnet faucet page) is left out.
 */
export const loadDocEntries = async (chainIds: readonly number[]): Promise<readonly DocEntry[]> => {
  const { SITE_PAGES, pagesForChains } = await import("@docs/pages");
  return entriesOf(pagesForChains(SITE_PAGES, chainIds));
};
