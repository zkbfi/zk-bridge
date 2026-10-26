import { writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireLock, isProcessAlive, LockHeldError } from "../../src/runtime/lock-file.ts";

const scratch: string[] = [];
afterEach(async () => {
  for (const path of scratch.splice(0)) {
    await chmod(path, 0o700).catch(() => undefined);
    await rm(path, { recursive: true, force: true });
  }
});
async function scratchDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bots-lock-"));
  scratch.push(directory);
  return directory;
}

describe("isProcessAlive", () => {
  it("says the current process lives", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("says a process lives when the system refuses the signal for lack of permission", () => {
    // Process 1 belongs to the superuser, so an ordinary user gets EPERM and the process still lives.
    expect(isProcessAlive(1)).toBe(true);
  });

  it("says a process that does not exist is gone", () => {
    expect(isProcessAlive(2 ** 22 + 12_345)).toBe(false);
  });
});

describe("acquireLock failure paths", () => {
  it("passes on a read error that is not a missing file, instead of treating the lock as free", async () => {
    // A directory at the lock path makes the exclusive create fail with EEXIST, then the read fails with EISDIR.
    const path = join(await scratchDirectory(), "held.lock");
    await mkdir(path);
    await expect(acquireLock({ path })).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("passes on a create error that is not EEXIST, instead of reading a holder", async () => {
    const directory = await scratchDirectory();
    await chmod(directory, 0o500);
    await expect(acquireLock({ path: join(directory, "held.lock") })).rejects.toMatchObject({ code: "EACCES" });
  });

  it("leaves a lock alone when it changed to another process while this call judged it stale", async () => {
    const path = join(await scratchDirectory(), "held.lock");
    await writeFile(path, "111111\n");
    const asked: number[] = [];
    // The first holder is dead. While this call judges it, another process takes the lock.
    const stub = (identifier: number): boolean => {
      asked.push(identifier);
      if (identifier !== 111_111) return true;
      writeFileSync(path, "222222\n");
      return false;
    };
    await expect(acquireLock({ path, isProcessAlive: stub })).rejects.toThrow(`The lock file ${path} is held by the live process 222222. Another bot uses this state.`);
    expect(asked).toEqual([111_111, 222_222]);
    expect(await readFile(path, "utf8")).toBe("222222\n");
  });

  it("gives up after five attempts when other processes keep taking the lock", async () => {
    const path = join(await scratchDirectory(), "held.lock");
    await writeFile(path, "100001\n");
    let next = 100_001;
    const asked: number[] = [];
    const stub = (identifier: number): boolean => {
      asked.push(identifier);
      next += 1;
      writeFileSync(path, `${next}\n`);
      return false;
    };
    await expect(acquireLock({ path, isProcessAlive: stub })).rejects.toThrow(`The lock file ${path} stayed contended after 5 attempts.`);
    expect(asked).toEqual([100_001, 100_002, 100_003, 100_004, 100_005]);
  });
});

describe("a held lock", () => {
  it("removes the file once, and a second release does nothing even after another process takes the lock", async () => {
    const path = join(await scratchDirectory(), "held.lock");
    const held = await acquireLock({ path, processIdentifier: 424_242, isProcessAlive: () => true });
    await held.release();
    await writeFile(path, "424242\n");
    await held.release();
    expect(await readFile(path, "utf8")).toBe("424242\n");
  });
});
