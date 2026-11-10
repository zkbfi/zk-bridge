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
 * Builds the `stamper` that `MsgBoardClient` takes, over the ranges of one thread. The thread searches its first range
 * and, when that holds no valid nonce, the next one that is its own: the ranges of the threads take turns, so thread i
 * of n threads searches range i, i + n, i + 2n and so on. It stops when the next range would lie past the 32 bits of the
 * engine, or when the deadline has passed, and then throws. The SDK answers a throw with its own search from nonce 0,
 * which every thread would repeat, so a thread keeps to the engine for as long as it has a range left.
 *
 * @param {(request: object) => Uint8Array | null | undefined} engine The `stamp` of the engine.
 * @param {number} index The number of the thread, from 0.
 * @param {number} [threads] How many threads grind the message.
 * @param {{ deadline?: number, now?: () => number }} [limits] The time (milliseconds since 1970) after which no new range starts.
 * @returns {(input: { category: string, data: string, workMultiplier: bigint, workDivisor: bigint, blockHash: string }) => { nonce: bigint, hash: string }}
 */
export function createRangeStamper(engine, index, threads = 1, { deadline = Infinity, now = Date.now } = {}) {
  return (input) => {
    const request = {
      category: hexBytes(input.category),
      data: hexBytes(input.data),
      workMultiplier: Number(input.workMultiplier),
      workDivisor: Number(input.workDivisor),
      blockHash: hexBytes(input.blockHash),
      version: 1,
      maxIters: NONCES_PER_THREAD,
    };
    for (let range = index; range < MAXIMUM_THREADS; range += threads) {
      if (now() >= deadline) throw new Error(`the time ran out before thread ${index} found a nonce`);
      const answer = engine({ ...request, startNonce: startNonceFor(range) });
      if (answer !== null && answer !== undefined) {
        return { nonce: BigInt(`0x${toHex(answer.subarray(0, 8))}`), hash: `0x${toHex(answer.subarray(8, 40))}` };
      }
    }
    throw new Error(`no nonce in the ranges of thread ${index}`);
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

/** Writes one JSON line to the error output of the process, the way the bots do. */
export function writeWarning(event, fields) {
  process.stderr.write(`${JSON.stringify({ level: "warn", event, ...fields })}\n`);
}

/**
 * The stamper of one thread, over the WASM engine. When the engine does not load it logs `grind_engine_unavailable` with
 * the reason and is `undefined`, and the client of the SDK goes on with its own search, which is slower but finds the
 * same work. That search starts at nonce 0 on every thread, so the parent grinds on one thread when the engine does not
 * load (see `grindOnThreads`).
 *
 * @param {number} index The number of the thread, from 0.
 * @param {number} [threads] How many threads grind the message.
 * @param {{ load?: () => Promise<(request: object) => Uint8Array | null | undefined>, warn?: (event: string, fields: object) => void, deadline?: number }} [options]
 */
export async function stamperForThread(index, threads = 1, { load = loadWasmEngine, warn = writeWarning, deadline } = {}) {
  try {
    return createRangeStamper(await load(), index, threads, { deadline });
  } catch (error) {
    warn("grind_engine_unavailable", { thread: index, reason: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}
