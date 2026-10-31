/**
 * The owner's rule for numbers that are not inputs: three or more leading zeros after the point collapse into a
 * subscript count, so 0.0001234 reads as 0.0₃1234. Fewer than three zeros stay as they are. Typed amounts are never
 * rewritten; only shown values go through this.
 */

/** The parts of a collapsed number: `lead` ("0.0"), the count of zeros after the point, and the digits after them. */
export type CollapsedZeros = { readonly lead: string; readonly zeros: number; readonly rest: string };

const SMALL = /^0\.(0{3,})(\d+)$/;

/**
 * Splits a decimal text with three or more leading zeros after the point.
 *
 * @param text A plain decimal text, such as "0.0001234".
 * @returns The parts, or null when the number shows as it is.
 */
export const collapseZeros = (text: string): CollapsedZeros | null => {
  const match = SMALL.exec(text);
  if (match === null) return null;
  return { lead: "0.0", zeros: match[1]!.length, rest: match[2]! };
};

const SUBSCRIPT = "₀₁₂₃₄₅₆₇₈₉";

/**
 * Dollars (USD × 1e18, as the shared fee rules keep them) as text: two decimals from $1, else three significant digits
 * (cut, not rounded) with three or more leading zeros collapsed as subscript digits ($0.0₇504). "$0" for nothing.
 *
 * @param usd The value, USD × 1e18.
 */
export const dollarsText = (usd: bigint): string => {
  if (usd === 0n) return "$0";
  const SCALE = 10n ** 18n;
  if (usd >= SCALE) {
    const cents = usd / 10n ** 16n;
    return `$${(cents / 100n).toLocaleString("en-US")}.${(cents % 100n).toString().padStart(2, "0")}`;
  }
  const fraction = usd.toString().padStart(18, "0");
  const zeros = fraction.length - fraction.replace(/^0+/, "").length;
  const digits = fraction.slice(zeros, zeros + 3).replace(/0+$/, "");
  return zeros >= 3 ? `$0.0${[...String(zeros)].map((digit) => SUBSCRIPT[Number(digit)]).join("")}${digits}` : `$0.${"0".repeat(zeros)}${digits}`;
};
