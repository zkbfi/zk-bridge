/**
 * The work of `scripts/build-landing-llms.ts`, with the arguments, the folders and the output given in, so the tests run
 * it on made folders without a child process.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildLandingLlmsFullTxt, buildLandingLlmsTxt, checkLandingLlmsTxt, type LandingChannel } from "./landing-llms.ts";
import { buildLlmsFullTxt, defaultSources, filesOfContent, readMachineContent } from "./site-files.ts";

/** Where the messages go. */
export type CliOutput = { readonly log: (line: string) => void; readonly error: (line: string) => void };

/**
 * Writes llms.txt, llm.txt and llms-full.txt into the site folder of a release.
 *
 * @param argv `<release-directory> <stable|next> <site-directory>`.
 * @param repositoryRoot The repository, for the sources of the pages.
 * @param output Where the messages go.
 * @returns The exit code: 0 when written, 2 for wrong arguments, 1 when the release or the text is wrong.
 */
export const runBuildLandingLlms = (argv: readonly string[], repositoryRoot: string, output: CliOutput): number => {
  const [releaseDirectory, channel, siteDirectory] = argv;
  if (releaseDirectory === undefined || siteDirectory === undefined || (channel !== "stable" && channel !== "next")) {
    output.error("usage: build-landing-llms.ts <release-directory> <stable|next> <site-directory>");
    return 2;
  }
  const manifest = JSON.parse(readFileSync(join(releaseDirectory, "version.json"), "utf8")) as { releases: { name: string; version: string; cid: string }[] };
  const dapp = manifest.releases.find((entry) => entry.name === "dapp");
  if (dapp === undefined) {
    output.error("build-landing-llms: version.json lists no dapp");
    return 1;
  }
  const release = { channel: channel as LandingChannel, version: dapp.version, dappCid: dapp.cid.toLowerCase() };
  const content = readMachineContent(defaultSources(repositoryRoot));
  const text = buildLandingLlmsTxt(content, release);
  const problems = checkLandingLlmsTxt(text, release, new Set(filesOfContent(content).keys()));
  if (problems.length > 0) {
    output.error(problems.map((line) => `build-landing-llms: ${line}`).join("\n"));
    return 1;
  }
  writeFileSync(join(siteDirectory, "llms.txt"), text);
  writeFileSync(join(siteDirectory, "llm.txt"), text);
  writeFileSync(join(siteDirectory, "llms-full.txt"), buildLandingLlmsFullTxt(content, release, buildLlmsFullTxt(content)));
  output.log(`build-landing-llms: wrote llms.txt, llm.txt and llms-full.txt for ${release.version}`);
  return 0;
};
