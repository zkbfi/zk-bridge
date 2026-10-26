import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { z } from "zod";
import { createSerialQueue, type SerialQueue } from "../runner/serial-queue.ts";

/**
 * The part of a state file that a writer that shares the file must use. `update` is the only way to change the state
 * without a lost update, because it applies the change to the state that it loads under the lock of the file.
 */
export interface StateStore<State> {
  /** Reads the state. A missing file gives `initial`. @throws StateFileError for a file that is not valid. */
  load(): Promise<State>;
  /**
   * Loads the freshest state under the lock of the file, applies `mutate` to it, and writes the result atomically.
   * A `mutate` that returns the state it was given writes nothing. `mutate` must not call `update` on the same file.
   * @returns The state after the change.
   */
  update(mutate: (state: State) => State): Promise<State>;
}

/** A small file of JSON state that a bot keeps between runs. */
export interface StateFile<State> extends StateStore<State> {
  /**
   * Writes a complete state, through the same lock and the same atomic write as `update`. Use it only for a file with
   * one writer that holds the whole state; a writer that shares the file must use `update`.
   */
  save(state: State): Promise<void>;
}

/** The state file exists and is not valid. The bot stops instead of starting over, because the state may hold a costly proof. */
export class StateFileError extends Error {
  override readonly name = "StateFileError";
}

/** Input of {@link createStateFile}. */
export interface StateFileInput<State> {
  readonly path: string;
  readonly schema: z.ZodType<State>;
  readonly initial: State;
  /** Replaces the rename that publishes the new file. Tests use it to interrupt a write. */
  readonly renameFile?: (from: string, to: string) => Promise<void>;
}

/** One queue for each state file path of this process, so every handle on one file takes the same lock. */
const queuesByPath = new Map<string, SerialQueue>();

function queueOf(path: string): SerialQueue {
  const key = resolve(path);
  const known = queuesByPath.get(key) ?? createSerialQueue();
  queuesByPath.set(key, known);
  return known;
}

async function readState<State>(input: StateFileInput<State>): Promise<State> {
  let text: string;
  try {
    text = await readFile(input.path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return input.initial;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new StateFileError(`The state file ${input.path} is not valid JSON. Move it away to start from nothing.`);
  }
  const parsed = input.schema.safeParse(value);
  if (!parsed.success) throw new StateFileError(`The state file ${input.path} has an unexpected shape: ${parsed.error.issues[0]?.message ?? "invalid"}.`);
  return parsed.data;
}

/** Flushes a directory entry to disk. A platform that cannot open a directory skips the flush. */
async function flushDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Some platforms refuse to open or sync a directory. The rename is still atomic there.
  }
}

/**
 * Writes the state to a temporary file in the same directory, flushes it, and renames it over the target. A crash
 * leaves the old file or the new file, never a part of the new one. A failed write removes the temporary file.
 */
async function writeAtomically<State>(input: StateFileInput<State>, state: State): Promise<void> {
  const directory = dirname(input.path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${input.path}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, 0o600);
    await (input.renameFile ?? rename)(temporary, input.path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  await flushDirectory(directory);
}

/** Builds a state file over the file system. Every handle on one path in this process shares one lock. */
export function createStateFile<State>(input: StateFileInput<State>): StateFile<State> {
  const queue = queueOf(input.path);
  return {
    load: () => readState(input),
    update: (mutate) =>
      queue.run(async () => {
        const current = await readState(input);
        const next = mutate(current);
        if (next === current) return current;
        await writeAtomically(input, next);
        return next;
      }),
    save: (state) => queue.run(() => writeAtomically(input, state)),
  };
}
