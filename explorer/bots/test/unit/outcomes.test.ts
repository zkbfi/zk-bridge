import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileOutcomeSink } from "../../src/runner/outcomes.ts";

const SECRET = "sk-test-secret-value-1234567890";

async function sinkIn(secrets: readonly string[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "outcomes-"));
  const path = join(directory, "nested", "outcomes.jsonl");
  return { path, sink: createFileOutcomeSink({ path, now: () => new Date(0), knownSecrets: () => secrets }) };
}

const linesOf = async (path: string) => (await readFile(path, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

describe("the file outcome sink", () => {
  it("writes amounts as decimal strings, also inside lists and nested objects, and keeps other values as they are", async () => {
    const { path, sink } = await sinkIn();
    await sink.record({
      kind: "delivery",
      pair: "eth-pls",
      direction: "first-to-second",
      status: "delivered",
      gasUsed: 300_000n,
      amounts: [1n, { inner: 2n }, "text", null],
      nothing: null,
      flag: true,
    });
    expect(await linesOf(path)).toEqual([
      {
        time: "1970-01-01T00:00:00.000Z",
        kind: "delivery",
        pair: "eth-pls",
        direction: "first-to-second",
        status: "delivered",
        gasUsed: "300000",
        amounts: ["1", { inner: "2" }, "text", null],
        nothing: null,
        flag: true,
      },
    ]);
  });

  it("appends one line for each record, creates the directory, and limits the file to its owner", async () => {
    const { path, sink } = await sinkIn();
    await sink.record({ kind: "update", pair: "eth-pls", direction: "first-to-second", status: "posted" });
    await sink.record({ kind: "update", pair: "eth-pls", direction: "first-to-second", status: "refused" });
    expect((await linesOf(path)).map((line) => line.status)).toEqual(["posted", "refused"]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("removes a known secret from the line", async () => {
    const { path, sink } = await sinkIn([SECRET]);
    await sink.record({ kind: "delivery", pair: "eth-pls", direction: "first-to-second", status: "failed", detail: `the call failed with key ${SECRET}` });
    const text = await readFile(path, "utf8");
    expect(text).not.toContain(SECRET);
    expect(text).toContain("the call failed with key");
  });
});
