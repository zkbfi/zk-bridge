/**
 * The entry the dapp loads lazily when a docs route opens (`React.lazy(() => import("@docs/DocsPage"))`). Everything the
 * docs need sits behind this one module: the site, the search, the styles and the Markdown pages. The dapp's first
 * bundle imports none of it, so the bridge screen does not grow.
 *
 * Owner, verbatim: "perhaps docs should be async loaded in the same app as dapp? no need to consume a second domain"
 */
// The app's tokens, themes, header, bands, rows and search sheet; then the docs' own body type.
import "@web/bridge/bridge.css";
import "@web/explore/explore.css";
import "./docs.css";
import { DocsSite } from "./DocsSite";
import { pagesForChains, SITE_PAGES } from "./pages";

/** Props of {@link DocsPage}. */
export type DocsPageProps = {
  readonly slug: string | null;
  readonly heading: string | null;
  /** The chain ids of the pair the app runs on. A page about chains the pair does not hold (the testnet faucet page) is left out. */
  readonly chainIds?: readonly number[];
};

/**
 * The docs site over the real pages.
 *
 * @param props The page and the heading from the address, and the chains of the pair.
 */
const DocsPage = ({ slug, heading, chainIds }: DocsPageProps) => <DocsSite pages={pagesForChains(SITE_PAGES, chainIds)} slug={slug} heading={heading} />;

export default DocsPage;
