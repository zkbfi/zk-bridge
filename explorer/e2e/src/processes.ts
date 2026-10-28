/**
 * Background processes of the run (the board, the bots) and a polling helper. Each process writes its output to a log
 * file in the state directory. The environment of a process may hold the RunPod key, so the logs never include the
 * environment, and the bots redact the key from their own output.
 */
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "./context.ts";

/** A process that runs in the background. */
export interface Background {
  readonly name: string;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly logFile: string;
  readonly stop: () => Promise<void>;
}

/**
 * Starts a process and returns at once.
 *
 * @param context The run.
 * @param name The name for the log file.
 * @param command The program and its arguments.
 * @param environment The environment of the process.
 * @param cwd The working directory. Default: the repository root.
 */
export const spawnBackground = async (context: Context, name: string, command: readonly string[], environment: Record<string, string>, cwd?: string): Promise<Background> => {
  const logs = join(context.stateDirectory, "logs");
  mkdirSync(logs, { recursive: true });
  const logFile = join(logs, `${name}.log`);
  const descriptor = openSync(logFile, "a");
  const child = Bun.spawn([...command], { cwd: cwd ?? context.repositoryRoot, env: environment, stdout: descriptor, stderr: descriptor });
  const handle: Background = {
    name,
    exited: child.exited,
    get exitCode() {
      return child.exitCode;
    },
    logFile,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await Promise.race([child.exited, new Promise((done) => setTimeout(done, 8_000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    },
  };
  return handle;
};

/** Stops a background process. */
export const stopBackground = (process: Background): Promise<void> => process.stop();

/**
 * Polls until a check gives a value that is not undefined.
 *
 * @param description What the run waits for, for the error message.
 * @param check The check. Return undefined to keep waiting. A thrown error also keeps waiting.
 * @param timeoutMilliseconds The longest wait.
 */
export const waitUntil = async <Value>(description: string, check: () => Promise<Value | undefined> | Value | undefined, timeoutMilliseconds: number): Promise<Value> => {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result !== undefined) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((done) => setTimeout(done, 1_000));
  }
  throw new Error(`timed out waiting for ${description}${lastError instanceof Error ? `: ${lastError.message}` : ""}`);
};
