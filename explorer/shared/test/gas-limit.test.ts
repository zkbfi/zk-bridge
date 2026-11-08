import { CALL_GAS_RESERVE, ROUTER_CALLBACK_GAS_BASE } from "@zkb/core";
import { describe, expect, it } from "vitest";
import { recommendedCallbackGas } from "../src/gas-limit.js";

describe("recommendedCallbackGas", () => {
  it("gives a plain relay no gas number", () => {
    expect(recommendedCallbackGas({ kind: "plain" })).toBeNull();
  });

  it("gives a router its own work when the director asks for no call", () => {
    expect(recommendedCallbackGas({ kind: "router" })).toBe(ROUTER_CALLBACK_GAS_BASE);
    expect(recommendedCallbackGas({ kind: "router", callGas: 0n })).toBe(ROUTER_CALLBACK_GAS_BASE);
  });

  it("adds the call gas, a 63rd of it and the reserve for a router with a call", () => {
    expect(recommendedCallbackGas({ kind: "router", callGas: 63_000n })).toBe(ROUTER_CALLBACK_GAS_BASE + 63_000n + 1_000n + CALL_GAS_RESERVE);
  });

  it("passes the gas of any other contract unchanged", () => {
    expect(recommendedCallbackGas({ kind: "contract", callbackGas: 1n })).toBe(1n);
    expect(recommendedCallbackGas({ kind: "contract", callbackGas: 750_000n })).toBe(750_000n);
  });

  it("refuses zero gas for a contract, because the mediator refuses it", () => {
    expect(() => recommendedCallbackGas({ kind: "contract", callbackGas: 0n })).toThrow(RangeError);
    expect(() => recommendedCallbackGas({ kind: "contract", callbackGas: -1n })).toThrow(/above zero/);
  });
});
