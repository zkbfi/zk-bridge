/**
 * Every class the docs site's components name has a rule in a stylesheet the docs page loads. The docs page opens inside
 * the dapp, so it has the dapp's sheets (`@zkb/react/styles.css`, `bridge.css`) and its own (`explore.css`, `docs.css`).
 * A class renamed in a shared sheet but not in a docs component would otherwise ship unstyled, as the docs search did
 * when the menus moved to the `zb-m-*` classes.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

const SHEETS = ["../../react/styles.css", "../../web/src/bridge/bridge.css", "../../web/src/explore/explore.css", "../src/docs.css"];

/** The class names that a stylesheet gives a rule to (any `.name` in a selector). */
const definedClasses = (css: string): Set<string> => {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors = withoutComments.replace(/\{[^{}]*\}/g, " ");
  return new Set([...selectors.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((match) => match[1] as string));
};

/** The fixed class names in a component's `className` strings; the `${...}` parts of a template are left out. */
export const usedClasses = (source: string): Set<string> => {
  const names = new Set<string>();
  for (const match of source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`)/g)) {
    const fixed = (match[1] ?? match[2] ?? "").replace(/\$\{[^}]*\}/g, " ");
    for (const name of fixed.split(/\s+/)) if (/^[a-z][\w-]*$/.test(name)) names.add(name);
  }
  return names;
};

describe("the docs site's classes", () => {
  const defined = new Set(SHEETS.flatMap((sheet) => [...definedClasses(readFileSync(here(sheet), "utf8"))]));
  const components = readdirSync(here("../src")).filter((name) => name.endsWith(".tsx"));

  it.each(components)("%s names only classes that a loaded stylesheet styles", (component) => {
    const missing = [...usedClasses(readFileSync(here(`../src/${component}`), "utf8"))].filter((name) => !defined.has(name));
    expect(missing).toEqual([]);
  });

  it("reads a class out of a plain string and out of the fixed parts of a template", () => {
    expect([...usedClasses('<a className="zb-a zb-b" /><b className={`zb-c ${x ? "on" : ""}`} />')]).toEqual(["zb-a", "zb-b", "zb-c"]);
  });
});
