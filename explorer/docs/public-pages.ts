/**
 * Which operator documents the docs site may publish. Only the paths in `public-pages.json` reach the build: the
 * plugin reads those files itself and hands them to the site as the virtual module `virtual:public-operator-pages`,
 * so no other file in `docs/` is ever bundled. Any import of a `docs/` Markdown file outside the list fails the build,
 * so a glob or an import added later cannot publish an internal document by accident.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Plugin } from "vite";

/** The module the site imports its operator pages from. */
export const PUBLIC_PAGES_MODULE = "virtual:public-operator-pages";
const RESOLVED_MODULE = `\0${PUBLIC_PAGES_MODULE}`;

/** The shape of `public-pages.json`. */
export type PublicPagesFile = { readonly operator: readonly string[] };

/**
 * Checks the list and returns its paths. A path is below `docs/`, ends in `.md`, does not climb out with `..` and is
 * not in `docs/superpowers/` (planning notes are never published).
 *
 * @param list The parsed `public-pages.json`.
 * @throws When the list has the wrong shape or holds a path that may not be published.
 */
export const readAllowlist = (list: unknown): readonly string[] => {
  const operator = (list as Partial<PublicPagesFile> | null)?.operator;
  if (!Array.isArray(operator) || operator.some((entry) => typeof entry !== "string")) {
    throw new Error('public-pages.json needs an "operator" list of paths below docs/.');
  }
  for (const path of operator as string[]) {
    if (!path.endsWith(".md") || path.startsWith("/") || path.split("/").some((segment) => segment === ".." || segment === "." || segment === "")) {
      throw new Error(`public-pages.json: "${path}" is not a Markdown path below docs/, such as "audit/known-issues.md".`);
    }
    if (path.startsWith("superpowers/")) throw new Error(`public-pages.json: "${path}" is in docs/superpowers, which is never published.`);
  }
  return operator as string[];
};

/**
 * Whether a module the bundler loads is a `docs/` Markdown file that the list does not allow.
 *
 * @param id The module id, with an optional query such as `?raw`.
 * @param docsFolder The absolute path of the repository's `docs/` folder.
 * @param allowed The allowed paths below `docs/`.
 * @returns The path below `docs/` of a refused file, or null.
 */
export const refusedDocsImport = (id: string, docsFolder: string, allowed: readonly string[]): string | null => {
  const file = id.split("?")[0] as string;
  if (!file.endsWith(".md")) return null;
  const below = relative(docsFolder, file);
  if (below.startsWith("..") || below === "" || below.startsWith(sep) || /^[A-Za-z]:/.test(below)) return null;
  const path = below.split(sep).join("/");
  return allowed.includes(path) ? null : path;
};

/**
 * The plugin: serves the allowed operator pages as a virtual module and fails the build on any other `docs/` page.
 *
 * @param options The repository root and, for tests, the list itself instead of `public-pages.json`.
 */
export const publicPagesPlugin = (options: { readonly repositoryRoot: string; readonly listFile?: string; readonly list?: unknown }): Plugin => {
  const docsFolder = join(options.repositoryRoot, "docs");
  const listFile = options.listFile ?? join(options.repositoryRoot, "explorer/docs/public-pages.json");
  const allowed = (): readonly string[] => readAllowlist(options.list ?? JSON.parse(readFileSync(listFile, "utf8")));
  return {
    name: "zk-bridge-public-pages",
    enforce: "pre",
    resolveId(id) {
      return id === PUBLIC_PAGES_MODULE ? RESOLVED_MODULE : null;
    },
    load(id) {
      if (id === RESOLVED_MODULE) {
        if (options.list === undefined) this.addWatchFile(listFile);
        const pages: Record<string, string> = {};
        for (const path of allowed()) {
          const file = join(docsFolder, path);
          if (!existsSync(file)) this.error(`public-pages.json lists "${path}", but docs/${path} does not exist.`);
          this.addWatchFile(file);
          pages[`docs/${path}`] = readFileSync(file, "utf8");
        }
        return `export default ${JSON.stringify(pages)};`;
      }
      const refused = refusedDocsImport(id, docsFolder, allowed());
      if (refused !== null) {
        this.error(`docs/${refused} is not in explorer/docs/public-pages.json, so the docs site may not import it. Add it to the list only if it is meant to be public.`);
      }
      return null;
    },
  };
};
