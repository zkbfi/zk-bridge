import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";

/** Another live process holds the lock. The bot refuses to start, because two writers would corrupt the state. */
export class LockHeldError extends Error {
  override readonly name = "LockHeldError";
}

/** Input of {@link acquireLock}. */
export interface AcquireLockInput {
  readonly path: string;
  /** The process identifier to store. The default is the identifier of this process. */
  readonly processIdentifier?: number;
  /** Says whether a process lives. The default sends signal 0, which delivers nothing. Tests replace it. */
  readonly isProcessAlive?: (processIdentifier: number) => boolean;
}

/** A held lock. */
export interface HeldLock {
  /** Removes the lock file when this process still owns it. Calling it again does nothing. */
  release(): Promise<void>;
}

/** Says whether a process with this identifier lives. A process that exists but belongs to another user lives. */
export function isProcessAlive(processIdentifier: number): boolean {
  try {
    process.kill(processIdentifier, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The process identifier in a lock file, "missing" when there is no file, or "unreadable" when the file holds no identifier. */
async function readHolder(path: string): Promise<number | "missing" | "unreadable"> {
  try {
    const text = (await readFile(path, "utf8")).trim();
    return /^\d+$/.test(text) ? Number(text) : "unreadable";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function createExclusively(path: string, processIdentifier: number): Promise<boolean> {
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(`${processIdentifier}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/** The most times one call tries to take over a stale lock that other starting processes also try to take. */
const MAXIMUM_ATTEMPTS = 5;

/**
 * Takes an exclusive lock file. The file is created with the exclusive flag and holds the process identifier. A lock
 * whose process is gone is stale, and this call takes it over. A lock whose process lives, this process included, is
 * refused.
 *
 * @throws LockHeldError when a live process holds the lock, or when the file holds no process identifier.
 */
export async function acquireLock(input: AcquireLockInput): Promise<HeldLock> {
  const processIdentifier = input.processIdentifier ?? process.pid;
  const alive = input.isProcessAlive ?? isProcessAlive;
  await mkdir(dirname(input.path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < MAXIMUM_ATTEMPTS; attempt += 1) {
    if (await createExclusively(input.path, processIdentifier)) return lockHeldBy(input.path, processIdentifier);
    const holder = await readHolder(input.path);
    if (holder === "missing") continue;
    // A file with no identifier may be a writer in mid-write, so do not guess that it is stale.
    if (holder === "unreadable") throw new LockHeldError(`The lock file ${input.path} holds no process identifier. Remove it when no bot runs.`);
    if (alive(holder)) throw new LockHeldError(`The lock file ${input.path} is held by the live process ${holder}. Another bot uses this state.`);
    // Stale. Take it over only when it still names the same dead process, so a fresh lock is never removed.
    if ((await readHolder(input.path)) === holder) await rm(input.path, { force: true });
  }
  throw new LockHeldError(`The lock file ${input.path} stayed contended after ${MAXIMUM_ATTEMPTS} attempts.`);
}

function lockHeldBy(path: string, processIdentifier: number): HeldLock {
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      if ((await readHolder(path)) !== processIdentifier) return;
      await rm(path, { force: true });
    },
  };
}
