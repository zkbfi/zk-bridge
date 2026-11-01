import { describe, expect, it } from "vitest";
import { duration, shorten } from "../src/format.ts";

describe("format", () => {
  it("writes spans in plain words", () => {
    expect(duration(45)).toBe("45 s");
    expect(duration(-3)).toBe("0 s");
    expect(duration(600)).toBe("10 min");
    expect(duration(3599)).toBe("59 min");
    expect(duration(7200)).toBe("2 h");
    expect(duration(5400)).toBe("1.5 h");
    expect(duration(26 * 3600)).toBe("26 h");
  });
  it("shortens long values", () => {
    expect(shorten("abcdefghijklmnop")).toBe("abcdefghij...");
    expect(shorten("abc")).toBe("abc");
  });
});
