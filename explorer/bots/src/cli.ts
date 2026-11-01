import { redactError } from "@zk-bridge/shared/config";
import { loadBotContext, type BotContext } from "./runtime/context.ts";
import { BotConfigError } from "./config/bot-config.ts";
import { startPublisher } from "./publisher/service.ts";
import { startRunner } from "./runner/service.ts";
import { startTraffic } from "./traffic/service.ts";
import type { Environment } from "./runtime/secrets.ts";

const USAGE = `Usage: zk-bridge-bot <publisher|runner|traffic> --config <file> [--once]

  publisher   prove light client updates on the remote graphics processor and post them on msgboard
  runner      check proof messages, post updates and deliver covered transfers for their fee
  traffic     send test transfers back and forth on a schedule (testnets)

  --config    the bot configuration file (JSON)
  --once      run one pass and exit, instead of running until stopped (traffic: send once in each
              enabled direction now)
`;

/** The parsed command line. */
export interface CommandLine {
  readonly role: "publisher" | "runner" | "traffic";
  readonly configPath: string;
  readonly runOnce: boolean;
}

/**
 * Reads the arguments after the program name.
 *
 * @throws BotConfigError for a role that does not exist, a missing `--config`, or an unknown flag.
 */
export function parseCommandLine(argv: readonly string[]): CommandLine {
  const [role, ...rest] = argv;
  if (role !== "publisher" && role !== "runner" && role !== "traffic") throw new BotConfigError(`Choose publisher, runner or traffic.\n\n${USAGE}`);
  let configPath: string | undefined;
  let runOnce = false;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === "--once") runOnce = true;
    else if (flag === "--config") configPath = rest[++index];
    else throw new BotConfigError(`Unknown argument ${flag}.\n\n${USAGE}`);
  }
  if (configPath === undefined || configPath === "") throw new BotConfigError(`--config <file> is required.\n\n${USAGE}`);
  return { role, configPath, runOnce };
}

/** Stops the bot on SIGINT or SIGTERM, after the current step. */
function abortOnSignals(): AbortController {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return controller;
}

async function run(line: CommandLine, context: BotContext): Promise<void> {
  const controller = abortOnSignals();
  if (line.role === "publisher") {
    await startPublisher({ context, signal: controller.signal, runOnce: line.runOnce });
    return;
  }
  if (line.role === "traffic") {
    await startTraffic({ context, signal: controller.signal, runOnce: line.runOnce });
    return;
  }
  await startRunner({ context, signal: controller.signal, runOnce: line.runOnce });
}

/**
 * The command line entry. Logs go to standard error as JSON lines; nothing else prints.
 *
 * @returns The process exit code: 0 after a clean stop, 1 for an error.
 */
export async function main(argv: readonly string[], environment: Environment): Promise<number> {
  let context: BotContext | null = null;
  try {
    const line = parseCommandLine(argv);
    context = await loadBotContext({ configPath: line.configPath, environment, write: (text) => process.stderr.write(`${text}\n`) });
    await run(line, context);
    return 0;
  } catch (error) {
    // Errors pass through the same redactor as logs when a context exists.
    const secrets = context?.vault.knownSecrets() ?? [];
    process.stderr.write(`${redactError(error, secrets)}\n`);
    return 1;
  }
}
