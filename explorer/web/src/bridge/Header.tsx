import { BrandMark } from "../ui/BrandMark";
import { Chevron, SearchIcon } from "./icons";

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
          <BrandMark size={28} />
        </a>
        <span className="zb-page-name">
          {before === undefined ? null : (
            <a className="zb-near" href={screenHref(before)} aria-label={`Previous screen: ${before}`}>
              <Chevron dir="left" />
            </a>
          )}
          <span data-testid="page-name">{page}</span>
          {after === undefined ? null : (
            <a className="zb-near" href={screenHref(after)} aria-label={`Next screen: ${after}`}>
              <Chevron dir="right" />
            </a>
          )}
        </span>
        <button type="button" className="zb-pill zb-search" onClick={onSearch} aria-label="Search and jump (Control K or slash)" aria-haspopup="dialog">
          <SearchIcon />
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
