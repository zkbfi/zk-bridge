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

/** The stamper of one thread, which searches the range of nonces of that thread only. */
export function createRangeStamper(engine: StampEngine, index: number): (input: StamperInput) => { nonce: bigint; hash: `0x${string}` };

/** Loads the WASM engine of `@msgboard/pow-grinder`. */
export function loadWasmEngine(): Promise<StampEngine>;

/** The stamper of one thread over the WASM engine, or `undefined` when the engine does not load. */
export function stamperForThread(index: number, load?: () => Promise<StampEngine>): Promise<((input: StamperInput) => { nonce: bigint; hash: `0x${string}` }) | undefined>;
