/**
 * Writes llms.txt, llms-full.txt and llm.txt into the unpacked landing site of a release.
 *
 * Run: node explorer/docs/scripts/build-landing-llms.ts <release-directory> <stable|next> <site-directory>
 * Called by script/release/publish-pages.sh after it has verified the release. It reads the dapp's CID and version from
 * the release's version.json, and checks its own output with the same check the tests use.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLandingLlmsFullTxt, buildLandingLlmsTxt, checkLandingLlmsTxt, type LandingChannel } from "../machine/landing-llms.ts";
import { buildLlmsFullTxt, defaultSources, filesOfContent, readMachineContent } from "../machine/site-files.ts";

const [releaseDirectory, channel, siteDirectory] = process.argv.slice(2);
if (releaseDirectory === undefined || siteDirectory === undefined || (channel !== "stable" && channel !== "next")) {
  console.error("usage: build-landing-llms.ts <release-directory> <stable|next> <site-directory>");
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(join(releaseDirectory, "version.json"), "utf8")) as { releases: { name: string; version: string; cid: string }[] };
const dapp = manifest.releases.find((entry) => entry.name === "dapp");
if (dapp === undefined) {
  console.error("build-landing-llms: version.json lists no dapp");
  process.exit(1);
}
const release = { channel: channel as LandingChannel, version: dapp.version, dappCid: dapp.cid.toLowerCase() };
const content = readMachineContent(defaultSources(fileURLToPath(new URL("../../..", import.meta.url))));
const text = buildLandingLlmsTxt(content, release);
const problems = checkLandingLlmsTxt(text, release, new Set(filesOfContent(content).keys()));
if (problems.length > 0) {
  console.error(problems.map((line) => `build-landing-llms: ${line}`).join("\n"));
  process.exit(1);
}
writeFileSync(join(siteDirectory, "llms.txt"), text);
writeFileSync(join(siteDirectory, "llm.txt"), text);
writeFileSync(join(siteDirectory, "llms-full.txt"), buildLandingLlmsFullTxt(content, release, buildLlmsFullTxt(content)));
console.log(`build-landing-llms: wrote llms.txt, llm.txt and llms-full.txt for ${release.version}`);
