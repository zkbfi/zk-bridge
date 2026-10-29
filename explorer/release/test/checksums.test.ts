import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatSha256Sums, parseSha256Sums, sha256File } from "../src/checksums.ts";
import { temporaryDirectory, writeTree } from "./helpers.ts";

describe("sha256File", () => {
  it("hashes the file contents as lower-case hex", async () => {
    const root = await temporaryDirectory();
    await writeTree(root, { "a.txt": "abc" });
    expect(await sha256File(join(root, "a.txt"))).toBe(createHash("sha256").update("abc").digest("hex"));
  });
});

describe("SHA256SUMS", () => {
  it("writes sorted lines in the format of sha256sum and reads them back", () => {
    const text = formatSha256Sums([
      { file: "downloads/b", sha256: "b".repeat(64) },
      { file: "archives/a.car", sha256: "a".repeat(64) },
    ]);
    expect(text).toBe(`${"a".repeat(64)}  archives/a.car\n${"b".repeat(64)}  downloads/b\n`);
    expect(parseSha256Sums(text)).toEqual(
      new Map([
        ["archives/a.car", "a".repeat(64)],
        ["downloads/b", "b".repeat(64)],
      ]),
    );
  });

  it("refuses a line that is not a hash and a name", () => {
    expect(() => parseSha256Sums("nothing here\n")).toThrow(/line 1/);
  });
});
