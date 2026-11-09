import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import type { TokenInfo } from "@terminal/model/types";
import { crossingCopyOf, crossingCopySymbolOf, crossingSourceOf, wrappedNativeTokenOf } from "../../src/tx/native-route";

const first = FIXTURE_PAIR.first;
const wrapped = getAddress(first.contracts.wrappedNative!);
const copy = getAddress(`0x${"79".repeat(20)}`);
const noWrapped = { ...first, contracts: { ...first.contracts, wrappedNative: null } };

describe("the token that crosses for a native send", () => {
  it("is the listed wrapped native token, or one built from the copy that names it, or one with no copy yet", () => {
    const listed: TokenInfo = { address: wrapped, symbol: "WETH9", decimals: 18, side: "first", counterpart: copy };
    expect(wrappedNativeTokenOf(first, [listed])).toBe(listed);
    expect(wrappedNativeTokenOf(first, [{ address: copy, symbol: "zWETH9", decimals: 18, side: "second", counterpart: wrapped }])).toEqual({ address: wrapped, symbol: `wrapped ${first.nativeSymbol}`, decimals: 18, side: "first", counterpart: copy });
    expect(wrappedNativeTokenOf(first, FIXTURE_TOKENS)?.counterpart).toBeNull();
    expect(wrappedNativeTokenOf(noWrapped, FIXTURE_TOKENS)).toBeNull();
  });

  it("reads a native source as that token, and leaves a token source or a chain with no wrapped native token as it is", () => {
    const native = { kind: "native", side: "first", chain: first } as const;
    expect(crossingSourceOf(native, FIXTURE_TOKENS)).toMatchObject({ kind: "token", token: { address: wrapped } });
    const token = { kind: "token", side: "first", chain: first, token: FIXTURE_TOKENS[0]! } as const;
    expect(crossingSourceOf(token, FIXTURE_TOKENS)).toBe(token);
    const bare = { kind: "native", side: "first", chain: noWrapped } as const;
    expect(crossingSourceOf(bare, FIXTURE_TOKENS)).toBe(bare);
  });

  it("names the copy by its listed symbol, else by the bridge's rule, also when the copy is known but not listed", () => {
    const listed: TokenInfo = { address: wrapped, symbol: "WETH9", decimals: 18, side: "first", counterpart: copy };
    expect(crossingCopySymbolOf(first, [listed, { address: copy, symbol: "zWETH9", decimals: 18, side: "second", counterpart: wrapped }])).toBe("zWETH9");
    expect(crossingCopySymbolOf(first, [listed])).toBe(`z${first.nativeSymbol}`);
    expect(crossingCopySymbolOf(noWrapped, [])).toBe(`z${first.nativeSymbol}`);
    expect(crossingCopyOf(first, [listed])).toBe(copy);
    expect(crossingCopyOf(noWrapped, [])).toBeNull();
  });
});
