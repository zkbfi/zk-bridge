#!/usr/bin/env node
// Starts the backend from TypeScript source: the workspace has no build step.
import { register } from "tsx/esm/api";

register();
const { main } = await import("../src/main.ts");
process.exitCode = await main(process.argv.slice(2), process.env);
