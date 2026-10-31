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

  it("names the numbers in the low-fee detail when it has them", () => {
    const verdict = verdictOf({ ...base, tipBelowBreakEven: true, lowFee: { feeText: "$0.05", costText: "$0.04" } });
    expect(verdict.detail).toBe("The fee ($0.05) is under twice what delivering and proving it should cost ($0.04 now), so bots likely skip it and you would deliver it yourself. Raise it with the tip.");
  });

  it("warns, overridably, when the tip is high for the amount, naming the tip and the threshold", () => {
    const verdict = verdictOf({ ...base, highTip: { thresholdText: "0.32%", tipText: "$1.40" } });
    expect(verdict).toMatchObject({ kind: "warn", label: "High cap %" });
    expect(verdict.detail).toBe("The tip, before gas, is $1.40, over the 0.32% of the amount a tip should stay under. A lower tip still gets delivered; lower it with the tip.");
    expect(pressable(verdict)).toBe(true);
    // A low fee says so first.
    expect(verdictOf({ ...base, tipBelowBreakEven: true, highTip: { thresholdText: "1%", tipText: "$1" } }).label).toBe("Tip too low · may not be delivered");
  });

  it("warns that a small transfer may not be delivered in a timely manner, ahead of every other warning", () => {
    const small = { costText: "$0.05", capText: "1%", capAmountText: "$0.02" };
    const verdict = verdictOf({ ...base, smallTransfer: small, tipBelowBreakEven: true, highTip: { thresholdText: "1%", tipText: "$1" }, firstBridge: true, omnibridge: true });
    expect(verdict).toMatchObject({ kind: "warn", label: "Small transfer · may not be delivered in a timely manner" });
    expect(verdict.detail).toBe("Delivery costs about $0.05, more than the 1% ($0.02) you allow. A bot may wait for cheaper gas: raise the cap in the tip drawer, or deliver it yourself.");
    expect(pressable(verdict)).toBe(true);
  });

  it("puts the fee warnings ahead of the token warnings, one at a time", () => {
    expect(verdictOf({ ...base, tipBelowBreakEven: true, firstBridge: true }).label).toBe("Tip too low · may not be delivered");
    expect(verdictOf({ ...base, highTip: { thresholdText: "1%", tipText: "$1" }, omnibridge: true }).label).toBe("High cap %");
    expect(verdictOf({ ...base, firstBridge: true, omnibridge: true }).label).toMatch(/^Already bridged/);
    expect(verdictOf({ ...base, firstBridge: true }).label).toMatch(/^First time/);
  });

  it("shows no fee warning while the draft is incomplete", () => {
    expect(verdictOf({ ...base, draft: { status: "incomplete", reason: "Waiting" }, smallTransfer: { costText: "$1", capText: "1%", capAmountText: "$0.1" } })).toMatchObject({ kind: "blocked", label: "Bridge", detail: "Waiting" });
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
