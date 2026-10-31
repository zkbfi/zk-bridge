/**
 * Deterministic natural logarithm and exponential in integer fixed point, for the fee rules (owner: "make sure that each
 * piece is deterministic"). No floats: every value is a bigint scaled by {@link FIXED_SCALE} (1e36), and every division
 * truncates toward zero. The series stop when a term truncates to zero, so the number of steps depends only on the input,
 * and any implementation of the same steps gives the same digits.
 *
 * Method:
 * - ln(x), x ≥ 1: halve x (truncating) until it is under 2, counting n; then ln(x) = n · ln 2 + 2 · atanh(y) with
 *   y = (x − 1) / (x + 1) ≤ 1/3, summing y^(2k+1) / (2k+1). ln 2 itself is 2 · atanh(1/3) by the same series.
 * - exp(−t), t ≥ 0: write t = n · ln 2 + r with 0 ≤ r < ln 2; exp(−r) is the Taylor series Σ (−r)^k / k!; the result is
 *   halved n times (truncating).
 * The results are within 1000 units of the 36th decimal (truncation accumulates over the terms); the fee rules truncate them to 18 decimals.
 */

/** The scale of every fixed-point value here: 1 is 10^36. */
export const FIXED_SCALE = 10n ** 36n;

/** 2 · atanh(y) for 0 ≤ y < 1 (scaled), by its series; each term truncates. */
const twiceAtanh = (y: bigint): bigint => {
  const ySquared = (y * y) / FIXED_SCALE;
  let power = y;
  let sum = 0n;
  for (let k = 1n; power !== 0n; k += 2n) {
    sum += power / k;
    power = (power * ySquared) / FIXED_SCALE;
  }
  return 2n * sum;
};

/** ln 2, scaled by 1e36: 2 · atanh(1/3). */
export const LN2_SCALED = twiceAtanh(FIXED_SCALE / 3n);

/**
 * The natural logarithm of x ≥ 1, both scaled by 1e36.
 *
 * @param x The value, scaled.
 * @throws RangeError when x is under 1.
 */
export const lnScaled = (x: bigint): bigint => {
  if (x < FIXED_SCALE) throw new RangeError("lnScaled takes values of at least 1");
  let halvings = 0n;
  let rest = x;
  while (rest >= 2n * FIXED_SCALE) {
    rest /= 2n;
    halvings += 1n;
  }
  return halvings * LN2_SCALED + twiceAtanh(((rest - FIXED_SCALE) * FIXED_SCALE) / (rest + FIXED_SCALE));
};

/**
 * exp(−t) for t ≥ 0, both scaled by 1e36.
 *
 * @param t The exponent's magnitude, scaled.
 * @throws RangeError when t is negative.
 */
export const expNegScaled = (t: bigint): bigint => {
  if (t < 0n) throw new RangeError("expNegScaled takes t of at least 0");
  const halvings = t / LN2_SCALED;
  const r = t - halvings * LN2_SCALED;
  let term = FIXED_SCALE;
  let sum = FIXED_SCALE;
  for (let k = 1n; term !== 0n; k += 1n) {
    term = (-term * r) / (FIXED_SCALE * k);
    sum += term;
  }
  return sum >> halvings;
};
