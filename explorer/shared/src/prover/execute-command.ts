import { spawn } from "node:child_process";

/** One command to run. The environment lists every variable the child sees: nothing else is inherited. */
export interface CommandSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMilliseconds: number;
}

/** What a finished command left behind. */
export interface CommandOutput {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a command to its end. Tests and the real process use the same type. */
export type CommandExecutor = (spec: CommandSpec) => Promise<CommandOutput>;

/** A command ran longer than its limit and was stopped. */
export class CommandTimeoutError extends Error {
  override readonly name = "CommandTimeoutError";
}

/** A command could not start, for example because the file is missing. */
export class CommandStartError extends Error {
  override readonly name = "CommandStartError";
}

/**
 * Runs a real process. A secret travels in `environment` and never in `args`, because other users can read a command
 * line. The child gets a standard input that is closed at once.
 *
 * @throws CommandTimeoutError when the command outlives `timeoutMilliseconds`; the process receives SIGKILL.
 * @throws CommandStartError when the process cannot start.
 */
export const executeCommand: CommandExecutor = (spec) =>
  new Promise((resolve, reject) => {
    const child = spawn(spec.command, [...spec.args], { env: { ...spec.environment }, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, spec.timeoutMilliseconds);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new CommandStartError(`cannot start ${spec.command}: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new CommandTimeoutError(`${spec.command} ran longer than ${spec.timeoutMilliseconds} milliseconds`));
        return;
      }
      resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
