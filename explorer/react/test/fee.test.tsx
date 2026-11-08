import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CAP_WAD, DEFAULT_HARD_CAP_WAD } from "@zkb/core";
import { capWadOf, plainNumber, useDefaultFee, useFeeCaps, useFeeWarnings, useHardCap, type CapStorage } from "../src/index.js";

const USD = 10n ** 18n;

beforeEach(() => window.localStorage.clear());

describe("plainNumber and capWadOf", () => {
  it("cut a number to short text, and turn a cap in percent into a share", () => {
    expect(plainNumber(1.23456789)).toBe("1.2346");
    expect(plainNumber(2, 6)).toBe("2");
    expect(capWadOf(1.5, DEFAULT_CAP_WAD)).toBe(15n * 10n ** 15n);
    expect(capWadOf(Number.NaN, 7n)).toBe(7n);
  });
});

describe("useDefaultFee", () => {
  it("gives the default fee of the rule at the cap, and adds the level's extra cost on top of the curve", () => {
    const { result, rerender } = renderHook((props: Parameters<typeof useDefaultFee>[0]) => useDefaultFee(props), {
      initialProps: { amountUsd: 1_000n * USD, costUsd: 5n * USD, costDefaultUsd: 5n * USD, capPercent: 5 },
    });
    expect(result.current.capWad).toBe(capWadOf(5, DEFAULT_CAP_WAD));
    const atDefault = result.current.auto.feeUsd;
    expect(atDefault).not.toBeNull();
    // A level above the default costs more: the fee rises by the extra.
    rerender({ amountUsd: 1_000n * USD, costUsd: 9n * USD, costDefaultUsd: 5n * USD, capPercent: 5 });
    expect(result.current.auto.feeUsd!).toBeGreaterThan(atDefault!);
  });

  it("falls back to the default share without prices, and keeps its answer while the inputs stay", () => {
    const { result, rerender } = renderHook(() => useDefaultFee({ amountUsd: null, costUsd: null, costDefaultUsd: null, capPercent: 1 }));
    expect(result.current.auto.binding).toBe("no-price");
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});

describe("useDefaultFee without a price", () => {
  const unpricedFee = (input: Partial<Parameters<typeof useDefaultFee>[0]>) =>
    renderHook(() => useDefaultFee({ amountUsd: null, costUsd: null, costDefaultUsd: null, capPercent: 1, ...input })).result.current;

  it("is the automatic maximum when the price cannot be derived, and the rule's 0.1% only when no amount is typed", () => {
    expect(unpricedFee({ unpriced: true }).auto).toEqual({ binding: "no-price", shareWad: DEFAULT_CAP_WAD, feeUsd: null });
    expect(unpricedFee({ unpriced: true }).auto.shareWad).toBe(10n ** 16n);
    expect(unpricedFee({}).auto.shareWad).toBe(10n ** 15n);
  });

  it("follows the automatic cap in force, not a second 1%", () => {
    expect(unpricedFee({ unpriced: true, capPercent: 0.5 }).auto.shareWad).toBe(5n * 10n ** 15n);
    expect(unpricedFee({ unpriced: true, capPercent: 1.5 }).auto.shareWad).toBe(15n * 10n ** 15n);
    expect(unpricedFee({ unpriced: true, capPercent: Number.NaN }).auto.shareWad).toBe(DEFAULT_CAP_WAD);
  });

  it("leaves a priced fee alone", () => {
    const priced = unpricedFee({ unpriced: true, amountUsd: 1_000n * USD, costUsd: 1n * USD, costDefaultUsd: 1n * USD });
    expect(priced.auto.binding).not.toBe("no-price");
  });
});

describe("useFeeWarnings", () => {
  const input = { amountUsd: 1_000n * USD, capWad: DEFAULT_CAP_WAD, feeUsd: 1n * USD, costUsd: 5n * USD, costDefaultUsd: 5n * USD, shareWithoutPriceWad: null, belowBreakEven: false, gasBased: false, expandedCostUsd: null };

  it("tells a fee under the cost, with the line a tip should stay under", () => {
    const { result } = renderHook(() => useFeeWarnings(input));
    expect(result.current.warnings.lowFee).toBe(true);
    expect(result.current.thresholdText).toMatch(/^\d+(\.\d+)?%$/);
    expect(result.current.linePercent).toBeGreaterThan(0);
  });

  it("keeps its answer for an input with the same content", () => {
    const { result, rerender } = renderHook((props: typeof input) => useFeeWarnings(props), { initialProps: input });
    const first = result.current;
    rerender({ ...input });
    expect(result.current).toBe(first);
    rerender({ ...input, feeUsd: 50n * USD });
    expect(result.current).not.toBe(first);
  });
});

describe("useHardCap", () => {
  it("has no check without an amount or a fee", () => {
    const { result } = renderHook(() => useHardCap({ hardCapPercent: 2, amountUnits: null, feeUnits: 5n, worstFeeUnits: 0n }));
    expect(result.current).toEqual({ hardCapWad: DEFAULT_HARD_CAP_WAD, check: null, over: false, raisePercent: null });
    const zero = renderHook(() => useHardCap({ hardCapPercent: 2, amountUnits: 0n, feeUnits: 5n, worstFeeUnits: 0n }));
    expect(zero.result.current.check).toBeNull();
    const noFee = renderHook(() => useHardCap({ hardCapPercent: 2, amountUnits: 100n, feeUnits: null, worstFeeUnits: 0n }));
    expect(noFee.result.current.check).toBeNull();
  });

  it("is over when the fee is above the cap's share, and names the smallest cap that admits it", () => {
    const { result } = renderHook(() => useHardCap({ hardCapPercent: 2, amountUnits: 1_000n, feeUnits: 24n, worstFeeUnits: 0n }));
    expect(result.current.over).toBe(true);
    expect(result.current.raisePercent).toBe(2.4);
    expect(result.current.check!.capUnits).toBe(20n);
    const within = renderHook(() => useHardCap({ hardCapPercent: 2, amountUnits: 1_000n, feeUnits: 20n, worstFeeUnits: 0n }));
    expect(within.result.current.over).toBe(false);
  });

  it("counts the worst case of a gas-based fee", () => {
    const { result } = renderHook(() => useHardCap({ hardCapPercent: 2, amountUnits: 1_000n, feeUnits: 10n, worstFeeUnits: 30n }));
    expect(result.current.over).toBe(true);
    expect(result.current.check!.feeUnits).toBe(30n);
  });
});

describe("useFeeCaps", () => {
  it("reads the stored caps, moves the hard cap in use without storing it, and stores it on save", () => {
    window.localStorage.setItem("zk-bridge-explorer.hard-fee-cap", "3");
    const { result } = renderHook(() => useFeeCaps());
    expect(result.current).toMatchObject({ storedCap: 1, storedHardCap: 3, hardCapPercent: 3 });
    act(() => result.current.setHardCapPercent(0.5));
    expect(result.current).toMatchObject({ storedHardCap: 3, hardCapPercent: 0.5 });
    act(() => result.current.saveHard());
    // The stored automatic cap follows the new hard cap down.
    expect(result.current).toMatchObject({ storedHardCap: 0.5, storedCap: 0.5, hardCapPercent: 0.5 });
    expect(window.localStorage.getItem("zk-bridge-explorer.hard-fee-cap")).toBe("0.5");
  });

  it("stores the automatic cap, or says why it is refused", () => {
    const { result } = renderHook(() => useFeeCaps());
    let problem: string | null = "";
    act(() => {
      problem = result.current.saveCap(0.25);
    });
    expect(problem).toBeNull();
    expect(result.current.storedCap).toBe(0.25);
    act(() => {
      problem = result.current.saveCap(5);
    });
    expect(problem).toMatch(/hard cap/);
    expect(result.current.storedCap).toBe(0.25);
  });

  it("refuses to store a hard cap that is not a cap, and leaves the state as it was", () => {
    const { result } = renderHook(() => useFeeCaps());
    act(() => result.current.setHardCapPercent(500));
    act(() => result.current.saveHard());
    expect(result.current.storedHardCap).toBe(2);
  });

  it("keeps the caps in the storage the host passes, or nowhere with null", () => {
    const data = new Map<string, string>([["zk-bridge-explorer.fee-cap", "0.7"]]);
    const own: CapStorage = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value), removeItem: (key) => void data.delete(key) };
    const { result } = renderHook(() => useFeeCaps(own));
    expect(result.current.storedCap).toBe(0.7);
    act(() => void result.current.saveCap(0.3));
    expect(data.get("zk-bridge-explorer.fee-cap")).toBe("0.3");
    const none = renderHook(() => useFeeCaps(null));
    expect(none.result.current).toMatchObject({ storedCap: 1, storedHardCap: 2 });
    act(() => void none.result.current.saveCap(0.4));
    expect(window.localStorage.getItem("zk-bridge-explorer.fee-cap")).toBeNull();
  });

  it("reads the defaults when the browser has no usable storage", () => {
    const spy = vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { result } = renderHook(() => useFeeCaps());
    expect(result.current).toMatchObject({ storedCap: 1, storedHardCap: 2 });
    spy.mockRestore();
  });
});
