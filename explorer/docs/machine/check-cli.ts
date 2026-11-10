/**
 * The work of `scripts/check-machine-docs.ts`, with the arguments, the folders and the output given in, so the tests run
 * it on made folders without a child process.
 */
import { resolve } from "node:path";
import { checkDist, checkMachineDocs } from "./check.ts";
import type { CliOutput } from "./landing-llms-cli.ts";
import { defaultSources, filesOfContent, readMachineContent } from "./site-files.ts";

/**
 * Checks the machine-readable docs, and with `--dist <folder>` a built dapp too.
 *
 * @param argv The arguments after the script name.
 * @param repositoryRoot The repository, for the sources.
 * @param examplesFile The file that lists the example addresses.
 * @param output Where the messages go.
 * @returns The exit code: 0 when all is well, 1 when there are problems.
 */
export const runCheckMachineDocs = (argv: readonly string[], repositoryRoot: string, examplesFile: string, output: CliOutput): number => {
  const sources = defaultSources(repositoryRoot);
  const problems = checkMachineDocs(sources, { examplesFile });
  const distAt = argv.indexOf("--dist");
  if (problems.length === 0 && distAt !== -1) {
    const folder = argv[distAt + 1];
    if (folder === undefined) problems.push("--dist needs a folder");
    else problems.push(...checkDist(resolve(folder), filesOfContent(readMachineContent(sources))));
  }
  if (problems.length > 0) {
    output.error(problems.map((line) => `check-machine-docs: ${line}`).join("\n"));
    return 1;
  }
  output.log(distAt === -1 ? "check-machine-docs: ok" : "check-machine-docs: ok (dist checked)");
  return 0;
};
