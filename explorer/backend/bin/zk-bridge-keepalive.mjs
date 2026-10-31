#!/usr/bin/env node
// Keeps the light clients of a pair able to move: `status` judges them, `march` proves them forward.
// Runs the TypeScript source with tsx, because the workspace has no build step. See docs/testnet-run.md.
import { register } from "tsx/esm/api";

register();
const { main } = await import("./keepalive.ts");
process.exitCode = await main(process.argv.slice(2), process.env);
