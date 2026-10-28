#!/usr/bin/env node
// A stand-in for `zk-bridge-prover` in the local proving tests. It never touches a network. `scenario.json` next to
// this file says what to answer: { logPath, exitCode, stdout, stderrLines }. It records its arguments, the
// configuration text and the mode of the configuration file.
import { appendFileSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const configPath = args[args.indexOf('--config') + 1]
const scenario = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'scenario.json'), 'utf8'))
appendFileSync(
  scenario.logPath,
  `${JSON.stringify({ args, configMode: (statSync(configPath).mode & 0o777).toString(8), configText: readFileSync(configPath, 'utf8') })}\n`,
)
if (scenario.stdout) process.stdout.write(`${scenario.stdout}\n`)
for (const line of scenario.stderrLines ?? []) process.stderr.write(`${line}\n`)
process.exit(scenario.exitCode)
