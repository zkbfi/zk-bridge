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

/** The first path segment that is not empty, decoded. A segment that cannot be decoded is returned as it is. */
const firstSegmentOf = (pathname: string): string => {
  const segment = pathname.split("/").find((part) => part !== "") ?? "";
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

/**
 * Tells whether other sites can share the browser origin of this page.
 * A path-style gateway puts `ipfs` or `ipns` in the first path segment. The check ignores empty segments (a gateway can
 * merge slashes), decodes the segment, and ignores case. It fails closed: a segment that cannot be decoded, or that
 * still holds a percent sign, a slash or a backslash after decoding, counts as shared. The host name does not change the answer: a
 * subdomain-style gateway, a normal domain and localhost all serve the page from the root path.
 *
 * @param location The location of the page.
 * @returns True when the page runs on a path-style gateway, or when the path cannot be read with certainty.
 */
export const originIsShared = (location: OriginLocation): boolean => {
  const segment = firstSegmentOf(location.pathname);
  if (/[%/\\]/.test(segment)) return true;
  return GATEWAY_SEGMENTS.includes(segment.toLowerCase());
};
