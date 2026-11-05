/**
 * docs.zkb.fi is the dapp itself. Owner, verbatim: "perhaps docs should be async loaded in the same app as dapp? no
 * need to consume a second domain" and "yes, point docs.zkb.fi at the dapp. have it go to /#/docs". The DNSLink of
 * docs.zkb.fi names the dapp's CID, and this function sends the empty address of that host to the docs.
 */

/**
 * The host names that mean "the docs": "docs." (docs.zkb.fi) and "docs-zkb-fi." (the host inbrowser.link gives
 * docs.zkb.fi, where the Worker in deploy/docs-redirect sends visitors, so the dapp still sees a docs host there).
 */
const DOCS_HOST_PREFIXES = ["docs.", "docs-zkb-fi."] as const;

/** The parts of `window.location` that the redirect reads. */
export type HostLocation = Pick<Location, "hostname" | "hash" | "pathname" | "search">;

/** The part of `window.history` that the redirect writes. */
export type HostHistory = { readonly state: unknown; replaceState: (state: unknown, unused: string, url: string) => void };

/**
 * When the page is loaded on a host that starts with "docs." and the hash is empty or "#/", replaces the address with
 * `#/docs` (no reload and no history entry). Any other hash is left alone, so a shared link to a place still opens it.
 *
 * @param location The address of the page.
 * @param history The history of the page.
 * @returns Whether the address was replaced.
 */
export const sendDocsHostToDocs = (location: HostLocation, history: HostHistory): boolean => {
  if (!DOCS_HOST_PREFIXES.some((prefix) => location.hostname.startsWith(prefix))) return false;
  if (location.hash !== "" && location.hash !== "#" && location.hash !== "#/") return false;
  history.replaceState(history.state, "", `${location.pathname}${location.search}#/docs`);
  return true;
};
