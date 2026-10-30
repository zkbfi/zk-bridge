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
