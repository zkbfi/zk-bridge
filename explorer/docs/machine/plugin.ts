/**
 * The Vite plugin of the machine-readable docs. It writes the files of `site-files.ts` into the build output next to
 * `index.html` (`llms.txt`, `docs/<slug>.md`, `data/...`), serves the same files in the dev server, and offers the facts
 * (chains and contracts) to the dapp as the module `virtual:docs-facts`, so the in-app pages show the same resolved
 * values as the Markdown files.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";
import { loadFactsFrom } from "./facts.ts";
import { buildMachineFiles, defaultSources, type MachineSources } from "./site-files.ts";

/** The module the docs import the facts from. */
export const DOCS_FACTS_MODULE = "virtual:docs-facts";
const RESOLVED_FACTS = `\0${DOCS_FACTS_MODULE}`;

const CONTENT_TYPES: Readonly<Record<string, string>> = { md: "text/markdown; charset=utf-8", txt: "text/plain; charset=utf-8", json: "application/json; charset=utf-8" };

/**
 * @param options The repository root, and for tests the sources instead of the ones of the repository.
 */
export const machineDocsPlugin = (options: { readonly repositoryRoot: string; readonly sources?: MachineSources }): Plugin => {
  const sources = options.sources ?? defaultSources(options.repositoryRoot);
  return {
    name: "zk-bridge-machine-docs",
    resolveId(id) {
      return id === DOCS_FACTS_MODULE ? RESOLVED_FACTS : null;
    },
    load(id) {
      if (id !== RESOLVED_FACTS) return null;
      for (const file of readdirSync(sources.deploymentsFolder)) if (file.endsWith(".json")) this.addWatchFile(join(sources.deploymentsFolder, file));
      return `export default ${JSON.stringify(loadFactsFrom(sources.deploymentsFolder))};`;
    },
    generateBundle() {
      for (const [fileName, source] of buildMachineFiles(sources)) this.emitFile({ type: "asset", fileName, source });
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = decodeURIComponent((request.url ?? "").split("?")[0] as string).replace(/^\/+/, "");
        if (path !== "llms.txt" && path !== "llms-full.txt" && !path.startsWith("docs/") && !path.startsWith("data/")) return next();
        let content: string | undefined;
        try {
          content = buildMachineFiles(sources).get(path);
        } catch (error) {
          response.statusCode = 500;
          response.end(String((error as Error).message));
          return;
        }
        if (content === undefined) return next();
        response.setHeader("content-type", CONTENT_TYPES[path.split(".").pop() as string] as string);
        response.end(content);
      });
    },
  };
};
