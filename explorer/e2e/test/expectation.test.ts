import { describe, expect, it } from "bun:test";
import { checkExpectation } from "../src/stages/transfers.ts";

const WHOLE = 10n ** 18n;

describe("checkExpectation", () => {
  it("accepts a direct delivery that pays the recipient everything", () => {
    expect(checkExpectation({ amount: 60n * WHOLE, expect: { kind: "no-tip" } }, { tip: 0n, toRecipient: 60n * WHOLE, handedOff: 0n })).toEqual([]);
  });

  it("flags a tip on a delivery that should pay none", () => {
    // A direct bridge delivery sees no router state, so a tip here would mean the router charged without a router call.
    const problems = checkExpectation({ amount: 60n * WHOLE, expect: { kind: "no-tip" } }, { tip: 1n, toRecipient: 60n * WHOLE - 1n, handedOff: 0n });
    expect(problems.length).toBeGreaterThan(0);
  });

  it("needs the tip and the recipient share to add up to the transfer", () => {
    const wrong = checkExpectation({ amount: 100n * WHOLE, expect: { kind: "tip-positive" } }, { tip: 5n, toRecipient: 100n * WHOLE - 4n, handedOff: 0n });
    expect(wrong).toHaveLength(1);
    expect(checkExpectation({ amount: 100n * WHOLE, expect: { kind: "tip-positive" } }, { tip: 5n, toRecipient: 100n * WHOLE - 5n, handedOff: 0n })).toEqual([]);
  });

  it("refuses a zero tip where a gas based tip is expected", () => {
    expect(checkExpectation({ amount: 100n * WHOLE, expect: { kind: "tip-positive" } }, { tip: 0n, toRecipient: 100n * WHOLE, handedOff: 0n })).toContain("no tip was paid");
  });

  it("compares an exact tip to the base unit", () => {
    const item = { amount: 100n * WHOLE, expect: { kind: "tip-exact", tip: WHOLE / 10n } } as const;
    expect(checkExpectation(item, { tip: WHOLE / 10n, toRecipient: 100n * WHOLE - WHOLE / 10n, handedOff: 0n })).toEqual([]);
    expect(checkExpectation(item, { tip: WHOLE / 10n + 1n, toRecipient: 100n * WHOLE - WHOLE / 10n - 1n, handedOff: 0n })).not.toEqual([]);
  });

  it("expects a refused payout to reach the failed delivery address after the tip", () => {
    const item = { amount: 20n * WHOLE, expect: { kind: "handed-off", tip: WHOLE / 5n } } as const;
    expect(checkExpectation(item, { tip: WHOLE / 5n, toRecipient: 0n, handedOff: 20n * WHOLE - WHOLE / 5n })).toEqual([]);
    // If the recipient received the tokens, the payout was not refused and the test would prove nothing.
    expect(checkExpectation(item, { tip: WHOLE / 5n, toRecipient: 1n, handedOff: 20n * WHOLE - WHOLE / 5n - 1n }).length).toBeGreaterThan(0);
  });
});
