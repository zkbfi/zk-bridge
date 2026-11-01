import { describe, expect, it } from "vitest";
import { arrivesAsSymbol } from "../../src/bridge/bridge-model";

describe("what a token arrives as", () => {
  it("is the copy's symbol for a native token and the native symbol for a copy", () => {
    expect(arrivesAsSymbol({ symbol: "USDC" })).toBe("zUSDC");
    expect(arrivesAsSymbol({ symbol: "zUSDC", isBridgedCopy: true })).toBe("USDC");
  });

  it("does not take a native token whose symbol starts with Z for a copy", () => {
    expect(arrivesAsSymbol({ symbol: "ZRX", isBridgedCopy: false })).toBe("zZRX");
    expect(arrivesAsSymbol({ symbol: "ZETA" })).toBe("zZETA");
    expect(arrivesAsSymbol({ symbol: "zkSync" })).toBe("zzkSync");
    expect(arrivesAsSymbol({ symbol: "zZRX", isBridgedCopy: true })).toBe("ZRX");
  });
});
