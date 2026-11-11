import { BrandMark } from "../ui/BrandMark";
import { Chevron, SearchIcon } from "./icons";

/** The search shortcut as a keyboard writes it: ⌘K on Apple devices, Ctrl K elsewhere (and where there is no navigator). */
export const shortcutOf = (nav: Pick<Navigator, "platform" | "userAgent"> | undefined): string =>
  /Mac|iPhone|iPad/.test(nav?.platform || nav?.userAgent || "") ? "⌘K" : "Ctrl K";

const SHORTCUT = shortcutOf(globalThis.navigator);

/** The three screens that slide sideways, left to right. */
export const SCREENS = ["Activity", "Bridge", "Explore"] as const;
export type ScreenName = (typeof SCREENS)[number];

/** Props of {@link Header}. */
export type HeaderProps = {
  /** The name of the page shown in the middle. */
  readonly page: string;
  /** The hash of each of the three screens. */
  readonly screenHref: (screen: ScreenName) => string;
  /** The hash of home (the bridge). */
  readonly homeHref: string;
  readonly onSearch: () => void;
};

/**
 * The header on every page: [mark] [active page] [search] (owner's sketch). Under the three sliding screens it shows
 * which one is open, with chevrons to the neighbours; search reaches everything, the three screens included.
 *
 * @param props The page, the links and the search handler.
 */
export const Header = ({ page, screenHref, homeHref, onSearch }: HeaderProps) => {
  const index = SCREENS.indexOf(page as ScreenName);
  const before = index > 0 ? SCREENS[index - 1] : undefined;
  const after = index >= 0 && index < SCREENS.length - 1 ? SCREENS[index + 1] : undefined;
  return (
    <>
      <header className="zb-header zb-col">
        <a className="zb-mark" href={homeHref} aria-label="zkb.fi, the bridge">
          <BrandMark size={44} />
        </a>
        <span className="zb-page-name">
          {before === undefined ? (
            <span className="zb-near" data-hidden="true" aria-hidden="true">
              <Chevron dir="left" />
            </span>
          ) : (
            <a className="zb-near" href={screenHref(before)} aria-label={`Previous screen: ${before}`}>
              <Chevron dir="left" />
            </a>
          )}
          {index < 0 ? (
            <span data-testid="page-name">{page}</span>
          ) : (
            <span className="zb-name-stack">
              {SCREENS.map((screen) =>
                screen === page ? (
                  <span key={screen} data-on="true" data-testid="page-name">
                    {screen}
                  </span>
                ) : (
                  <span key={screen} aria-hidden="true">
                    {screen}
                  </span>
                ),
              )}
            </span>
          )}
          {after === undefined ? (
            <span className="zb-near" data-hidden="true" aria-hidden="true">
              <Chevron dir="right" />
            </span>
          ) : (
            <a className="zb-near" href={screenHref(after)} aria-label={`Next screen: ${after}`}>
              <Chevron dir="right" />
            </a>
          )}
        </span>
        <button type="button" className="zb-pill zb-search" onClick={onSearch} aria-label="Search and jump (Command K, Control K or slash)" aria-haspopup="dialog">
          <SearchIcon />
          <kbd className="zb-kbd" aria-hidden="true">
            {SHORTCUT}
          </kbd>
        </button>
      </header>
      {index < 0 ? null : (
        <div className="zb-pages" aria-hidden="true">
          {SCREENS.map((screen) => (
            <span key={screen} className={screen === page ? "on" : undefined} />
          ))}
        </div>
      )}
    </>
  );
};
