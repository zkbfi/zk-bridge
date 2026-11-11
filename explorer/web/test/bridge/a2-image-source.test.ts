import { describe, expect, it } from "vitest";
import type { PairConfig, TokenInfo } from "@terminal/model/types";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { iconSubjectOf } from "../../src/bridge/image-source";

const WRAPPED_OWN = "0x7000000000000000000000000000000000000007";
const WRAPPED_OTHER = "0x8000000000000000000000000000000000000008";
const pair: PairConfig = {
  ...FIXTURE_PAIR,
  first: { ...FIXTURE_PAIR.first, contracts: { ...FIXTURE_PAIR.first.contracts, wrappedNative: WRAPPED_OWN } },
  second: { ...FIXTURE_PAIR.second, contracts: { ...FIXTURE_PAIR.second.contracts, wrappedNative: WRAPPED_OTHER } },
} as PairConfig;
const token = (overrides: Partial<TokenInfo>): TokenInfo => ({ symbol: "T", decimals: 18, side: "first", address: "0x1000000000000000000000000000000000000001", counterpart: null, ...overrides }) as TokenInfo;

describe("iconSubjectOf", () => {
  it("shows a token by its own chain and address", () => {
    expect(iconSubjectOf(token({}), pair)).toEqual({ chainId: pair.first.chainId, address: "0x1000000000000000000000000000000000000001" });
  });

  it("shows a wrapped native coin, in any letter case, and the native placeholder as the chain's own icon", () => {
    expect(iconSubjectOf(token({ address: WRAPPED_OWN.toUpperCase().replace("0X", "0x") as TokenInfo["address"] }), pair)).toEqual({ chainId: pair.first.chainId });
    expect(iconSubjectOf(token({ address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" }), pair)).toEqual({ chainId: pair.first.chainId });
  });

  it("shows a copy by its original, or by the other chain's icon when the original is that chain's wrapped native coin", () => {
    const original = "0x9000000000000000000000000000000000000009";
    expect(iconSubjectOf(token({ side: "second", isBridgedCopy: true, counterpart: original as TokenInfo["counterpart"] }), pair)).toEqual({ chainId: pair.first.chainId, address: original });
    expect(iconSubjectOf(token({ side: "second", isBridgedCopy: true, counterpart: WRAPPED_OWN as TokenInfo["counterpart"] }), pair)).toEqual({ chainId: pair.first.chainId });
  });

  it("shows a copy with no known original by its own address, and a chain without a wrapped native coin plainly", () => {
    expect(iconSubjectOf(token({ isBridgedCopy: true, counterpart: null }), pair)).toEqual({ chainId: pair.first.chainId, address: "0x1000000000000000000000000000000000000001" });
    const bare = { ...pair, first: { ...pair.first, contracts: { ...pair.first.contracts, wrappedNative: undefined } } } as unknown as PairConfig;
    expect(iconSubjectOf(token({}), bare)).toEqual({ chainId: pair.first.chainId, address: "0x1000000000000000000000000000000000000001" });
  });
});
