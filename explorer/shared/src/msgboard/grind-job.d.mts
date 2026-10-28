/** The reply of the grind worker to its parent thread. */
export type GrindReply =
  | { readonly ok: true; readonly rlp: string; readonly hash: string; readonly nonce: string; readonly difficulty: string; readonly iterations: string; readonly durationMilliseconds: number }
  | { readonly ok: false; readonly error: string };

/** The part of the msgboard client that a grind uses. */
export interface GrindBoard {
  status(): Promise<{ enabled: boolean; workMultiplier: number | bigint | string; workDivisor: number | bigint | string }>;
  setDifficultyFactors(multiplier: bigint, divisor: bigint): void;
  grind(category: string, payload: string): Promise<{
    message: { hash: string; nonce: bigint };
    stats: { isValid: boolean; difficulty: bigint; iterations: bigint; duration: number };
  }>;
}

/** Finds the proof of work for one message and builds the reply of the worker. */
export function runGrindJob(
  job: { readonly category: string; readonly payload: string },
  dependencies: { readonly board: GrindBoard; readonly toRLP: (message: never) => string },
): Promise<GrindReply>;
