/**
 * The fee hooks of the bridge screen. The rules are the ones of `@zkb/core` (default fee, warnings, the hard cap check);
 * these hooks only keep their answer while their inputs do not change, and hold the two caps the user stores. Every
 * amount is a plain value from the host: money is USD x 1e18 (`bigint`), a share is x 1e18, a cap is a number of percent.
 */
import { useCallback, useMemo, useState } from "react";
import {
  DEFAULT_CAP_WAD,
  DEFAULT_HARD_CAP_WAD,
  PERCENT_WAD,
  defaultFee,
  feeWarnings,
  hardCapCheck,
  highCapLine,
  shareWadOfPercentText,
  type DefaultFee,
  type FeeWarningsInput,
  type FeeWarnings,
  type HardCapCheck,
} from "@zkb/core";
import { loadFeeCap, loadHardCap, saveFeeCap, saveHardCap } from "./fee-cap.js";

/** A number as short text, at most `digits` decimals, no trailing zeros. */
export const plainNumber = (value: number, digits = 4): string => String(Number(value.toFixed(digits)));

/**
 * A cap in percent as a share scaled by 1e18, to the nearest 0.000001%; the fallback when it is not a share.
 *
 * @param percent The cap in percent.
 * @param fallback What a cap that cannot be read stands for.
 */
export const capWadOf = (percent: number, fallback: bigint): bigint => shareWadOfPercentText(plainNumber(percent, 6)) ?? fallback;

/** What {@link useDefaultFee} reads. */
export type DefaultFeeInput = {
  /** The value of the transfer, or null without a price. */
  readonly amountUsd: bigint | null;
  /** The cost of delivery and proof at the gas level in force, or null without a price. */
  readonly costUsd: bigint | null;
  /** The same cost at the Normal gas level. */
  readonly costNormalUsd: bigint | null;
  /** The automatic fee's cap, in percent of the amount. */
  readonly capPercent: number;
};

/**
 * The default fee: the larger of the default curve and twice the cost, held at the cap. A higher gas level adds its
 * extra expected cost on top of the curve, so the fee rises with the bars.
 *
 * @param input The amount, the costs and the cap.
 */
export const useDefaultFee = ({ amountUsd, costUsd, costNormalUsd, capPercent }: DefaultFeeInput): { readonly capWad: bigint; readonly auto: DefaultFee } => {
  const capWad = capWadOf(capPercent, DEFAULT_CAP_WAD);
  return useMemo(
    () => ({ capWad, auto: defaultFee({ amountUsd, costUsd, capWad, ...(costUsd === null || costNormalUsd === null ? {} : { levelExtraUsd: costUsd - costNormalUsd }) }) }),
    [amountUsd, costUsd, costNormalUsd, capWad],
  );
};

/** The warnings, with the line that a tip should stay under, as a percent number and as text. */
export type FeeWarningsResult = {
  readonly warnings: FeeWarnings;
  /** The high-cap line for this amount, in percent. */
  readonly linePercent: number;
  /** The line as text, such as `1.5%`. */
  readonly thresholdText: string;
};

/**
 * The fee warnings (small transfer, low fee, "High cap %", cap warning) and the line a tip should stay under.
 *
 * @param input The rule's inputs.
 */
export const useFeeWarnings = (input: FeeWarningsInput): FeeWarningsResult => {
  const key = JSON.stringify(input, (_name, value: unknown) => (typeof value === "bigint" ? `${value}n` : value));
  return useMemo(() => {
    const line = highCapLine(input.amountUsd);
    const linePercent = Number((line.numerator * 10n ** 8n) / line.denominator) / 10 ** 6;
    return { warnings: feeWarnings(input), linePercent, thresholdText: `${Number(linePercent.toPrecision(2))}%` };
    // The key is the input's content, so the memo follows what the input says, not the identity of the object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
};

/** What {@link useHardCap} reads. */
export type HardCapInput = {
  /** The hard cap in percent of the amount. */
  readonly hardCapPercent: number;
  /** The amount in base units, or null when none is typed. */
  readonly amountUnits: bigint | null;
  /** The fee now in base units, or null when it is not known. */
  readonly feeUnits: bigint | null;
  /** For a gas-based fee, the most the signed terms allow; 0 for a fixed fee. */
  readonly worstFeeUnits: bigint;
};

/** The hard cap's answer. */
export type HardCapResult = {
  readonly hardCapWad: bigint;
  /** The check, or null while there is no amount or fee to check. */
  readonly check: HardCapCheck | null;
  readonly over: boolean;
  /** The smallest cap in percent that admits the fee, or null when the fee is within the cap. */
  readonly raisePercent: number | null;
};

/**
 * The hard fee cap against the fee now (or for a gas-based fee the most the signed terms allow). Above it the Bridge
 * button is blocked until the cap is raised.
 *
 * @param input The cap, the amount and the fee.
 */
export const useHardCap = ({ hardCapPercent, amountUnits, feeUnits, worstFeeUnits }: HardCapInput): HardCapResult => {
  const hardCapWad = capWadOf(hardCapPercent, DEFAULT_HARD_CAP_WAD);
  return useMemo(() => {
    const check = amountUnits !== null && amountUnits > 0n && feeUnits !== null ? hardCapCheck({ amountUnits, feeUnits, worstFeeUnits, hardCapWad }) : null;
    return { hardCapWad, check, over: check !== null && check.over, raisePercent: check === null ? null : Number((check.raiseToWad * 10_000n) / PERCENT_WAD) / 10_000 };
  }, [hardCapWad, amountUnits, feeUnits, worstFeeUnits]);
};

/** The storage the caps are kept in: the `Storage` of a browser, or any object with these methods. */
export type CapStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** What {@link useFeeCaps} gives. */
export type FeeCaps = {
  /** The automatic cap stored for this browser, in percent (never above the hard cap). */
  readonly storedCap: number;
  /** The hard cap stored for this browser, in percent. */
  readonly storedHardCap: number;
  /** The hard cap in use now: the stored one until the user moves it. */
  readonly hardCapPercent: number;
  /** Moves the hard cap in use, without storing it. */
  readonly setHardCapPercent: (percent: number) => void;
  /** Stores the automatic cap; returns why it was refused, or null. */
  readonly saveCap: (percent: number) => string | null;
  /** Stores the hard cap in use; a stored automatic cap above it follows it down. */
  readonly saveHard: () => void;
};

/**
 * The two caps the user stores: the automatic cap and the hard cap. The storage is the host's (the browser's
 * `localStorage` unless the host passes its own, or null to keep nothing).
 *
 * @param storage Where the caps are kept; omitted, `window.localStorage`.
 */
export const useFeeCaps = (storage?: CapStorage | null): FeeCaps => {
  const use = storage === undefined ? browserStorage() : storage;
  const [storedCap, setStoredCap] = useState(() => loadFeeCap(use));
  const [storedHardCap, setStoredHardCap] = useState(() => loadHardCap(use));
  const [hardCapPercent, setHardCapPercent] = useState(storedHardCap);
  const saveCap = useCallback(
    (percent: number): string | null => {
      const problem = saveFeeCap(String(percent), use);
      if (problem === null) setStoredCap(loadFeeCap(use));
      return problem;
    },
    [use],
  );
  const saveHard = useCallback((): void => {
    if (saveHardCap(String(hardCapPercent), use) !== null) return;
    setStoredHardCap(loadHardCap(use));
    setStoredCap(loadFeeCap(use));
  }, [use, hardCapPercent]);
  return { storedCap, storedHardCap, hardCapPercent, setHardCapPercent, saveCap, saveHard };
};

function browserStorage(): CapStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
