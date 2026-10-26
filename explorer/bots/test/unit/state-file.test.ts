import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createStateFile, StateFileError } from "../../src/runtime/state-file.ts";

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function scratchDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bots-state-file-"));
  scratch.push(directory);
  return directory;
}

const schema = z.object({ count: z.number(), label: z.string() });

describe("reading a state file", () => {
  it("stops with the system error when the path cannot be read, and does not start over", async () => {
    const path = join(await scratchDirectory(), "state.json");
    await mkdir(path);
    const file = createStateFile({ path, schema, initial: { count: 0, label: "" } });
    await expect(file.load()).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("names every field that breaks the shape, in order", async () => {
    const path = join(await scratchDirectory(), "state.json");
    await writeFile(path, JSON.stringify({ count: "three", label: 4 }));
    const file = createStateFile({ path, schema, initial: { count: 0, label: "" } });
    const failure = await file.load().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StateFileError);
    expect((failure as Error).message).toBe(
      `The state file ${path} has an unexpected shape: Invalid input: expected number, received string; Invalid input: expected string, received number.`,
    );
  });
});
