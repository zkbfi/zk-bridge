import { describe, expect, it } from "vitest";
import { sanitize } from "../src/sanitize.ts";

describe("sanitize", () => {
  it("removes URLs of any scheme, known secrets and long tokens, and shortens the text", () => {
    expect(sanitize("failed to fetch https://rpc.example.org/v2/abc?key=1 and wss://x.example/ws")).toBe("failed to fetch [url] and [url]");
    expect(sanitize("bad hunter2-value here", ["hunter2-value"])).toBe("bad [redacted] here");
    expect(sanitize("token abcdefghijklmnopqrstuvwxyz0123456789 end")).toBe("token [redacted] end");
    expect(sanitize("a\n  b\tc")).toBe("a b c");
    expect(sanitize("x".repeat(400)).length).toBeLessThanOrEqual(200);
    expect(sanitize("x".repeat(30) + " y".repeat(150)).endsWith("...")).toBe(true);
  });
});
