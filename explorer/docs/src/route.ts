/** Where the address bar points: a page of the site and, optionally, a heading of that page. */
export type SiteRoute = {
  /** The page identifier, or an empty text for the front page. */
  readonly id: string;
  /** The heading identifier, or an empty text. */
  readonly anchor: string;
};

/**
 * Reads the hash of the address. The shape is `#/<page>` or `#/<page>#<heading>`. Anything else reads as the front
 * page, so a broken address still shows the site.
 *
 * @param hash The hash of the address, such as `#/help/safety#keys`.
 */
export const parseRoute = (hash: string): SiteRoute => {
  if (!hash.startsWith("#/")) return { id: "", anchor: "" };
  const rest = hash.slice(2);
  const anchorAt = rest.indexOf("#");
  if (anchorAt === -1) return { id: rest, anchor: "" };
  return { id: rest.slice(0, anchorAt), anchor: rest.slice(anchorAt + 1) };
};
