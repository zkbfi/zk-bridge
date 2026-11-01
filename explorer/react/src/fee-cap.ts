/**
 * The two fee caps the user sets (owner: "make the cap adjustable"; quote 86: "another fee cap below that of, say 2%
 * that puts the absolute fee cap at that amount"). The automatic cap limits what the dapp sets by itself; the hard cap
 * is the absolute most the fee may be, and the automatic cap never goes above it. Stored in this browser only; a link
 * can still carry a different automatic cap for one transfer.
 */
import { DEFAULT_CAP_WAD, DEFAULT_HARD_CAP_WAD, PERCENT_WAD } from "@zkb/core";

/** The automatic fee's cap by default, in percent (owner: "cap ... at 1%"); the shared rules hold it as a share. */
export const DEFAULT_AUTO_CAP_PERCENT = Number(DEFAULT_CAP_WAD / PERCENT_WAD);
/** The hard fee cap by default, in percent (owner: "say 2%"). */
export const DEFAULT_HARD_CAP_PERCENT = Number(DEFAULT_HARD_CAP_WAD / PERCENT_WAD);

type Cap = "auto" | "hard";
const KEYS: Readonly<Record<Cap, string>> = { auto: "zk-bridge-explorer.fee-cap", hard: "zk-bridge-explorer.hard-fee-cap" };
const DEFAULTS: Readonly<Record<Cap, number>> = { auto: DEFAULT_AUTO_CAP_PERCENT, hard: DEFAULT_HARD_CAP_PERCENT };

/**
 * Why a cap cannot be used, or null. It must be a number of percent above 0 and at most 100.
 *
 * @param text The cap as typed.
 */
export const feeCapProblem = (text: string): string | null => {
  const value = Number(text.trim().replace(/%$/, ""));
  if (text.trim() === "" || !Number.isFinite(value)) return "Enter a number of percent, such as 1.";
  if (value <= 0 || value > 100) return "Use a number above 0 and at most 100.";
  return null;
};

const load = (cap: Cap, storage: Pick<Storage, "getItem"> | null): number => {
  try {
    const stored = storage?.getItem(KEYS[cap]) ?? null;
    return stored !== null && feeCapProblem(stored) === null ? Number(stored) : DEFAULTS[cap];
  } catch {
    return DEFAULTS[cap];
  }
};

const save = (cap: Cap, text: string | null, storage: Pick<Storage, "setItem" | "removeItem"> | null): string | null => {
  if (text !== null) {
    const problem = feeCapProblem(text);
    if (problem !== null) return problem;
  }
  try {
    if (text === null || Number(text) === DEFAULTS[cap]) storage?.removeItem(KEYS[cap]);
    else storage?.setItem(KEYS[cap], String(Number(text)));
  } catch {
    // The choice then lasts for this visit only.
  }
  return null;
};

/** The hard cap in use, in percent: the stored one when it is valid, else 2%. */
export const loadHardCap = (storage: Pick<Storage, "getItem"> | null = safeStorage()): number => load("hard", storage);

/** The automatic cap in use, in percent: the stored one when it is valid, else 1%; never above the hard cap. */
export const loadFeeCap = (storage: Pick<Storage, "getItem"> | null = safeStorage()): number => Math.min(load("auto", storage), loadHardCap(storage));

/**
 * Stores the automatic cap, or clears it (back to 1%) when null. Returns the problem when the cap is refused, and
 * refuses a cap above the hard cap.
 *
 * @param text The cap in percent, or null for the default.
 */
export const saveFeeCap = (text: string | null, storage: (Pick<Storage, "setItem" | "removeItem"> & Partial<Pick<Storage, "getItem">>) | null = safeStorage()): string | null => {
  const hard = storage !== null && storage.getItem !== undefined ? loadHardCap(storage as Pick<Storage, "getItem">) : DEFAULT_HARD_CAP_PERCENT;
  if (text !== null && feeCapProblem(text) === null && Number(text) > hard) return `The automatic cap can't be above your ${hard}% hard cap.`;
  return save("auto", text, storage);
};

/**
 * Stores the hard cap, or clears it (back to 2%) when null. A stored automatic cap above the new hard cap follows it
 * down (owner: the automatic cap can never exceed the hard cap). Returns the problem when the cap is refused.
 *
 * @param text The cap in percent, or null for the default.
 */
export const saveHardCap = (text: string | null, storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null = safeStorage()): string | null => {
  const problem = save("hard", text, storage);
  if (problem !== null) return problem;
  const hard = loadHardCap(storage);
  if (load("auto", storage) > hard) save("auto", String(hard), storage);
  return null;
};

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
