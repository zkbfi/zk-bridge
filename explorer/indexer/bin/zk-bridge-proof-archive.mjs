#!/usr/bin/env node
// Moves the proof archive into and out of databases: deploy/app-server/proofs.sh runs it (docs/proof-archive.md).
// Runs the TypeScript source with tsx, because the workspace has no build step.
import { register } from "tsx/esm/api";

register();
const { main } = await import("../src/proof-archive/cli.ts");
process.exitCode = await main(process.argv.slice(2), process.env);
