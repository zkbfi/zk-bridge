import { describe, expect, it } from "vitest";
import { settingsOf, type FeeDirector } from "../src/delivery-terms.js";
import { coverageSentence, tipCoverage, type TipCoverageInput } from "../src/tip-coverage.js";

const GWEI = 10n ** 9n;
const WEI_PER_COIN = 10n ** 18n;
const recipient = "0x00000000000000000000000000000000000000aa" as const;
/** One base unit of the token is one wei, so the tip in tokens reads directly as wei. */
const price = { tokenValueInWei: WEI_PER_COIN, tokenDecimals: 18 };
const deliveryGas = 500_000n;
const gasOverhead = 100_000n;

const gasDirector = (limit: bigint, multiplier = WEI_PER_COIN): FeeDirector => ({
  recipient,
  settings: settingsOf({ mode: "gas", gasPrice: "base-fee-only" }),
  limit,
  multiplier,
  callGas: 0n,
});
const fixedDirector = (amount: bigint): FeeDirector => ({ recipient, settings: settingsOf({ mode: "fixed" }), limit: amount, multiplier: 0n, callGas: 0n });

const input = (director: FeeDirector, overrides: Partial<TipCoverageInput> = {}): TipCoverageInput => ({
  director,
  deliveryGas,
  priorityFeeWei: GWEI,
  baseFeeNowWei: 10n * GWEI,
  transferValue: 10n ** 30n,
  price,
  points: 5,
  ...overrides,
});

describe("tip coverage", () => {
  it("runs the axis from zero to four times the base fee now, with the cost rising", () => {
    const result = tipCoverage(input(fixedDirector(1n)));
    expect(result.points.map((point) => point.baseFeeWei)).toEqual([0n, 10n * GWEI, 20n * GWEI, 30n * GWEI, 40n * GWEI]);
    expect(result.points[0]?.costWei).toBe(deliveryGas * GWEI);
    expect(result.points[4]?.costWei).toBe(deliveryGas * 41n * GWEI);
  });

  it("a gas based tip stops covering at the ceiling base fee", () => {
    // The tip reads gas plus overhead at the base fee, up to the limit. The cost reads the delivery gas at base fee plus priority.
    const ceiling = 20n * GWEI;
    const result = tipCoverage(input(gasDirector((deliveryGas + gasOverhead) * ceiling), { priorityFeeWei: 0n }));
    // Past the limit the tip is flat at 600000 * 20 gwei. The cost reaches it at 600000 * 20 / 500000 = 24 gwei.
    expect(result.coveredUpToBaseFeeWei).toBe(24n * GWEI);
    expect(result.coveredEverywhere).toBe(false);
    expect(coverageSentence(result, "PulseChain")).toBe(
      "Your tip covers the delivery cost while the base fee on PulseChain stays under 24 gwei. Above that, a deliverer loses money on it, and the message may wait. Anyone can still deliver it. A tip is voluntary and promises nothing.",
    );
  });

  it("a gas based tip that starts under the cost covers only between two base fees", () => {
    // Priority fee of 1 gwei makes the cost positive at base fee zero, where a base-fee-only tip is zero.
    const result = tipCoverage(input(gasDirector((deliveryGas + gasOverhead) * 20n * GWEI)));
    expect(result.coveredFromBaseFeeWei).toBeGreaterThan(0n);
    expect(result.coveredFromBaseFeeWei).toBeLessThan(10n * GWEI);
    expect(coverageSentence(result, "PulseChain")).toContain("only while the base fee on PulseChain stays between");
  });

  it("a fixed tip crosses the cost line at tip / gas", () => {
    const tip = deliveryGas * 31n * GWEI;
    const result = tipCoverage(input(fixedDirector(tip)));
    // Cost = gas * (b + 1 gwei) equals the tip when b = 30 gwei.
    expect(result.coveredFromBaseFeeWei).toBe(0n);
    expect(result.coveredUpToBaseFeeWei).toBe(30n * GWEI);
    expect(result.points.every((point) => point.tipWei === tip)).toBe(true);
    expect(coverageSentence(result, "PulseChain")).toContain("under 30 gwei");
  });

  it("a zero tip covers nowhere", () => {
    const result = tipCoverage(input(fixedDirector(0n)));
    expect(result.coveredUpToBaseFeeWei).toBeNull();
    expect(result.coveredFromBaseFeeWei).toBeNull();
    expect(result.coveredEverywhere).toBe(false);
    expect(coverageSentence(result, "PulseChain")).toContain("stays under the delivery cost at every base fee on PulseChain up to 40 gwei");
  });

  it("a tip above cost everywhere says so", () => {
    const result = tipCoverage(input(fixedDirector(deliveryGas * 100n * GWEI)));
    expect(result.coveredEverywhere).toBe(true);
    expect(result.coveredUpToBaseFeeWei).toBe(40n * GWEI);
    expect(coverageSentence(result, "PulseChain")).toBe("Your tip covers the delivery cost at every base fee on PulseChain up to 40 gwei, which is the end of the graph. A tip is voluntary and promises nothing.");
  });

  it("turns token units into wei with the price of the token", () => {
    const halfPrice = { tokenValueInWei: WEI_PER_COIN / 2n, tokenDecimals: 18 };
    const result = tipCoverage(input(fixedDirector(1000n), { price: halfPrice }));
    expect(result.points[0]?.tipWei).toBe(500n);
  });

  it("passes the payout to the router arithmetic", () => {
    const token = tipCoverage(input(gasDirector(10n ** 30n), { payout: "token" }));
    const native = tipCoverage(input(gasDirector(10n ** 30n), { payout: "native" }));
    expect(native.points[4]?.tipWei).toBeGreaterThanOrEqual(token.points[4]?.tipWei ?? 0n);
  });

  it("refuses a base fee of zero and fewer than two points", () => {
    expect(() => tipCoverage(input(fixedDirector(1n), { baseFeeNowWei: 0n }))).toThrow(RangeError);
    expect(() => tipCoverage(input(fixedDirector(1n), { points: 1 }))).toThrow(RangeError);
  });

  it("names an empty graph as zero when the result has no points", () => {
    const sentence = coverageSentence({ points: [], coveredFromBaseFeeWei: null, coveredUpToBaseFeeWei: null, coveredEverywhere: false }, "PulseChain");
    expect(sentence).toContain("up to 0 gwei");
  });
});
