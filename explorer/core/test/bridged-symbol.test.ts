import { describe, expect, it } from "vitest";
import { BRIDGED_SYMBOL_PREFIX, bridgedSymbolOf, nativeSymbolOf } from "../src/index.js";

describe("the symbol of a bridged copy", () => {
  it("is one z in front of the native symbol", () => {
    expect(BRIDGED_SYMBOL_PREFIX).toBe("z");
    expect(bridgedSymbolOf("WETH")).toBe("zWETH");
  });

  it("gives the copy of a native token that starts with Z the prefix on top of its own Z", () => {
    expect(bridgedSymbolOf("ZRX")).toBe("zZRX");
    expect(bridgedSymbolOf("zkSync")).toBe("zzkSync");
  });

  it("strips the prefix of a copy and nothing else", () => {
    expect(nativeSymbolOf({ symbol: "zWETH", isBridgedCopy: true })).toBe("WETH");
    expect(nativeSymbolOf({ symbol: "zZRX", isBridgedCopy: true })).toBe("ZRX");
  });

  it("does not treat a native token whose symbol starts with Z as a copy", () => {
    expect(nativeSymbolOf({ symbol: "ZRX", isBridgedCopy: false })).toBe("ZRX");
    expect(nativeSymbolOf({ symbol: "ZETA", isBridgedCopy: false })).toBe("ZETA");
    expect(nativeSymbolOf({ symbol: "zkSync", isBridgedCopy: false })).toBe("zkSync");
  });

  it("leaves a copy whose symbol lacks the prefix as it is", () => {
    expect(nativeSymbolOf({ symbol: "WETH", isBridgedCopy: true })).toBe("WETH");
  });
});
