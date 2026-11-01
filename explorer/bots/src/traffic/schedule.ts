import type { Random } from "./plan.ts";

/** Milliseconds in a clock hour. */
export const HOUR_MILLISECONDS = 3_600_000;

/**
 * How many sends a direction makes in a clock hour (UTC), and how close two of them may be. At the start of each hour
 * a direction draws a count from `minPerHour` to `maxPerHour`, uniformly, and that many send times inside the hour.
 */
export interface Cadence {
  readonly minPerHour: number;
  readonly maxPerHour: number;
  readonly minGapSeconds: number;
}

/** The plan of one direction for one clock hour. It is stored in the state file before the first send. */
export interface HourPlan {
  /** The hour, numbered from the start of 1970 (UTC). */
  readonly hour: number;
  /** How many sends the hour holds. */
  readonly count: number;
  /** The send times in milliseconds since 1970, sorted, inside the hour, at least the minimum gap apart. */
  readonly times: number[];
  /** For each time, whether its attempt started (a skip counts: a time is used once). */
  readonly sent: boolean[];
}

/** The clock hour that holds a moment. */
export function hourOf(nowMilliseconds: number): number {
  return Math.floor(nowMilliseconds / HOUR_MILLISECONDS);
}

/** A whole number from `low` to `high`, both included, uniform for a uniform `random`. */
function integerBetween(low: number, high: number, random: Random): number {
  return low + Math.floor(random() * (high - low + 1));
}

/**
 * Draws the plan of a clock hour: the count uniformly from `minPerHour` to `maxPerHour`, then that many times uniformly
 * at random inside the hour, at least `minGapSeconds` apart. (The times are drawn in the hour shortened by the gaps,
 * sorted, and each is moved later by its share of the gaps. Every spacing that the gap allows is as likely as any other.)
 */
export function drawPlan(input: { readonly hour: number; readonly cadence: Cadence; readonly random: Random }): HourPlan {
  const { hour, cadence, random } = input;
  const count = integerBetween(cadence.minPerHour, cadence.maxPerHour, random);
  const gap = cadence.minGapSeconds * 1000;
  const room = HOUR_MILLISECONDS - 1 - (count - 1) * gap;
  const raw = Array.from({ length: count }, () => integerBetween(0, room, random)).sort((a, b) => a - b);
  const start = hour * HOUR_MILLISECONDS;
  return { hour, count, times: raw.map((offset, index) => start + offset + index * gap), sent: raw.map(() => false) };
}

/** How many times of the plan have not been used. */
export function unsentIn(plan: HourPlan): number {
  return plan.sent.filter((used) => !used).length;
}

/**
 * The index of the time to send at now, or null: the first unused time that has come, once the minimum gap since the
 * last attempt of the direction has passed. A time that came while the bot was down sends late, inside its hour.
 */
export function dueIndex(input: { readonly plan: HourPlan; readonly nowMilliseconds: number; readonly lastAttemptAtMilliseconds: number | null; readonly cadence: Cadence }): number | null {
  const { plan, nowMilliseconds } = input;
  const index = plan.sent.indexOf(false);
  if (index === -1 || (plan.times[index] as number) > nowMilliseconds) return null;
  const last = input.lastAttemptAtMilliseconds;
  if (last !== null && nowMilliseconds < last + input.cadence.minGapSeconds * 1000) return null;
  return index;
}
