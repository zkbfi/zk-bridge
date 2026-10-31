import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AUTO_CAP_PERCENT, DEFAULT_HARD_CAP_PERCENT, loadFeeCap, loadHardCap, saveFeeCap, saveHardCap } from "../src/fee-cap.js";

beforeEach(() => {
  window.localStorage.clear();
});

describe("the stored cap", () => {
  it("defaults to 1%, keeps a valid value in this browser, and refuses others", () => {
    expect(DEFAULT_AUTO_CAP_PERCENT).toBe(1);
    expect(loadFeeCap()).toBe(1);
    expect(saveFeeCap("0.5")).toBeNull();
    expect(loadFeeCap()).toBe(0.5);
    expect(saveFeeCap("abc")).not.toBeNull();
    expect(saveFeeCap("0")).not.toBeNull();
    expect(saveFeeCap(null)).toBeNull();
    expect(loadFeeCap()).toBe(1);
  });
});

describe("the stored hard cap (owner, quote 86)", () => {
  it("defaults to 2%, keeps a valid value, and refuses others", () => {
    expect(DEFAULT_HARD_CAP_PERCENT).toBe(2);
    expect(loadHardCap()).toBe(2);
    expect(saveHardCap("3")).toBeNull();
    expect(loadHardCap()).toBe(3);
    expect(saveHardCap("-1")).not.toBeNull();
    expect(saveHardCap(null)).toBeNull();
    expect(loadHardCap()).toBe(2);
  });

  it("never lets the automatic cap above it: saving refuses, and lowering the hard cap takes the automatic cap down", () => {
    expect(saveFeeCap("2.5")).toMatch(/hard cap/);
    expect(saveFeeCap("1.5")).toBeNull();
    expect(saveHardCap("0.8")).toBeNull();
    expect(loadFeeCap()).toBe(0.8);
    // A stored automatic cap above the hard cap (an older browser) reads as the hard cap.
    window.localStorage.setItem("zk-bridge-explorer.fee-cap", "5");
    expect(loadFeeCap()).toBe(0.8);
  });

  it("reads the 2% default against a storage it cannot read, and keeps the visit's choice when it cannot write", () => {
    const writeOnly = { setItem: () => undefined, removeItem: () => undefined };
    expect(saveFeeCap("2.5", writeOnly)).toMatch(/2% hard cap/);
    expect(saveFeeCap("1.5", null)).toBeNull();
    const broken = { getItem: () => null, setItem: () => { throw new Error("full"); }, removeItem: () => { throw new Error("full"); } };
    expect(saveHardCap("3", broken)).toBeNull();
    const throwing = { getItem: () => { throw new Error("blocked"); } };
    expect(loadHardCap(throwing)).toBe(2);
  });
});

describe("the browser's own storage", () => {
  it("is not used when the browser refuses it: the defaults stand and nothing is stored", () => {
    const spy = vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(loadFeeCap()).toBe(1);
    expect(loadHardCap()).toBe(2);
    expect(saveHardCap("3")).toBeNull();
    spy.mockRestore();
  });
});
