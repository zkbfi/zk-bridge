/**
 * The time until a light client strands. A light client strands when the source chain signs in the period after its
 * last stored sync committee and nothing moved it; the backend computes the moment (`deadline.at`), and these helpers
 * turn it into the line that the pages show. Hours are computed from `at` and the clock, never from the backend's
 * `hoursLeft`, so the line keeps ticking between answers.
 */

/** The backend's deadline for one direction's light client (the one on the direction's destination). */
export type StrandingDeadline = { readonly at: number; readonly period: number };

/** How loud the line is. */
export type StrandingTone = "normal" | "warn" | "bad";

/** Warn at this many hours left or fewer. */
export const STRANDING_WARN_HOURS = 12;
/** Bad at this many hours left or fewer, and once passed. */
export const STRANDING_BAD_HOURS = 6;

/** The hours left, negative once passed. */
export const hoursLeftOf = (deadline: StrandingDeadline, nowMs: number): number => (deadline.at - nowMs) / 3_600_000;

/** Hours as text: one decimal under 10 h, whole hours from 10 h (9.96 h reads 10, not 10.0). */
export const hoursText = (hours: number): string => (hours < 9.95 ? hours.toFixed(1) : String(Math.round(hours)));

/** The tone of an hours-left value. */
export const toneOf = (hours: number): StrandingTone => (hours <= STRANDING_BAD_HOURS ? "bad" : hours <= STRANDING_WARN_HOURS ? "warn" : "normal");

/**
 * The line for a deadline, or null when the deadline is unknown.
 *
 * @param deadline The deadline, or null/undefined when the backend does not give one.
 * @param nowMs The clock, in milliseconds.
 */
export const strandingLine = (deadline: StrandingDeadline | null | undefined, nowMs: number): { readonly text: string; readonly tone: StrandingTone; readonly hours: number } | null => {
  if (deadline === null || deadline === undefined) return null;
  const hours = hoursLeftOf(deadline, nowMs);
  const text = hours < 0 ? `Past the stranding point by ${hoursText(-hours)} h (period ${deadline.period})` : `${hoursText(hours)} h until stranded (period ${deadline.period})`;
  return { text, tone: toneOf(hours), hours };
};

/** The note for the route menu: only from 6 h left or fewer, and once passed. Null otherwise. */
export const strandingMenuNote = (deadline: StrandingDeadline | null | undefined, nowMs: number): string | null => {
  if (deadline === null || deadline === undefined) return null;
  const hours = hoursLeftOf(deadline, nowMs);
  if (hours > STRANDING_BAD_HOURS) return null;
  return hours < 0 ? "light client is past its stranding point" : `light client ${hoursText(hours)} h from stranded`;
};
