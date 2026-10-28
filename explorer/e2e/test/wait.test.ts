import { describe, expect, it } from "bun:test";
import { waitUntil } from "../src/processes.ts";

describe("waitUntil", () => {
  it("returns the first value that is not undefined", async () => {
    let calls = 0;
    const value = await waitUntil("a value", () => (++calls < 3 ? undefined : "ready"), 10_000);
    expect(value).toBe("ready");
    expect(calls).toBe(3);
  });

  it("keeps waiting after a thrown error and reports the last one on timeout", async () => {
    await expect(waitUntil("a failing check", () => Promise.reject(new Error("node not ready")), 1_500)).rejects.toThrow("node not ready");
  });
});
