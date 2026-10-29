import { describe, expect, it } from "vitest";
import { DEFAULT_MINIMUM_PRIORITY_FEE_WEI, minimumPriorityFeeWei, withMinimumPriorityFee } from "../src/priority-fee.js";

describe("the minimum priority fee of a chain", () => {
  it("is 0.01 gwei on PulseChain and its testnet, where validators skip a tip of 0.001 gwei or less", () => {
    expect(DEFAULT_MINIMUM_PRIORITY_FEE_WEI).toEqual({ 369: 10_000_000n, 943: 10_000_000n });
    expect(minimumPriorityFeeWei(943)).toBe(10_000_000n);
    expect(minimumPriorityFeeWei(369)).toBe(10_000_000n);
  });

  it("is zero on a chain without a known minimum", () => {
    expect(minimumPriorityFeeWei(1)).toBe(0n);
    expect(minimumPriorityFeeWei(11155111)).toBe(0n);
  });

  it("takes an override by chain id, also for a chain without a default", () => {
    expect(minimumPriorityFeeWei(943, { "943": "2000000" })).toBe(2_000_000n);
    expect(minimumPriorityFeeWei(1, { "1": 5n })).toBe(5n);
    expect(minimumPriorityFeeWei(369, { "943": "1" })).toBe(10_000_000n);
  });
});

describe("raising fees to the minimum", () => {
  it("raises a smaller tip and the maximum fee by the same amount, so the room for the base fee stays", () => {
    expect(withMinimumPriorityFee({ maxFeePerGas: 30n, maxPriorityFeePerGas: 1n }, 10_000_000n)).toEqual({
      maxFeePerGas: 30n + 9_999_999n,
      maxPriorityFeePerGas: 10_000_000n,
    });
  });

  it("keeps a tip that is already at or above the minimum", () => {
    const fees = { maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
    expect(withMinimumPriorityFee(fees, 10_000_000n)).toBe(fees);
    const exact = { maxFeePerGas: 20_000_000n, maxPriorityFeePerGas: 10_000_000n };
    expect(withMinimumPriorityFee(exact, 10_000_000n)).toBe(exact);
  });

  it("changes nothing for a minimum of zero", () => {
    const fees = { maxFeePerGas: 15n, maxPriorityFeePerGas: 1n };
    expect(withMinimumPriorityFee(fees, 0n)).toBe(fees);
  });
});
