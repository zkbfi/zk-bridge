/**
 * How a page of the docs site is named in the dapp's address: `#/docs/<slug>` and `#/docs/<slug>/<heading>`.
 * The help pages keep the short slug the dapp always used (`fees-explained` for the page `help/fees-explained`); an
 * operator page keeps its whole identifier (`audit/known-issues`), which the address writes as one encoded segment.
 * This file is small on purpose: the dapp's first bundle imports it, while the pages themselves load lazily.
 */

/** The route of a docs page in the dapp, as `Route` in `app/route.ts` names it. */
export type DocsRouteTarget = { readonly name: "docs"; readonly slug: string | null; readonly heading: string | null };

const HELP_PREFIX = "help/";

/**
 * The slug of a page.
 *
 * @param id The page identifier of the docs site, such as `help/safety`.
 */
export const slugOfPageId = (id: string): string => (id.startsWith(HELP_PREFIX) ? id.slice(HELP_PREFIX.length) : id);

/**
 * Whether a slug of the address names a page.
 *
 * @param id The page identifier.
 * @param slug The slug from the address.
 */
export const pageIdMatchesSlug = (id: string, slug: string): boolean => slugOfPageId(id) === slug;

/**
 * The route for a page and a heading. An empty page identifier is the front page of the docs.
 *
 * @param id The page identifier, or an empty text.
 * @param anchor The heading identifier, or an empty text.
 */
export const docsRouteOf = (id: string, anchor: string): DocsRouteTarget => ({
  name: "docs",
  slug: id === "" ? null : slugOfPageId(id),
  heading: id === "" || anchor === "" ? null : anchor,
});
