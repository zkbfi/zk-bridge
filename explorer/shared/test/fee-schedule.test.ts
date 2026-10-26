import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FEE_DENOMINATOR, feeOn, feeRateAt, type FeeSchedule } from "../src/fee-schedule.js";

type RateVector = {
  kind: "rate";
  startTime: string;
  startRate: string;
  stepRate: string;
  floorRate: string;
  stepPeriod: string;
  timestamp: string;
  rate: string;
};
type FeeVector = { kind: "fee"; amount: string; rate: string; fee: string };

const vectors = readFileSync(new URL("./fixtures/fee-schedule-vectors.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line) as RateVector | FeeVector);
const rateVectors = vectors.filter((vector): vector is RateVector => vector.kind === "rate");
const feeVectors = vectors.filter((vector): vector is FeeVector => vector.kind === "fee");

const scheduleOf = (vector: RateVector): FeeSchedule => ({
  startTime: BigInt(vector.startTime),
  startRate: BigInt(vector.startRate),
  stepRate: BigInt(vector.stepRate),
  floorRate: BigInt(vector.floorRate),
  stepPeriod: BigInt(vector.stepPeriod),
});

describe("the fee schedule against vectors printed by FeeSchedule.sol", () => {
  it("has vectors", () => {
    expect(rateVectors.length).toBeGreaterThan(50);
    expect(feeVectors.length).toBeGreaterThan(20);
  });

  it("returns the rate of the library for every rate vector", () => {
    for (const vector of rateVectors) {
      expect(feeRateAt(scheduleOf(vector), BigInt(vector.timestamp)), JSON.stringify(vector)).toBe(BigInt(vector.rate));
    }
  });

  it("returns the fee of the library for every fee vector", () => {
    for (const vector of feeVectors) {
      expect(feeOn(BigInt(vector.amount), BigInt(vector.rate)), JSON.stringify(vector)).toBe(BigInt(vector.fee));
    }
  });
});

describe("the fee schedule of the deployment", () => {
  const deployment: FeeSchedule = { startTime: 0n, startRate: 10n ** 15n, stepRate: 10n ** 14n, floorRate: 5n * 10n ** 14n, stepPeriod: 31_536_000n };

  it("falls one basis point a year from ten to five", () => {
    const yearly = [0n, 1n, 2n, 3n, 4n, 5n, 6n].map((year) => feeRateAt(deployment, year * 31_536_000n));
    expect(yearly).toEqual([10n, 9n, 8n, 7n, 6n, 5n, 5n].map((basisPoints) => basisPoints * 10n ** 14n));
  });

  it("changes on the second of the boundary and not before", () => {
    expect(feeRateAt(deployment, 31_535_999n)).toBe(10n ** 15n);
    expect(feeRateAt(deployment, 31_536_000n)).toBe(9n * 10n ** 14n);
  });

  it("refuses a step with no period instead of dividing by zero", () => {
    expect(() => feeRateAt({ ...deployment, stepPeriod: 0n }, 10n)).toThrow(RangeError);
  });

  it("rounds the fee down and never takes more than the amount", () => {
    expect(feeOn(9_999n, 25n * 10n ** 14n)).toBe(24n);
    expect(feeOn(1_000n, FEE_DENOMINATOR)).toBe(1_000n);
  });
});
