import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// A release by another process between our create attempt and our read cannot be timed on a real disk, so the first
// read of the lock file reports that the file is gone.
const readFileGone = vi.hoisted(() => ({ remaining: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    readFile: (async (...args: Parameters<typeof original.readFile>) => {
      if (readFileGone.remaining > 0) {
        readFileGone.remaining -= 1;
        await original.rm(args[0] as string);
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      }
      return original.readFile(...args);
    }) as typeof original.readFile,
  };
});

const { acquireLock } = await import("../../src/runtime/lock-file.ts");

let directory = "";
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("acquireLock when the holder releases during the attempt", () => {
  it("tries again at once and takes the lock", async () => {
    directory = await mkdtemp(join(tmpdir(), "bots-lock-race-"));
    const path = join(directory, "held.lock");
    await writeFile(path, "999999\n");
    readFileGone.remaining = 1;
    const held = await acquireLock({ path, processIdentifier: 555_555, isProcessAlive: () => true });
    expect(readFileGone.remaining).toBe(0);
    await held.release();
  });
});
