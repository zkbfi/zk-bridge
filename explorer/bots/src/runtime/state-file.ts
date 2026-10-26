import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { z } from "zod";

/** A small file of JSON state that a bot keeps between runs. */
export interface StateFile<State> {
  /** Reads the state. A missing file gives `initial`. @throws StateFileError for a file that is not valid. */
  load(): Promise<State>;
  /** Writes the state with mode 0600 through a temporary file and a rename, so a crash leaves the old or the new file. */
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
}

/** Builds a state file over the file system. */
export function createStateFile<State>(input: StateFileInput<State>): StateFile<State> {
  return {
    async load() {
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
    },
    async save(state) {
      await mkdir(dirname(input.path), { recursive: true, mode: 0o700 });
      const temporary = `${input.path}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, input.path);
    },
  };
}
