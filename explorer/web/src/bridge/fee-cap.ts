/**
 * The automatic fee cap the user set in Settings (owner: "make the cap adjustable"). Stored in this browser only; a
 * link can still carry a different cap for one transfer.
 */
import { DEFAULT_CAP_WAD, PERCENT_WAD } from "@zk-bridge/shared";

/** The automatic fee's cap by default, in percent (owner: "cap ... at 1%"); the shared rules hold it as a share. */
export const DEFAULT_AUTO_CAP_PERCENT = Number(DEFAULT_CAP_WAD / PERCENT_WAD);

const KEY = "zk-bridge-explorer.fee-cap";

/**
 * Why a cap cannot be used, or null. It must be a number of percent above 0 and at most 100.
 *
 * @param text The cap as typed.
 */
export const feeCapProblem = (text: string): string | null => {
  const value = Number(text.trim());
  if (text.trim() === "" || !Number.isFinite(value)) return "Enter a number of percent, such as 1.";
  if (value <= 0 || value > 100) return "Use a number above 0 and at most 100.";
  return null;
};

/** The cap in use, in percent: the stored one when it is valid, else 1%. */
export const loadFeeCap = (storage: Pick<Storage, "getItem"> | null = safeStorage()): number => {
  try {
    const stored = storage?.getItem(KEY) ?? null;
    return stored !== null && feeCapProblem(stored) === null ? Number(stored) : DEFAULT_AUTO_CAP_PERCENT;
  } catch {
    return DEFAULT_AUTO_CAP_PERCENT;
  }
};

/**
 * Stores a cap, or clears it (back to 1%) when null. Returns the problem when the cap is refused.
 *
 * @param text The cap in percent, or null for the default.
 */
export const saveFeeCap = (text: string | null, storage: Pick<Storage, "setItem" | "removeItem"> | null = safeStorage()): string | null => {
  if (text !== null) {
    const problem = feeCapProblem(text);
    if (problem !== null) return problem;
  }
  try {
    if (text === null || Number(text) === DEFAULT_AUTO_CAP_PERCENT) storage?.removeItem(KEY);
    else storage?.setItem(KEY, String(Number(text)));
  } catch {
    // The choice then lasts for this visit only.
  }
  return null;
};

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
