/**
 * The check every downloaded icon passes before it ships inside the site (and so on IPFS). An SVG can carry code or
 * pull from other hosts; neither may reach a page that people sign transactions from.
 */

const REFUSED: ReadonlyArray<readonly [RegExp, string]> = [
  [/<script[\s>]/i, "it holds a script"],
  [/<foreignObject[\s>]/i, "it holds a foreignObject"],
  [/\son[a-z]+\s*=/i, "it has an event handler attribute"],
  [/(?:xlink:)?href\s*=\s*["']\s*(?:https?:|\/\/|javascript:|data:text\/html)/i, "it links to another host or to code"],
  [/url\(\s*["']?\s*(?:https?:|\/\/)/i, "it loads a resource from another host"],
  [/<!ENTITY/i, "it declares an entity"],
  [/@import/i, "it imports a stylesheet"],
];

/**
 * Why an SVG may not ship, or null when it may.
 *
 * @param text The SVG source.
 */
export const checkSvg = (text: string): string | null => {
  if (!/<svg[\s>]/i.test(text)) return "it is not an SVG";
  for (const [pattern, reason] of REFUSED) if (pattern.test(text)) return reason;
  return null;
};

/** The magic bytes of the raster formats an icon may be in. */
export const rasterKind = (bytes: Uint8Array): "png" | "webp" | "jpg" | null => {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "webp";
  return null;
};
