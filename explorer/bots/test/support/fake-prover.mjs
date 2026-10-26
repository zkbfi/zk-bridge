#!/usr/bin/env node
// A stand-in for `zk-bridge-prover` in tests. It never touches a network. A scenario file says what to answer:
// { logPath, keyVariable, exitCode, stdout, stderr }. The bot writes the prover configuration to
// <state>/tmp/<run>/prover.toml, and the scenario sits at <state>/scenario.json.
// The stand-in records what it was given, so a test can check that the key came in the environment and not on the
// command line, and that the configuration file was private.
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const configPath = args[args.indexOf("--config") + 1];
const scenario = JSON.parse(readFileSync(join(dirname(configPath), "..", "..", "scenario.json"), "utf8"));
appendFileSync(
  scenario.logPath,
  `${JSON.stringify({
    args,
    configPath,
    configMode: (statSync(configPath).mode & 0o777).toString(8),
    configText: readFileSync(configPath, "utf8"),
    keyInEnvironment: process.env[scenario.keyVariable] ?? null,
    parentSecretVisible: process.env.PARENT_SECRET !== undefined,
  })}\n`,
);
if (scenario.stdout) process.stdout.write(`${scenario.stdout}\n`);
if (scenario.stderr) process.stderr.write(`${scenario.stderr}\n`);
process.exit(scenario.exitCode);
