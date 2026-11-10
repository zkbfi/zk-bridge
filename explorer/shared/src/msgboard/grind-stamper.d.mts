/** The `stamp` of the engine of `@msgboard/pow-grinder`. */
export type StampEngine = (request: object) => Uint8Array | null | undefined;

/** What the SDK asks a stamper to grind. */
export interface StamperInput {
  readonly category: string;
  readonly data: string;
  readonly workMultiplier: bigint;
  readonly workDivisor: bigint;
  readonly blockHash: string;
}

/** The size of the range of nonces of one thread. */
export const NONCES_PER_THREAD: number;

/** The most threads that have a range of their own. */
export const MAXIMUM_THREADS: number;

/** The first nonce of the thread with this number. */
export function startNonceFor(index: number): number;

/** The stamper of one thread, which searches the ranges of that thread in turn, until the deadline or the end of the 32 bits. */
export function createRangeStamper(engine: StampEngine, index: number, threads?: number, limits?: { readonly deadline?: number; readonly now?: () => number }): (input: StamperInput) => { nonce: bigint; hash: `0x${string}` };

/** Loads the WASM engine of `@msgboard/pow-grinder`. */
export function loadWasmEngine(): Promise<StampEngine>;

/** Writes one JSON line with level, event and fields to the error output. */
export function writeWarning(event: string, fields: Record<string, unknown>): void;

/** The stamper of one thread over the WASM engine, or `undefined` (after a `grind_engine_unavailable` warning) when the engine does not load. */
export function stamperForThread(
  index: number,
  threads?: number,
  options?: { readonly load?: () => Promise<StampEngine>; readonly warn?: (event: string, fields: Record<string, unknown>) => void; readonly deadline?: number },
): Promise<((input: StamperInput) => { nonce: bigint; hash: `0x${string}` }) | undefined>;
