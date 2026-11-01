import { createHash } from "node:crypto";

/**
 * When a direction of the traffic bot sends. Time is cut into intervals of `intervalMilliseconds`, shifted by the
 * offset of the direction. Each interval is a slot, numbered from the start of 1970. A direction sends once in each
 * slot, at the start of the slot plus a jitter. The jitter comes from a hash of the direction and the slot, so it is the
 * same after a restart, and the two directions of one slot get different jitters.
 */
export interface Schedule {
  readonly intervalMilliseconds: number;
  readonly offsetMilliseconds: number;
  readonly jitterMilliseconds: number;
}

/** The slot that holds a moment. */
export function slotOf(nowMilliseconds: number, schedule: Schedule): number {
  return Math.floor((nowMilliseconds - schedule.offsetMilliseconds) / schedule.intervalMilliseconds);
}

/** The jitter of a slot: a whole number of milliseconds from 0 to `jitterMilliseconds`, the same on every call. */
export function jitterOf(direction: string, slot: number, jitterMilliseconds: number): number {
  const digest = createHash("sha256").update(`${direction}:${slot}`).digest();
  // Six bytes give a fraction with 48 bits, exact in a double.
  const fraction = digest.readUIntBE(0, 6) / 2 ** 48;
  return Math.floor(fraction * (jitterMilliseconds + 1));
}

/** The moment at which a direction is due in a slot. */
export function dueAt(direction: string, slot: number, schedule: Schedule): number {
  return slot * schedule.intervalMilliseconds + schedule.offsetMilliseconds + jitterOf(direction, slot, schedule.jitterMilliseconds);
}

/**
 * The slot to send in now, or null when nothing is due: the current slot, unless it was attempted already or its due
 * time lies ahead.
 *
 * @param lastSlot The slot of the last attempt of the direction, or null when it never sent.
 */
export function slotDue(input: { readonly direction: string; readonly nowMilliseconds: number; readonly lastSlot: number | null; readonly schedule: Schedule }): number | null {
  const slot = slotOf(input.nowMilliseconds, input.schedule);
  if (input.lastSlot !== null && input.lastSlot >= slot) return null;
  return input.nowMilliseconds >= dueAt(input.direction, slot, input.schedule) ? slot : null;
}
