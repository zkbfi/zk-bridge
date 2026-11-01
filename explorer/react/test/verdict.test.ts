import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { pressable, useVerdict, verdictOf, type VerdictInput } from "../src/verdict.js";

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

  it("blocks a fee above the hard cap, ahead of every fee warning, with the numbers and the cap that admits it", () => {
    const hardCap = { capText: "2%", feeText: "12 USDC ($12.00)", capAmountText: "10 USDC ($10.00)", raiseText: "2.4%", worstCase: false };
    const verdict = verdictOf({ ...base, tipBelowBreakEven: true, highTip: { thresholdText: "0.2%", tipText: "$11" }, smallTransfer: { costText: "$1", capText: "1%", capAmountText: "$0.5" }, hardCap });
    expect(verdict).toEqual({ kind: "blocked", label: "Fee above your 2% cap", detail: "The fee is 12 USDC ($12.00), more than your 2% hard cap (10 USDC ($10.00)). Raise the cap to 2.4% to go on, or lower the fee." });
    expect(pressable(verdict)).toBe(false);
    expect(verdictOf({ ...base, hardCap: { ...hardCap, worstCase: true } }).detail).toMatch(/^The fee could reach 12 USDC \(\$12\.00\) if gas rises,/);
  });
});

describe("what is checked before the fee", () => {
  it("asks for an amount first", () => {
    expect(verdictOf({ ...base, amountEntered: false })).toEqual({ kind: "blocked", label: "Enter an amount", detail: null });
  });

  it("names a destination that cannot be used, unless the field under it already says so", () => {
    expect(verdictOf({ ...base, destinationProblem: "Not an address." })).toEqual({ kind: "blocked", label: "Check the destination", detail: "Not an address." });
    expect(verdictOf({ ...base, destinationProblem: "Not an address.", destinationProblemShown: true })).toEqual({ kind: "blocked", label: "Check the destination", detail: null });
  });

  it("warns about an Omnibridge copy and about a first bridge, in that order", () => {
    expect(verdictOf({ ...base, omnibridge: true, firstBridge: true }).label).toMatch(/Omnibridge/);
    expect(verdictOf({ ...base, firstBridge: true }).label).toMatch(/First time/);
  });

  it("blocks an incomplete draft with its reason", () => {
    expect(verdictOf({ ...base, draft: { status: "incomplete", reason: "Pick a token." } })).toEqual({ kind: "blocked", label: "Bridge", detail: "Pick a token." });
  });
});

describe("useVerdict", () => {
  it("gives the verdict and whether the pill can be pressed, and keeps them while the state says the same", () => {
    const { result, rerender } = renderHook((input: VerdictInput) => useVerdict(input), { initialProps: base });
    expect(result.current.verdict).toMatchObject({ kind: "go", label: "Bridge" });
    expect(result.current.pressable).toBe(true);
    const first = result.current;
    rerender({ ...base });
    expect(result.current).toBe(first);
    rerender({ ...base, overBalance: true });
    expect(result.current.verdict).toMatchObject({ kind: "blocked", label: "Not enough ETH" });
    expect(result.current.pressable).toBe(false);
  });
});
