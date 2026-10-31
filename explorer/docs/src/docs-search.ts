/**
 * What the docs search finds: pages (by title and description), the headings of every page, and the theme choices.
 * With no query it lists the pages by group, the way the front page does.
 */
import type { ThemeChoice } from "@web/search/search-model";
import { routeOf, SECTION_TITLES, SECTIONS, type DocsSitePage } from "./pages";

/** One row of the search. A row with `href` opens a page; a row with `theme` sets the theme. */
export type DocsResult = {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly href?: string;
  readonly theme?: ThemeChoice;
};

/** A heading over rows. */
export type DocsResultGroup = { readonly id: string; readonly title: string; readonly results: readonly DocsResult[] };

const THEMES: readonly (readonly [ThemeChoice, string])[] = [
  ["system", "System"],
  ["light", "Light"],
  ["dark", "Dark"],
  ["mono", "Mono"],
];

/** The most heading rows one query shows, so a short word does not list the whole site. */
const MAX_HEADINGS = 30;

const pageResult = (page: DocsSitePage): DocsResult => ({ id: `page:${page.id}`, title: page.title, subtitle: page.description, href: routeOf(page.id, "") });

/**
 * How well a row matches every word of the query: 0 when a word is missing; more when the title starts with the query
 * or a title word starts with a query word.
 */
const score = (query: string, title: string, subtitle: string): number => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const titleText = title.toLowerCase();
  const all = `${titleText} ${subtitle.toLowerCase()}`;
  if (words.some((word) => !all.includes(word))) return 0;
  let points = 1;
  if (titleText.startsWith(query.toLowerCase().trim())) points += 4;
  for (const word of words) {
    if (new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(titleText)) points += 2;
    else if (titleText.includes(word)) points += 1;
  }
  return points;
};

const ranked = (query: string, results: readonly DocsResult[]): DocsResult[] =>
  results
    .map((result, order) => ({ result, order, points: score(query, result.title, result.subtitle) }))
    .filter((entry) => entry.points > 0)
    .sort((left, right) => right.points - left.points || left.order - right.order)
    .map((entry) => entry.result);

/**
 * The groups of rows for a query.
 *
 * @param query What the reader typed.
 * @param pages The pages of the site.
 */
export const searchDocs = (query: string, pages: readonly DocsSitePage[]): readonly DocsResultGroup[] => {
  if (query.trim() === "") {
    return SECTIONS.map((section) => ({ id: section, title: SECTION_TITLES[section], results: pages.filter((page) => page.section === section).map(pageResult) })).filter(
      (group) => group.results.length > 0,
    );
  }
  const headings = pages.flatMap((page) =>
    page.headings.map((heading): DocsResult => ({ id: `heading:${page.id}#${heading.id}`, title: heading.text, subtitle: page.title, href: routeOf(page.id, heading.id) })),
  );
  const themes = THEMES.map(([theme, label]): DocsResult => ({ id: `theme:${theme}`, title: `Theme: ${label}`, subtitle: theme === "system" ? "Follow the system setting" : `Use the ${label.toLowerCase()} theme`, theme }));
  const groups: DocsResultGroup[] = [
    { id: "pages", title: "Pages", results: ranked(query, pages.map(pageResult)) },
    { id: "headings", title: "Sections", results: ranked(query, headings).slice(0, MAX_HEADINGS) },
    { id: "themes", title: "Theme", results: ranked(query, themes) },
  ];
  return groups.filter((group) => group.results.length > 0);
};
