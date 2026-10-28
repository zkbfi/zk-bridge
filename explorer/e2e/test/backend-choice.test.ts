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

  test("accepts an E2E_BACKEND that agrees with the key", () => {
    expect(backendOf({ E2E_BACKEND: "oracle" })).toBe("oracle");
    expect(backendOf({ E2E_BACKEND: "remote", RUNPOD_API_KEY: "rpa_x", E2E_RUNPOD_URL: "https://example.invalid" })).toBe("remote");
  });

  test("refuses an E2E_BACKEND that disagrees with the key", () => {
    expect(() => backendOf({ E2E_BACKEND: "remote" })).toThrow(/E2E_BACKEND/);
    expect(() => backendOf({ E2E_BACKEND: "oracle", RUNPOD_API_KEY: "rpa_x", E2E_RUNPOD_URL: "https://example.invalid" })).toThrow(/E2E_BACKEND/);
  });
});
