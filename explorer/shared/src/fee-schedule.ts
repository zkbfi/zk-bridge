/**
 * The fee schedule of the token mediator. This is the TypeScript copy of `FeeSchedule.sol`. The test in
 * `test/fee-schedule.test.ts` checks it against vectors that the Solidity library printed, so the two cannot drift.
 */

/** The divisor of a fee rate. A rate of `FEE_DENOMINATOR` is 100%. */
export const FEE_DENOMINATOR = 10n ** 18n;

/** The five values of a schedule. Rates are scaled by `FEE_DENOMINATOR`. Times are in seconds. */
export type FeeSchedule = {
  readonly startTime: bigint;
  readonly startRate: bigint;
  readonly stepRate: bigint;
  readonly floorRate: bigint;
  /** The length of one step. It must not be zero when `stepRate` is not zero. */
  readonly stepPeriod: bigint;
};

/**
 * The rate at a time: `max(startRate - stepRate * floor((timestamp - startTime) / stepPeriod), floorRate)`.
 * It is the start rate at or before the start time, and when the step is zero.
 *
 * @param schedule The schedule. The floor must not exceed the start rate.
 * @param timestamp The time in seconds.
 * @returns The rate, scaled by `FEE_DENOMINATOR`.
 */
export const feeRateAt = (schedule: FeeSchedule, timestamp: bigint): bigint => {
  if (timestamp <= schedule.startTime || schedule.stepRate === 0n) return schedule.startRate;
  if (schedule.stepPeriod === 0n) throw new RangeError("a fee schedule with a step needs a period");
  const steps = (timestamp - schedule.startTime) / schedule.stepPeriod;
  const stepsToTheFloor = (schedule.startRate - schedule.floorRate) / schedule.stepRate;
  if (steps > stepsToTheFloor) return schedule.floorRate;
  return schedule.startRate - steps * schedule.stepRate;
};

/**
 * The fee on an amount at a rate, rounded down.
 *
 * @param amount The amount in base units.
 * @param rate The rate, scaled by `FEE_DENOMINATOR`.
 * @returns The fee in base units.
 */
export const feeOn = (amount: bigint, rate: bigint): bigint => (amount * rate) / FEE_DENOMINATOR;
