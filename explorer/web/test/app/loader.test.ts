import { describe, expect, it } from "vitest";
import { loaderHoldMilliseconds, loaderStartFromTiming, MAXIMUM_HOLD_MILLISECONDS, SWIRL_MILLISECONDS } from "../../src/app/loader";

describe("the loader hold", () => {
  it("waits until the first swirl has ended, counted from when the loader arrived", () => {
    expect(loaderHoldMilliseconds({ nowMs: 400, loaderStartMs: 100, reducedMotion: false })).toBe(SWIRL_MILLISECONDS - 300);
    expect(loaderHoldMilliseconds({ nowMs: 400, loaderStartMs: null, reducedMotion: false })).toBe(SWIRL_MILLISECONDS - 400);
  });

  it("does not wait once the swirl is over, or for reduced motion", () => {
    expect(loaderHoldMilliseconds({ nowMs: 5000, loaderStartMs: 100, reducedMotion: false })).toBe(0);
    expect(loaderHoldMilliseconds({ nowMs: 0, loaderStartMs: 0, reducedMotion: true })).toBe(0);
  });

  it("never waits longer than the cap, even for a loader that arrived late", () => {
    expect(loaderHoldMilliseconds({ nowMs: 0, loaderStartMs: 9000, reducedMotion: false })).toBe(MAXIMUM_HOLD_MILLISECONDS);
  });

  it("finds the loader in the resource timing, under any path prefix such as an IPFS gateway's", () => {
    expect(loaderStartFromTiming([{ name: "https://gw.example/ipfs/bafy/loader.svg", responseEnd: 120 }])).toBe(120);
    expect(loaderStartFromTiming([{ name: "https://gw.example/ipfs/bafy/loader-still.svg", responseEnd: 99 }])).toBeNull();
    expect(loaderStartFromTiming([])).toBeNull();
  });
});
