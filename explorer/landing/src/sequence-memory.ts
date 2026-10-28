/** Remembers the highest release sequence this browser has seen, so a replay of an old manifest is caught. */

const STORAGE_KEY = "release-sequence-highest";

/** The result of comparing a manifest sequence with the remembered one. */
export type SequenceCheck =
  | { kind: "accepted" }
  | { kind: "lower"; remembered: number }
  | { kind: "not-remembered" };

/**
 * Compares a sequence with the remembered one and stores it when it is not lower.
 * Storage can be missing or can throw (private mode); then nothing is remembered and the
 * signature check alone decides.
 */
export function rememberSequence(
  storage: Pick<Storage, "getItem" | "setItem"> | null,
  sequence: number,
): SequenceCheck {
  if (storage === null) return { kind: "not-remembered" };
  try {
    const stored = storage.getItem(STORAGE_KEY);
    const remembered = stored === null ? null : Number(stored);
    if (remembered !== null && Number.isSafeInteger(remembered) && sequence < remembered) {
      return { kind: "lower", remembered };
    }
    storage.setItem(STORAGE_KEY, String(sequence));
    return { kind: "accepted" };
  } catch {
    return { kind: "not-remembered" };
  }
}
