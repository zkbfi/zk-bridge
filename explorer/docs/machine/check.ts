/**
 * The checks of the machine-readable docs, shared by `scripts/check-machine-docs.ts` (CI and the web build) and the tests.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { checkAddresses } from "./address-check.ts";
import { allContractAddresses } from "./facts.ts";
import { filesOfContent, readMachineContent, type MachineSources } from "./site-files.ts";

/** The files the checks read next to the sources: the example addresses. */
export type CheckOptions = { readonly examplesFile: string };

const exampleAddresses = (file: string): Set<string> => {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { addresses?: Record<string, string> };
  return new Set(Object.keys(parsed.addresses ?? {}).map((address) => address.toLowerCase()));
};

/**
 * Validates the sources: every page and skill has valid front matter, every placeholder resolves, every address in prose
 * is a known one, and every link of `llms.txt` points at a file that is emitted.
 *
 * @returns The problems, one per line; empty when all is well.
 */
export const checkMachineDocs = (sources: MachineSources, options: CheckOptions): string[] => {
  let content;
  try {
    content = readMachineContent(sources);
  } catch (error) {
    return [(error as Error).message];
  }
  const problems = checkAddresses(content.rawSources, allContractAddresses(content.facts.contracts), exampleAddresses(options.examplesFile));
  const files = filesOfContent(content);
  const llms = files.get("llms.txt") as string;
  for (const link of llms.matchAll(/\]\(([^)]+)\)/g)) {
    if (!files.has(link[1] as string)) problems.push(`llms.txt links ${link[1] as string}, which is not emitted`);
  }
  for (const [path, text] of files) if (path.endsWith(".json")) JSON.parse(text);
  return problems;
};

const walk = (folder: string): string[] =>
  readdirSync(folder, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(folder, entry.name)) : [join(folder, entry.name)]));

/**
 * Compares a built dapp with the files it must hold: every expected file is there with the same text, and nothing else
 * sits under `docs/` or `data/` (a private page that slipped in would show there).
 *
 * @param distFolder The output folder of the web build.
 * @param expected The files by published path, from `filesOfContent`.
 */
export const checkDist = (distFolder: string, expected: ReadonlyMap<string, string>): string[] => {
  const problems: string[] = [];
  for (const [path, text] of expected) {
    const file = join(distFolder, path);
    if (!existsSync(file)) problems.push(`the build is missing ${path}`);
    else if (readFileSync(file, "utf8") !== text) problems.push(`${path} in the build differs from its source`);
  }
  for (const folder of ["docs", "data"]) {
    const root = join(distFolder, folder);
    if (!existsSync(root) || !statSync(root).isDirectory()) continue;
    for (const file of walk(root)) {
      const path = relative(distFolder, file).split(sep).join("/");
      if (!expected.has(path)) problems.push(`the build holds ${path}, which is not a public page, skill or data file`);
    }
  }
  return problems;
};
