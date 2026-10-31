import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as core from "../src/index.js";
import vectors from "../vectors/fee-rules-vectors.json" with { type: "json" };

/**
 * The runner for `@zkb/core/vectors`: loads the JSON file that ships with the package and checks that it is
 * well formed and that the public API is what the README lists. The per-rule checks of every case against the functions
 * ("the fixed vectors") are in fee-rules.test.ts, which reads the same file; a port in another language reads that file too.
 */
describe("the shipped vectors", () => {
  it("is the file that the package exports as ./vectors", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { exports: Record<string, unknown> };
    expect(manifest.exports["./vectors"]).toBe("./vectors/fee-rules-vectors.json");
    expect(JSON.parse(readFileSync(new URL("../vectors/fee-rules-vectors.json", import.meta.url), "utf8"))).toEqual(vectors);
  });

  it("holds, for every rule group, cases with an input and an output, and each group is named after a public function", () => {
    const groups = Object.entries(vectors).filter(([, value]) => Array.isArray(value)) as [string, object[]][];
    expect(groups.length).toBeGreaterThan(0);
    for (const [name, cases] of groups) {
      expect(cases.length, name).toBeGreaterThan(0);
      expect(typeof (core as Record<string, unknown>)[name], name).toBe("function");
      for (const entry of cases) expect(entry, name).toHaveProperty(["input"]);
      for (const entry of cases) expect(entry, name).toHaveProperty(["output"]);
    }
  });
});

describe("the public surface", () => {
  it("exports the rule functions the README lists", () => {
    for (const name of ["defaultFee", "feeWarnings", "gasRange", "hardCapCheck", "clampAutoCap", "encodeFeeDirector", "decodeFeeDirector", "expectedFee", "maximumFee", "defaultTipChoiceOf", "lnScaled", "expNegScaled", "formatTokenAmount", "parseTokenAmount", "plsQuoteOf", "tokenQuoteOf", "pricingAddress"]) {
      expect(typeof (core as Record<string, unknown>)[name], name).toBe("function");
    }
  });
});
