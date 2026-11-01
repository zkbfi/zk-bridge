import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { boundsOf, drawAmount, pickTransfer, type Candidate, type TokenBounds } from "../../src/traffic/plan.ts";

const TOKEN = "0x1111111111111111111111111111111111111111" as Address;
const COPY = "0x2222222222222222222222222222222222222222" as Address;
const DOLLAR = 10n ** 6n;

/** A random source that returns the given numbers in turn, then the last one again. */
function sequence(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] as number;
}

const BOUNDS: TokenBounds = {
  amount: { minimum: 1n * DOLLAR, maximum: 25n * DOLLAR },
  balance: { minimum: 1_000n * DOLLAR, maximum: 900_000n * DOLLAR },
};

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    symbol: "tUSD",
    kind: "native",
    decimals: 6,
    sourceToken: TOKEN,
    destinationToken: COPY,
    sourceBalance: 100_000n * DOLLAR,
    homeBalance: 100_000n * DOLLAR,
    bounds: BOUNDS,
    ...overrides,
  };
}

describe("boundsOf", () => {
  it("reads whole token amounts in the decimals of the token", () => {
    expect(boundsOf({ amount: { minimum: "0.5", maximum: "25" }, balance: { minimum: "1000", maximum: "900000" } }, 6)).toEqual({
      amount: { minimum: 500_000n, maximum: 25n * DOLLAR },
      balance: { minimum: 1_000n * DOLLAR, maximum: 900_000n * DOLLAR },
    });
  });
});

describe("drawAmount", () => {
  it("draws in hundredths of a token between the bounds", () => {
    expect(drawAmount({ minimum: DOLLAR, maximum: 25n * DOLLAR }, 6, () => 0)).toBe(DOLLAR);
    expect(drawAmount({ minimum: DOLLAR, maximum: 25n * DOLLAR }, 6, () => 0.999999)).toBe(25n * DOLLAR);
    const middle = drawAmount({ minimum: DOLLAR, maximum: 25n * DOLLAR }, 6, () => 0.5);
    expect(middle % 10_000n).toBe(0n);
    expect(middle > DOLLAR && middle < 25n * DOLLAR).toBe(true);
  });

  it("rounds the lower bound up to a whole hundredth", () => {
    expect(drawAmount({ minimum: 1_234_567n, maximum: 2n * DOLLAR }, 6, () => 0)).toBe(1_240_000n);
  });

  it("uses base units for a token with fewer than two decimals", () => {
    expect(drawAmount({ minimum: 3n, maximum: 7n }, 0, () => 0.99)).toBe(7n);
    expect(drawAmount({ minimum: 3n, maximum: 7n }, 1, () => 0)).toBe(3n);
  });

  it("returns the minimum when no whole hundredth lies between the bounds", () => {
    expect(drawAmount({ minimum: 1_000_001n, maximum: 1_000_002n }, 6, () => 0.5)).toBe(1_000_001n);
  });

  it("stays inside the bounds when the random source returns one", () => {
    expect(drawAmount({ minimum: DOLLAR, maximum: 2n * DOLLAR }, 6, () => 1)).toBe(2n * DOLLAR);
  });
});

describe("pickTransfer", () => {
  it("sends a native token while its home balance stays in the band", () => {
    const pick = pickTransfer([candidate()], () => 0);
    expect(pick).toEqual({ kind: "send", candidate: candidate(), amount: DOLLAR, priority: false });
  });

  it("refuses a native token whose home balance would fall below the band", () => {
    const pick = pickTransfer([candidate({ sourceBalance: 1_000n * DOLLAR, homeBalance: 1_000n * DOLLAR })], () => 0);
    expect(pick).toEqual({ kind: "skip", reason: "no-eligible-token", candidates: [{ symbol: "tUSD", kind: "native", reason: "home-balance-at-minimum" }] });
  });

  it("refuses a native token whose balance is below the amount", () => {
    const low = { ...BOUNDS, balance: { minimum: 0n, maximum: 10n * DOLLAR } };
    const pick = pickTransfer([candidate({ sourceBalance: DOLLAR / 2n, homeBalance: DOLLAR / 2n, bounds: low })], () => 0);
    expect(pick.kind).toBe("skip");
  });

  it("sends a copy home, never more than its balance", () => {
    const copy = candidate({ kind: "copy", sourceToken: COPY, destinationToken: TOKEN, sourceBalance: 3n * DOLLAR, homeBalance: 100_000n * DOLLAR });
    expect(pickTransfer([copy], () => 0.99)).toEqual({ kind: "send", candidate: copy, amount: 3n * DOLLAR, priority: false });
    expect(pickTransfer([copy], () => 0)).toEqual({ kind: "send", candidate: copy, amount: DOLLAR, priority: false });
  });

  it("refuses a copy that has no balance or less than the smallest amount", () => {
    const empty = candidate({ kind: "copy", sourceBalance: 0n });
    const dust = candidate({ kind: "copy", symbol: "tTKN", sourceBalance: DOLLAR / 2n });
    expect(pickTransfer([empty, dust], () => 0)).toEqual({
      kind: "skip",
      reason: "no-eligible-token",
      candidates: [
        { symbol: "tUSD", kind: "copy", reason: "copy-balance-below-amount" },
        { symbol: "tTKN", kind: "copy", reason: "copy-balance-below-amount" },
      ],
    });
  });

  it("sends a copy home first when the home balance is below the band", () => {
    const native = candidate({ symbol: "tTKN" });
    const copy = candidate({ kind: "copy", sourceToken: COPY, sourceBalance: 50n * DOLLAR, homeBalance: 10n * DOLLAR });
    // Draws: the native amount, the copy amount, then the index among the urgent ones.
    const pick = pickTransfer([native, copy], sequence(0, 0, 0));
    expect(pick.kind === "send" && pick.candidate).toBe(copy);
    expect(pick.kind === "send" && pick.priority).toBe(true);
  });

  it("sends a native token first when its home balance is above the band", () => {
    const rich = candidate({ sourceBalance: 950_000n * DOLLAR, homeBalance: 950_000n * DOLLAR });
    const copy = candidate({ kind: "copy", symbol: "tTKN", sourceBalance: 50n * DOLLAR });
    const pick = pickTransfer([copy, rich], sequence(0, 0, 0.99));
    expect(pick.kind === "send" && pick.candidate).toBe(rich);
  });

  it("picks uniformly among the candidates in the band", () => {
    const first = candidate({ symbol: "tUSD" });
    const second = candidate({ symbol: "tTKN" });
    expect(pickTransfer([first, second], sequence(0, 0, 0)).kind === "send" && pickTransfer([first, second], sequence(0, 0, 0))).toMatchObject({ candidate: first });
    expect(pickTransfer([first, second], sequence(0, 0, 0.75))).toMatchObject({ candidate: second });
    // A source that returns one still picks the last candidate.
    expect(pickTransfer([first, second], () => 1)).toMatchObject({ candidate: second });
  });
});
