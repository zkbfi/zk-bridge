import { describe, expect, test } from "bun:test";
import { backendOf } from "../src/context";

describe("backendOf", () => {
  test("chooses oracle when no RunPod key is set", () => {
    expect(backendOf({})).toBe("oracle");
  });

  test("chooses remote when a RunPod key is set", () => {
    expect(backendOf({ RUNPOD_API_KEY: "rpa_x", E2E_RUNPOD_URL: "https://example.invalid" })).toBe("remote");
  });

  test("refuses remote without an endpoint", () => {
    expect(() => backendOf({ RUNPOD_API_KEY: "rpa_x" })).toThrow(/E2E_RUNPOD_URL/);
  });

  test("treats an empty key as no key", () => {
    expect(backendOf({ RUNPOD_API_KEY: "" })).toBe("oracle");
  });
});
