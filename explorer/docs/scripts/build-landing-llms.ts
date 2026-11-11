/**
 * Writes llms.txt, llms-full.txt and llm.txt into the unpacked landing site of a release.
 *
 * Run: node explorer/docs/scripts/build-landing-llms.ts <release-directory> <stable|next> <site-directory>
 * Called by script/release/publish-pages.sh after it has verified the release. It reads the dapp's CID and version from
 * the release's version.json, and checks its own output with the same check the tests use.
 */
import { fileURLToPath } from "node:url";
import { runBuildLandingLlms } from "../machine/landing-llms-cli.ts";

process.exitCode = runBuildLandingLlms(process.argv.slice(2), fileURLToPath(new URL("../../..", import.meta.url)), { log: console.log, error: console.error });
