import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { Chevron, ICON_CREDIT, SearchIcon } from "@web/bridge/icons";
import { XBand, XRow } from "@web/explore/parts";
import { useThemeChoice } from "@web/app/theme";
import type { ThemeChoice } from "@web/search/search-model";
import { BrandMark } from "@web/ui/BrandMark";
import { DocsMarkdown } from "./DocsMarkdown";
import { DocsSearch } from "./DocsSearch";
import type { DocsResult } from "./docs-search";
import { routeOf, SECTION_TITLES, SECTIONS, type DocsSitePage } from "./pages";
import { parseRoute } from "./route";

/** Props of {@link DocsSite}. */
export type DocsSiteProps = {
  readonly pages: readonly DocsSitePage[];
};

const SITE_NAME = "zkb.fi docs";

/** The search shortcut as this keyboard writes it: ⌘K on Apple devices, Ctrl K elsewhere (as in the app's header). */
const SHORTCUT = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘K" : "Ctrl K";

const THEMES: readonly (readonly [ThemeChoice, string])[] = [
  ["system", "System"],
  ["light", "Light"],
  ["dark", "Dark"],
  ["mono", "Mono"],
];

/** Follows the hash of the address, so the back button and a shared link both work. */
const useHash = (): string => {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const update = () => setHash(window.location.hash);
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return hash;
};

/** Whether a key press happens inside a field, where `/` is typed rather than opening the search. */
const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/** The header of the app: the mark (the docs' home), the page name in the middle, the search pill on the right. */
const DocsHeader = ({ name, onSearch }: { readonly name: string; readonly onSearch: () => void }) => (
  <header className="zb-header zb-col">
    <a className="zb-mark" href="#/" aria-label="zkb.fi docs, home">
      <BrandMark size={44} />
    </a>
    <span className="zb-page-name zd-page-name">
      <span data-testid="page-name" title={name}>
        {name}
      </span>
    </span>
    <button type="button" className="zb-pill zb-search" onClick={onSearch} aria-label="Search the docs (Command K, Control K or slash)" aria-haspopup="dialog">
      <SearchIcon />
      <kbd className="zb-kbd" aria-hidden="true">
        {SHORTCUT}
      </kbd>
    </button>
  </header>
);

/** A group heading in Explore's style, as a level-two heading under the page title. */
const Group = ({ id, title, count }: { readonly id: string; readonly title: string; readonly count?: string }) => (
  <h2 id={id} className="zb-xgrp">
    <span>{title}</span>
    {count === undefined ? null : <span className="zb-xgrp-r">{count}</span>}
  </h2>
);

/** The front page: the title on the band, then the pages in groups as rows. */
const Home = ({ pages }: { readonly pages: readonly DocsSitePage[] }) => {
  const groups = SECTIONS.map((section) => ({ section, pages: pages.filter((page) => page.section === section) })).filter((group) => group.pages.length > 0);
  return (
    <>
      <XBand label="zkb.fi" big={<h1 className="zd-title" tabIndex={-1}>Docs</h1>} sub="How to use the bridge, what you trust, and how to run it." />
      <div className="zb-col zd-home">
        {groups.map((group) => (
          <section key={group.section} aria-labelledby={`group-${group.section}`}>
            <Group id={`group-${group.section}`} title={SECTION_TITLES[group.section]} count={`${group.pages.length} ${group.pages.length === 1 ? "page" : "pages"}`} />
            {group.pages.map((page) => (
              <XRow key={page.id} href={routeOf(page.id, "")} title={page.title} sub={page.description} />
            ))}
          </section>
        ))}
        {groups.length === 0 ? <p className="zd-p">No pages are published yet.</p> : null}
      </div>
    </>
  );
};

