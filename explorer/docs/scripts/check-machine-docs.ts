/**
 * CI check of the machine-readable docs: front matter on every page and skill, placeholders that resolve, addresses in
 * prose that match contracts.json, and links of llms.txt that point at emitted files. With `--dist <folder>` it also
 * checks a built dapp holds exactly the files that the sources make (and no private page).
 *
 * Run: node explorer/docs/scripts/check-machine-docs.ts [--dist explorer/web/dist]
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { checkDist, checkMachineDocs } from "../machine/check.ts";
import { filesOfContent, defaultSources, readMachineContent } from "../machine/site-files.ts";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const sources = defaultSources(repositoryRoot);
const examplesFile = fileURLToPath(new URL("../machine/example-addresses.json", import.meta.url));

const problems = checkMachineDocs(sources, { examplesFile });
const distAt = process.argv.indexOf("--dist");
if (problems.length === 0 && distAt !== -1) {
  const folder = process.argv[distAt + 1];
  if (folder === undefined) problems.push("--dist needs a folder");
  else problems.push(...checkDist(resolve(folder), filesOfContent(readMachineContent(sources))));
}
if (problems.length > 0) {
  console.error(problems.map((line) => `check-machine-docs: ${line}`).join("\n"));
  process.exit(1);
}
console.log(distAt === -1 ? "check-machine-docs: ok" : "check-machine-docs: ok (dist checked)");
