import { describe, expect, it } from "vitest";
import { describeBridgeFees } from "../../src/tx/fee-disclosure";

const PERCENT_TENTH = 10n ** 15n; // 0.1 percent

describe("describeBridgeFees", () => {
  it("takes the source fee exactly, and states the destination fee as an upper bound", () => {
    const fees = describeBridgeFees({ amount: 1_000_000_000n, sourceRate: PERCENT_TENTH, destinationRate: PERCENT_TENTH });
    expect(fees.sourceFee).toBe(1_000_000n);
    expect(fees.afterSourceFee).toBe(999_000_000n);
    expect(fees.destinationFeeAtMost).toBe(999_000n);
    expect(fees.arrivesAtLeast).toBe(998_001_000n);
  });

  it("rounds down as the contract does, so a displayed fee never exceeds the charged one", () => {
    const fees = describeBridgeFees({ amount: 999n, sourceRate: PERCENT_TENTH, destinationRate: 0n });
    expect(fees.sourceFee).toBe(0n);
    expect(fees.arrivesAtLeast).toBe(999n);
  });

  it("charges nothing on a chain with a zero rate (Ethereum)", () => {
    const fees = describeBridgeFees({ amount: 5_000n, sourceRate: 0n, destinationRate: 0n });
    expect(fees.arrivesAtLeast).toBe(5_000n);
  });

  it("keeps big amounts exact in bigint", () => {
    const amount = 123_456_789_012_345_678_901_234_567n;
    const fees = describeBridgeFees({ amount, sourceRate: PERCENT_TENTH, destinationRate: PERCENT_TENTH });
    expect(fees.sourceFee).toBe((amount * PERCENT_TENTH) / 10n ** 18n);
    expect(fees.arrivesAtLeast + fees.destinationFeeAtMost + fees.sourceFee).toBe(amount);
  });
});
