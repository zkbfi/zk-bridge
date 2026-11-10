import { describe, expect, it } from "vitest";
import { resolveCustomToken, type Erc20Reader } from "../../src/bridge/custom-token";

const ADDRESS = "0x9999999999999999999999999999999999999999";
const answering = (answers: Record<string, unknown>): Erc20Reader => async (_address, fn) => answers[fn];

describe("resolveCustomToken answers", () => {
  it("takes decimals as a bigint (what the chain returns for wide integers) or a number", async () => {
    expect(await resolveCustomToken(ADDRESS, "first", answering({ symbol: "A", decimals: 6n }))).toMatchObject({ decimals: 6 });
    expect(await resolveCustomToken(ADDRESS, "first", answering({ symbol: "A", decimals: 6 }))).toMatchObject({ decimals: 6 });
  });

  it("refuses decimals that are no number, below 0, above 36 or fractional, and a symbol that is no string", async () => {
    for (const decimals of ["18", undefined, -1, 37, 1.5, 40n]) expect(await resolveCustomToken(ADDRESS, "first", answering({ symbol: "A", decimals }))).toBeNull();
    expect(await resolveCustomToken(ADDRESS, "first", answering({ symbol: 5, decimals: 6 }))).toBeNull();
  });

  it("falls back to the symbol when the name is missing or not printable", async () => {
    expect(await resolveCustomToken(ADDRESS, "first", answering({ symbol: "A", decimals: 6, name: "Ünïcode" }))).toMatchObject({ name: "A" });
    expect(await resolveCustomToken(ADDRESS, "first", answering({ symbol: "A", decimals: 6, name: 7 }))).toMatchObject({ name: "A" });
    expect(await resolveCustomToken(ADDRESS, "first", answering({ symbol: "A", decimals: 6, name: "Alpha" }))).toMatchObject({ name: "Alpha" });
  });
});
