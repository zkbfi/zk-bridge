#!/usr/bin/env node
// Starts the bots from TypeScript source: the workspace has no build step.
import { register } from "tsx/esm/api";

register();
const { main } = await import("../src/cli.ts");
process.exitCode = await main(process.argv.slice(2), process.env);
