// The proof of work of one grind thread. A plain module: it loads without a TypeScript loader.
//
// The engine of `@msgboard/pow-grinder` tries consecutive nonces from `startNonce`. A thread that starts at its own
// multiple of NONCES_PER_THREAD searches a range that no other thread searches, so that n threads together find a valid
// nonce in about 1/n of the time of one thread, and the first answer wins.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

/**
 * The size of the range of nonces of one thread. The engine takes the first nonce as a 32 bit number, so MAXIMUM_THREADS
 * ranges fill the 32 bits. A range is far beyond the few hundred thousand tries that a proof takes at the board floor.
 */
export const NONCES_PER_THREAD = 2 ** 26;

/** The most threads that have a range of their own. */
export const MAXIMUM_THREADS = 2 ** 32 / NONCES_PER_THREAD;

/**
 * The first nonce of one thread.
 *
 * @param {number} index The number of the thread, from 0.
 * @returns {number} A number below 2^32, because the engine takes the first nonce as a 32 bit number.
 */
export function startNonceFor(index) {
  return index * NONCES_PER_THREAD;
}

/**
 * Builds the `stamper` that `MsgBoardClient` takes, over the range of one thread.
 *
 * @param {(request: object) => Uint8Array | null | undefined} engine The `stamp` of the engine.
 * @param {number} index The number of the thread, from 0.
 * @returns {(input: { category: string, data: string, workMultiplier: bigint, workDivisor: bigint, blockHash: string }) => { nonce: bigint, hash: string }}
 */
export function createRangeStamper(engine, index) {
  return (input) => {
    const answer = engine({
      category: hexBytes(input.category),
      data: hexBytes(input.data),
      workMultiplier: Number(input.workMultiplier),
      workDivisor: Number(input.workDivisor),
      blockHash: hexBytes(input.blockHash),
      version: 1,
      startNonce: startNonceFor(index),
      maxIters: NONCES_PER_THREAD,
    });
    if (answer === null || answer === undefined) throw new Error(`no nonce in the range of thread ${index}`);
    return { nonce: BigInt(`0x${toHex(answer.subarray(0, 8))}`), hash: `0x${toHex(answer.subarray(8, 40))}` };
  };
}

function hexBytes(value) {
  return Uint8Array.from(Buffer.from(value.slice(2), "hex"));
}

function toHex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

/**
 * Loads the WASM engine of `@msgboard/pow-grinder`, the one that the package ships. It is found from the package of the
 * SDK, which is where the SDK itself finds it, and its bytes are read off disk because the default load fetches a URL.
 *
 * @returns {Promise<(request: object) => Uint8Array | undefined>} The `stamp` of the engine.
 */
export async function loadWasmEngine() {
  const path = createRequire(import.meta.url).resolve("@msgboard/pow-grinder/wasm");
  const engine = await import(path);
  await engine.default({ module_or_path: readFileSync(new URL("pow_grinder_bg.wasm", `file://${path}`)) });
  return engine.stamp;
}

/**
 * The stamper of one thread, over the WASM engine. When the engine does not load it is `undefined`, and the client of the
 * SDK goes on with its own search, which is slower but finds the same work.
 *
 * @param {number} index The number of the thread, from 0.
 * @param {() => Promise<(request: object) => Uint8Array | null | undefined>} [load] Loads the engine.
 */
export async function stamperForThread(index, load = loadWasmEngine) {
  try {
    return createRangeStamper(await load(), index);
  } catch {
    return undefined;
  }
}
