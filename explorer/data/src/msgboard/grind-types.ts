import type { Hex } from "viem";

/** What a grind needs. The endpoint can carry a key, so it travels in the worker data and never in a log. */
export interface GrindInput {
  readonly boardUrl: string;
  readonly category: Hex;
  readonly payload: Hex;
  readonly timeoutMilliseconds: number;
}

/** A message with its proof of work, ready for `msgboard_addMessage`. */
export interface GrindResult {
  /** The message in the length prefix encoding that `msgboard_addMessage` takes. */
  readonly rlp: Hex;
  readonly hash: Hex;
  readonly nonce: bigint;
  readonly difficulty: bigint;
  readonly iterations: bigint;
  readonly durationMilliseconds: number;
  /** The threads that searched for the nonce at once. */
  readonly threads: number;
}

/** Finds the proof of work for a message. The real one runs in a worker thread in Node. */
export type GrindFunction = (input: GrindInput) => Promise<GrindResult>;
