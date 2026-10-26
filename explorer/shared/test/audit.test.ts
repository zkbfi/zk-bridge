import { describe, expect, it } from "vitest";
import { auditToken } from "../src/audit.js";

const base = { homeChainId: 1, token: "0xabc", escrow: 0n, accruedFees: 0n, bridgedSupply: 0n, pendingForward: 0n, pendingBackward: 0n };

describe("auditToken", () => {
  it("balances when the escrow equals the supply", () => {
    const result = auditToken({ ...base, escrow: 100n, bridgedSupply: 100n });
    expect(result.mismatch).toBe(false);
    expect(result.difference).toBe(0n);
  });

  it("counts a locked transfer that is not minted yet as owed", () => {
    expect(auditToken({ ...base, escrow: 150n, bridgedSupply: 100n, pendingForward: 50n }).mismatch).toBe(false);
  });

  it("counts a burned transfer that is not released yet as owed", () => {
    expect(auditToken({ ...base, escrow: 100n, bridgedSupply: 70n, pendingBackward: 30n }).mismatch).toBe(false);
  });

  it("flags a bridged copy that is under-backed, with a negative difference", () => {
    const result = auditToken({ ...base, escrow: 90n, bridgedSupply: 100n });
    expect(result.mismatch).toBe(true);
    expect(result.difference).toBe(-10n);
  });

  it("flags more escrow than owed, with a positive difference", () => {
    const result = auditToken({ ...base, escrow: 110n, bridgedSupply: 100n });
    expect(result.mismatch).toBe(true);
    expect(result.difference).toBe(10n);
  });

  it("does not mix accrued fees into the escrow check", () => {
    expect(auditToken({ ...base, escrow: 100n, bridgedSupply: 100n, accruedFees: 7n }).mismatch).toBe(false);
  });

  it("is exact beyond 2^53", () => {
    const big = 10n ** 30n;
    expect(auditToken({ ...base, escrow: big + 1n, bridgedSupply: big }).difference).toBe(1n);
  });
});
