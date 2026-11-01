import { describe, expect, it } from "vitest";
import { labelOf, symbolOf } from "../src/deps.ts";
import { makeDeps } from "./support.ts";

describe("labels", () => {
  it("names a chain from the configuration, and falls back for a chain it does not know", () => {
    const deps = makeDeps();
    expect(labelOf(deps, 943)).toBe("PulseChain testnet");
    expect(symbolOf(deps, 943)).toBe("tPLS");
    expect(labelOf(deps, 5)).toBe("chain 5");
    expect(symbolOf(deps, 5)).toBe("");
  });
});
