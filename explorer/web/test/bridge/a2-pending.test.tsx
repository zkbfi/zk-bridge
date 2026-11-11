import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_TOKENS } from "@terminal/data/fixtures";
import { addPending, clearPending, settlePending, usePending, type PendingTransfer } from "../../src/bridge/pending";

const entry = (hex: string): PendingTransfer => ({ sourceTransactionHash: `0x${hex.repeat(32)}`, direction: "first-to-second", token: FIXTURE_TOKENS[0]!, amount: 1n, sentAt: 100 });

afterEach(() => clearPending());

describe("the just-submitted transfers", () => {
  it("lists the newest first, ignores a transfer it already has, and tells the readers on every change", () => {
    const { result } = renderHook(() => usePending());
    act(() => addPending(entry("aa")));
    act(() => addPending(entry("bb")));
    const both = result.current;
    expect(both.map((row) => row.sourceTransactionHash)).toEqual([`0x${"bb".repeat(32)}`, `0x${"aa".repeat(32)}`]);
    act(() => addPending(entry("aa")));
    expect(result.current).toBe(both);
  });

  it("drops the entries the feed now has (any letter case) and leaves the list untouched when none match", () => {
    const { result } = renderHook(() => usePending());
    act(() => addPending(entry("aa")));
    act(() => addPending(entry("bb")));
    const before = result.current;
    act(() => settlePending(new Set([`0x${"cc".repeat(32)}`])));
    expect(result.current).toBe(before);
    act(() => settlePending(new Set([`0x${"aa".repeat(32)}`])));
    expect(result.current.map((row) => row.sourceTransactionHash)).toEqual([`0x${"bb".repeat(32)}`]);
    act(() => clearPending());
    expect(result.current).toEqual([]);
  });

  it("stops telling a reader that has gone", () => {
    const { result, unmount } = renderHook(() => usePending());
    unmount();
    addPending(entry("aa"));
    expect(result.current).toEqual([]);
  });
});
