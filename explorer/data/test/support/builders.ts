import type { Address, Hex } from "viem";

/** A 32 byte word with every byte set to `seed`. */
export const word = (seed: number): Hex => `0x${seed.toString(16).padStart(2, "0").repeat(32)}`;
/** An address with every byte set to `seed`. */
export const address = (seed: number): Address => `0x${seed.toString(16).padStart(2, "0").repeat(20)}`;

/** A logger that keeps its events, in order. */
export function memoryLogger(): {
  readonly logger: { debug(event: string, fields?: Record<string, unknown>): void; info(event: string, fields?: Record<string, unknown>): void };
  readonly events: () => Array<Record<string, unknown>>;
} {
  const kept: Array<Record<string, unknown>> = [];
  const keep = (level: string) => (event: string, fields: Record<string, unknown> = {}) => {
    kept.push({ level, event, ...fields });
  };
  return { logger: { debug: keep("debug"), info: keep("info") }, events: () => kept };
}
