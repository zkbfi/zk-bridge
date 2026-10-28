/**
 * Detection of a shared browser origin.
 *
 * A path-style IPFS gateway (`https://gateway.example/ipfs/<cid>/`) serves every site from one origin. Another site on
 * that gateway can read and change the local storage of this page. A subdomain-style gateway
 * (`https://<cid>.ipfs.gateway.example/`) gives each release its own origin, so it has no such risk.
 */

/** The part of `window.location` that the check reads. */
export type OriginLocation = { readonly pathname: string; readonly hostname: string };

/** The first path segments that mark a path-style gateway. */
const GATEWAY_SEGMENTS: readonly string[] = ["ipfs", "ipns"];

/**
 * Tells whether other sites can share the browser origin of this page.
 * A path-style gateway puts `ipfs` or `ipns` in the first path segment. The host name does not change the answer:
 * a subdomain-style gateway, a normal domain and localhost all serve the page from the root path.
 *
 * @param location The location of the page.
 * @returns True when the page runs on a path-style gateway.
 */
export const originIsShared = (location: OriginLocation): boolean => {
  const firstSegment = location.pathname.split("/")[1] ?? "";
  return GATEWAY_SEGMENTS.includes(firstSegment);
};
