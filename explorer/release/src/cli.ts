/** Process entry of the release command line: `node explorer/release/src/cli.ts <command> ...`. See main.ts. */
import { run } from "./main.ts";

process.exitCode = await run(process.argv.slice(2), {
  stdin: process.stdin,
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
