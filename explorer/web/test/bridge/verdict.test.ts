import { describe, expect, it } from "vitest";
import { pressable, verdictOf, type VerdictInput } from "../../src/bridge/verdict";

const base: VerdictInput = {
  connected: true,
  draft: { status: "ready", reason: null },
  amountEntered: true,
  overBalance: false,
  symbol: "ETH",
  paused: null,
  tipBelowBreakEven: false,
};

describe("the Bridge pill's verdict", () => {
  it("asks for a wallet first", () => {
    const verdict = verdictOf({ ...base, connected: false });
    expect(verdict).toMatchObject({ kind: "connect", label: "Connect wallet" });
    expect(pressable(verdict)).toBe(true);
  });

  it("blocks an amount over the balance, naming the token", () => {
    const verdict = verdictOf({ ...base, overBalance: true });
    expect(verdict).toMatchObject({ kind: "blocked", label: "Not enough ETH" });
    expect(pressable(verdict)).toBe(false);
  });

  it("warns, but still lets the user go, when the tip is below what bots need", () => {
    const verdict = verdictOf({ ...base, tipBelowBreakEven: true });
    expect(verdict.kind).toBe("warn");
    expect(verdict.label).toBe("Tip too low · may not be delivered");
    expect(verdict.detail).toMatch(/deliver it yourself/);
    expect(pressable(verdict)).toBe(true);
  });

  it("warns, overridably, when the tip is high for the amount, naming the threshold", () => {
    const verdict = verdictOf({ ...base, highTip: { thresholdText: "0.32%" } });
    expect(verdict).toMatchObject({ kind: "warn", label: "High cap %" });
    expect(verdict.detail).toMatch(/0\.32%/);
    expect(pressable(verdict)).toBe(true);
    // A low fee says so first.
    expect(verdictOf({ ...base, tipBelowBreakEven: true, highTip: { thresholdText: "1%" } }).label).toBe("Tip too low · may not be delivered");
  });

  it("blocks a paused route", () => {
    expect(verdictOf({ ...base, paused: { route: "PulseChain → Ethereum" } })).toMatchObject({ kind: "blocked", label: "PulseChain → Ethereum is paused" });
  });

  it("goes when everything checks out", () => {
    expect(verdictOf(base)).toEqual({ kind: "go", label: "Bridge", detail: null });
  });

  it("passes on the draft's reason when it blocks", () => {
    expect(verdictOf({ ...base, draft: { status: "blocked", reason: "The receiver is not an address." } })).toMatchObject({ kind: "blocked", detail: "The receiver is not an address." });
  });
});
