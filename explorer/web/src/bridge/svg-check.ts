/**
 * The check every downloaded SVG icon passes before it ships inside the site (and so on IPFS).
 *
 * An allowlist, not a denylist: a strict little XML reader walks the file and refuses (it never cleans and carries on)
 * anything outside a small set of drawing elements and attributes. No DOCTYPE, entity, CDATA, processing instruction
 * (other than the XML declaration), comment trick, style, script, event attribute, animation, <use>, external link or
 * url() that is not a local #fragment. Icons are also only ever shown through <img src>, where SVG scripts do not run;
 * this check is the second wall.
 */

const ELEMENTS = new Set([
  "svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "defs", "clipPath",
  "linearGradient", "radialGradient", "stop", "title", "desc", "mask",
]);

const ATTRIBUTES = new Set([
  "xmlns", "xmlns:xlink", "version", "viewBox", "width", "height", "preserveAspectRatio", "id",
  "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "fx", "fy", "d", "points",
  "fill", "fill-rule", "fill-opacity", "clip-rule", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
  "stroke-miterlimit", "stroke-opacity", "stroke-dasharray", "stroke-dashoffset", "opacity", "transform",
  "clip-path", "clipPathUnits", "mask", "maskUnits", "maskContentUnits",
  "gradientUnits", "gradientTransform", "spreadMethod", "offset", "stop-color", "stop-opacity", "href", "xlink:href",
]);

const NAMESPACES: Readonly<Record<string, string>> = {
  xmlns: "http://www.w3.org/2000/svg",
  "xmlns:xlink": "http://www.w3.org/1999/xlink",
};

/** Text may only sit in these; elsewhere only whitespace is allowed between tags. */
const TEXT_ELEMENTS = new Set(["title", "desc"]);

const NAME = /^[A-Za-z][A-Za-z0-9:-]*$/;
const ATTRIBUTE = /^\s+([A-Za-z][A-Za-z0-9:.-]*)\s*=\s*(?:"([^"<&]*)"|'([^'<&]*)')/;
const LOCAL_FRAGMENT = /^#[A-Za-z_][A-Za-z0-9_.-]*$/;

const checkValue = (name: string, value: string): string | null => {
  if (/^on/i.test(name)) return `the attribute ${name} is an event handler`;
  if (!ATTRIBUTES.has(name)) return `the attribute ${name} is not allowed`;
  if (name in NAMESPACES && value !== NAMESPACES[name]) return `the namespace ${name} is not the SVG one`;
  if ((name === "href" || name === "xlink:href") && !LOCAL_FRAGMENT.test(value)) return "a link points outside the file";
  for (const match of value.matchAll(/url\(\s*([^)]*)\)/gi)) {
    const target = match[1]!.trim().replace(/^["']|["']$/g, "");
    if (!LOCAL_FRAGMENT.test(target)) return "a url() points outside the file";
  }
  if (/[\\]|javascript:|expression\(/i.test(value)) return "a value carries an escape or code";
  return null;
};

/**
 * Why an SVG may not ship, or null when it may.
 *
 * @param text The SVG source.
 */
export const checkSvg = (text: string): string | null => {
  let rest = text.replace(/^﻿/, "").replace(/^<\?xml[^?<>]*\?>/, "");
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[|<\?/i.test(rest)) return "it has a DOCTYPE, an entity, CDATA or a processing instruction";
  if (/&(?!(?:amp|lt|gt|quot|apos);)/.test(rest)) return "it uses a character reference";
  rest = rest.replace(/<!--(?:(?!--)[\s\S])*-->/g, "");
  if (rest.includes("<!")) return "it has a markup declaration";
  const open: string[] = [];
  let sawSvg = false;
  while (rest.length > 0) {
    const lt = rest.indexOf("<");
    const between = lt === -1 ? rest : rest.slice(0, lt);
    if (between.trim() !== "" && !TEXT_ELEMENTS.has(open.at(-1) ?? "")) return "it has text outside a title";
    if (lt === -1) break;
    rest = rest.slice(lt);
    if (rest.startsWith("</")) {
      const close = /^<\/([A-Za-z][A-Za-z0-9:-]*)\s*>/.exec(rest);
      if (close === null) return "a closing tag is malformed";
      if (open.pop() !== close[1]) return "the tags do not nest";
      rest = rest.slice(close[0].length);
      continue;
    }
    const nameMatch = /^<([^\s/>]+)/.exec(rest);
    if (nameMatch === null || !NAME.test(nameMatch[1]!)) return "a tag is malformed";
    const name = nameMatch[1]!;
    if (!ELEMENTS.has(name)) return `the element <${name}> is not allowed`;
    if (open.length === 0) {
      if (name !== "svg" || sawSvg) return "it is not a single SVG";
      sawSvg = true;
    }
    rest = rest.slice(nameMatch[0].length);
    for (;;) {
      const attribute = ATTRIBUTE.exec(rest);
      if (attribute === null) break;
      const problem = checkValue(attribute[1]!, attribute[2] ?? attribute[3] ?? "");
      if (problem !== null) return problem;
      rest = rest.slice(attribute[0].length);
    }
    const end = /^\s*(\/?)>/.exec(rest);
    if (end === null) return "a tag is malformed";
    if (end[1] !== "/") open.push(name);
    rest = rest.slice(end[0].length);
  }
  if (!sawSvg) return "it is not an SVG";
  if (open.length > 0) return "a tag is not closed";
  return null;
};

/** The magic bytes of the raster formats an icon may be in. */
export const rasterKind = (bytes: Uint8Array): "png" | "webp" | "jpg" | null => {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "webp";
  return null;
};
