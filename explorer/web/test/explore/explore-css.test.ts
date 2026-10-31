import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = `${import.meta.dirname}/../../src`;
const explore = readFileSync(`${dir}/explore/explore.css`, "utf8");
const bridge = readFileSync(`${dir}/bridge/bridge.css`, "utf8");

/** The declarations of the first rule whose selector is exactly `selector`. */
const rule = (css: string, selector: string): string => {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} exists`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
};

describe("numbers under one are never cut off (owner: \"the sub zero value is being cut off in the explorer tab\")", () => {
  it("lets a browse tile's number column grow to the widest number, shared by every tile", () => {
    expect(rule(explore, ".zb-browse")).toContain("minmax(9.5ch, max-content)");
    expect(rule(explore, ".zb-tile")).toContain("grid-template-columns: subgrid");
    expect(rule(explore, ".zb-tile-n")).not.toMatch(/overflow/);
  });

  it("clips a long row title sideways only, so the subscript of 0.0₆315 keeps its descent", () => {
    for (const [css, selector] of [
      [explore, ".zb-xrow-text > b"],
      [bridge, ".zb-amount-out"],
    ] as const) {
      const body = rule(css, selector);
      expect(body).toContain("overflow-x: clip");
      expect(body).toContain("overflow-y: visible");
      expect(body).not.toContain("overflow: hidden");
    }
  });
});