/** Which heading the reader is at: the last one whose top has passed a quarter of the window. */
const useCurrentHeading = (ids: readonly string[]): string | null => {
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    let frame = 0;
    const measure = (): void => {
      frame = 0;
      let found: string | null = null;
      for (const id of ids) {
        const element = document.getElementById(id);
        if (element !== null && element.getBoundingClientRect().top < window.innerHeight / 4) found = id;
      }
      setCurrent(found);
    };
    const schedule = (): void => {
      if (frame === 0) frame = window.requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    return () => {
      window.removeEventListener("scroll", schedule);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [ids]);
  return current;
};

/** The list of headings of a page, as hash links. */
const Contents = ({ page, current }: { readonly page: DocsSitePage; readonly current: string | null }) => (
  <ol className="zd-toc-list">
    {page.headings
      .filter((heading) => heading.level <= 3)
      .map((heading) => (
        <li key={heading.id} data-level={heading.level}>
          <a href={routeOf(page.id, heading.id)} aria-current={heading.id === current ? "location" : undefined}>
            {heading.text}
          </a>
        </li>
      ))}
  </ol>
);

/** A page: the title on the band with a short meta line, the contents (under the band on phones, beside the text on desktop), the text, then the previous and next pages. */
const Article = ({ page, before, after }: { readonly page: DocsSitePage; readonly before: DocsSitePage | null; readonly after: DocsSitePage | null }) => {
  const ids = page.headings.map((heading) => heading.id);
  const current = useCurrentHeading(ids);
  const sections = page.headings.filter((heading) => heading.level === 2).length;
  const hasContents = page.headings.length > 0;
  return (
    <>
      <XBand
        label={SECTION_TITLES[page.section]}
        big={
          <h1 id="page-title" className="zd-title" tabIndex={-1}>
            {page.title}
          </h1>
        }
        sub={`${page.minutes} min read${sections > 0 ? ` · ${sections} ${sections === 1 ? "section" : "sections"}` : ""}`}
      />
      {hasContents ? (
        <details className="zb-col zd-toc-phone">
          <summary>
            On this page
            <Chevron dir="down" />
          </summary>
          <nav aria-label="On this page">
            <Contents page={page} current={current} />
          </nav>
        </details>
      ) : null}
      <div className="zd-layout">
        <article className="zd-article" aria-labelledby="page-title">
          <DocsMarkdown blocks={page.blocks} />
          {before === null && after === null ? null : (
            <nav className="zd-pager" aria-label="Previous and next page">
              {before === null ? null : (
                <a className="zb-xrow zd-prev" href={routeOf(before.id, "")}>
                  <Chevron dir="left" />
                  <span className="zb-xrow-text">
                    <span>Previous</span>
                    <b>{before.title}</b>
                  </span>
                </a>
              )}
              {after === null ? null : (
                <a className="zb-xrow zd-next" href={routeOf(after.id, "")}>
                  <span className="zb-xrow-text">
                    <span>Next</span>
                    <b>{after.title}</b>
                  </span>
                  <Chevron dir="right" />
                </a>
              )}
            </nav>
          )}
        </article>
        {hasContents ? (
          <aside className="zd-toc-side">
            <nav aria-label="On this page">
              <h2 className="zb-xgrp">On this page</h2>
              <Contents page={page} current={current} />
            </nav>
          </aside>
        ) : null}
      </div>
    </>
  );
};

/** The page for an address that names no page. */
const NotFound = ({ id }: { readonly id: string }) => (
  <>
    <XBand label="zkb.fi docs" big={<h1 className="zd-title" tabIndex={-1}>Not found</h1>} />
    <div className="zb-col zd-home">
      <p className="zd-p">{`There is no documentation page called "${id}".`}</p>
      <XRow href="#/" title="Docs home" sub="Every page, by group" />
    </div>
  </>
);

/**
 * The documentation site in the app's patterns: the app's header, themes, bands, rows and search. The page comes from
 * the hash of the address, so the site needs no server and loads from any path prefix, an IPFS gateway path included.
 *
 * @param props The pages, in reading order.
 */
export const DocsSite = ({ pages }: DocsSiteProps) => {
  const route = parseRoute(useHash());
  const { theme, setTheme } = useThemeChoice();
  const [searchOpen, setSearchOpen] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  const main = useRef<HTMLElement>(null);
  const shownRoute = useRef(parseRoute(window.location.hash).id);

  const index = route.id === "" ? -1 : pages.findIndex((candidate) => candidate.id === route.id);
  const page = index < 0 ? null : (pages[index] as DocsSitePage);
  // The header names the article (ellipsized when long), as the app names its screen; "Docs" on the home page.
  const name = route.id === "" ? "Docs" : page === null ? "Not found" : page.title;

  const openSearch = useCallback(() => {
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSearchOpen(true);
  }, []);
  const closeSearch = useCallback(() => setSearchOpen(false), []);

  // Focus returns to what opened the search once the page is no longer inert.
  useEffect(() => {
    if (!searchOpen && trigger.current !== null) {
      trigger.current.focus();
      trigger.current = null;
    }
  }, [searchOpen]);

  // ⌘K, Ctrl K and / open the search, as in the app.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const command = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      const slash = event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && !isTyping(event.target);
      if (!command && !slash) return;
      event.preventDefault();
      if (searchOpen) return;
      openSearch();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openSearch, searchOpen]);

  useEffect(() => {
    document.title = page === null ? (route.id === "" ? SITE_NAME : `Not found · ${SITE_NAME}`) : `${page.title} · ${SITE_NAME}`;
    const moved = shownRoute.current !== route.id;
    shownRoute.current = route.id;
    if (route.anchor !== "") {
      // A heading link: scroll to the heading and let it take focus, so a screen reader reads from there.
      const heading = document.getElementById(route.anchor);
      heading?.scrollIntoView({ block: "start" });
      if (heading !== null && heading.tabIndex < 0 && !heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
      heading?.focus({ preventScroll: true });
      return;
    }
    window.scrollTo({ top: 0 });
    // After a move to another page, the title takes focus, so a screen reader starts at the new page.
    if (moved) main.current?.querySelector<HTMLElement>("h1")?.focus({ preventScroll: true });
  }, [page, route.id, route.anchor]);

  const onSelect = (result: DocsResult): void => {
    if (result.theme !== undefined) setTheme(result.theme);
    // A jump moves focus to where it lands (the title or the heading), not back to the search pill.
    if (result.href !== undefined) trigger.current = null;
    setSearchOpen(false);
    if (result.href !== undefined) window.location.hash = result.href;
  };

  const skip = (event: MouseEvent<HTMLAnchorElement>): void => {
    // The hash is the route, so the skip link moves focus itself instead of changing the address.
    event.preventDefault();
    main.current?.focus();
  };

  return (
    <div className="zb zd">
      <div className="zd-page" inert={searchOpen}>
        <a className="zd-skip" href={window.location.hash === "" ? "#/" : window.location.hash} onClick={skip}>
          Skip to the text
        </a>
        <DocsHeader name={name} onSearch={openSearch} />
        <main ref={main} id="main" tabIndex={-1} className="zd-main">
          {route.id === "" ? <Home pages={pages} /> : page === null ? <NotFound id={route.id} /> : <Article page={page} before={pages[index - 1] ?? null} after={pages[index + 1] ?? null} />}
        </main>
        <footer className="zd-foot">
          <div className="zb-col zd-foot-in">
            <span className="zd-foot-name">{SITE_NAME}</span>
            <a className="zd-foot-credit" href="https://game-icons.net/" rel="noopener noreferrer" target="_blank">
              {ICON_CREDIT}
            </a>
            <div className="zb-seg" role="radiogroup" aria-label="Theme">
              {THEMES.map(([choice, label]) => (
                <button key={choice} type="button" role="radio" aria-checked={theme === choice} onClick={() => setTheme(choice)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        </footer>
      </div>
      {searchOpen ? <DocsSearch pages={pages} onSelect={onSelect} onClose={closeSearch} /> : null}
    </div>
  );
};
