/**
 * CI check of the machine-readable docs: front matter on every page and skill, placeholders that resolve, addresses in
 * prose that match contracts.json, and links of llms.txt that point at emitted files. With `--dist <folder>` it also
 * checks a built dapp holds exactly the files that the sources make (and no private page).
 *
 * Run: node explorer/docs/scripts/check-machine-docs.ts [--dist explorer/web/dist]
 */
import { fileURLToPath } from "node:url";
import { runCheckMachineDocs } from "../machine/check-cli.ts";

const examplesFile = fileURLToPath(new URL("../machine/example-addresses.json", import.meta.url));
process.exitCode = runCheckMachineDocs(process.argv.slice(2), fileURLToPath(new URL("../../..", import.meta.url)), examplesFile, { log: console.log, error: console.error });
