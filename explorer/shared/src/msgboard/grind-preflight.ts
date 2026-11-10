import { Worker } from "node:worker_threads";
import { checkWork, difficulty } from "@msgboard/sdk";
import type { Hex } from "viem";
import { GrindError, type GrindFunction } from "./grind.js";

/** The difficulty of the message of the preflight: tiny, so that a working engine answers in milliseconds. */
export const PREFLIGHT_DIFFICULTY = 256n;

/** How long the preflight waits for the worker, in milliseconds, unless the caller says otherwise. */
export const PREFLIGHT_TIMEOUT_MILLISECONDS = 5_000;

const CATEGORY: Hex = `0x${"11".repeat(32)}`;
const DATA: Hex = "0xdeadbeef";
const BLOCK_HASH: Hex = `0x${"ab".repeat(32)}`;
/** The board charges (2^24 + 10000 for each byte of data) times multiplier over divisor, so this divisor gives 256 for 4 bytes. */
const FACTORS = { workMultiplier: 1n, workDivisor: 65_692n } as const;

/** What the preflight found. A failure says which part broke. */
export type PreflightResult =
  | { readonly ok: true; readonly durationMilliseconds: number }
  | { readonly ok: false; readonly reason: "load-failed" | "wrong-result" | "timeout"; readonly detail: string };

type PreflightReply =
  | { readonly ok: true; readonly nonce: string; readonly hash: Hex }
  | { readonly ok: false; readonly stage: "load" | "search"; readonly error: string };

/**
 * Tests the grind engine before anything is signed: on a worker thread, as in production, it loads the WASM engine and
 * finds a real nonce at a difficulty of 256, and then this thread checks the nonce with the check of the SDK, which is
 * the check that the board makes. The SDK would otherwise fall back to its slow search without a word.
 *
 * Never rejects: every failure is a result.
 */
export function grindPreflight(options: { readonly timeoutMilliseconds?: number } = {}): Promise<PreflightResult> {
  const timeoutMilliseconds = options.timeoutMilliseconds ?? PREFLIGHT_TIMEOUT_MILLISECONDS;
  return new Promise((resolve) => {
    const started = Date.now();
    let worker: Worker | undefined;
    const settle = (result: PreflightResult): void => {
      clearTimeout(timer);
      if (worker !== undefined) void worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => settle({ ok: false, reason: "timeout", detail: `no proof of work within ${timeoutMilliseconds} milliseconds` }), timeoutMilliseconds);
    try {
      worker = new Worker(new URL("./grind-preflight-worker.mjs", import.meta.url), {
        workerData: { category: CATEGORY, data: DATA, blockHash: BLOCK_HASH, workMultiplier: FACTORS.workMultiplier.toString(), workDivisor: FACTORS.workDivisor.toString() },
      });
    } catch (error) {
      settle({ ok: false, reason: "load-failed", detail: `the worker did not start: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    worker.once("message", (reply: PreflightReply) => settle(judge(reply, Date.now() - started)));
    worker.once("error", (error: Error) => settle({ ok: false, reason: "load-failed", detail: `the worker crashed: ${error.message}` }));
  });
}

/** Checks the answer of the worker against the rule of the board. */
function judge(reply: PreflightReply, durationMilliseconds: number): PreflightResult {
  if (!reply.ok) return { ok: false, reason: reply.stage === "load" ? "load-failed" : "wrong-result", detail: reply.error };
  const message = { category: CATEGORY, data: DATA, blockHash: BLOCK_HASH, ...FACTORS, blockNumber: 0n, nonce: BigInt(reply.nonce), hash: reply.hash, version: 1 };
  const target = difficulty(FACTORS, 4);
  // A checked hash that differs from the reported one, or no valid hash at all, means that the engine answers wrongly.
  if (target < PREFLIGHT_DIFFICULTY || checkWork(message as never, target) !== reply.hash) {
    return { ok: false, reason: "wrong-result", detail: `the nonce ${reply.nonce} is not valid work at a difficulty of ${PREFLIGHT_DIFFICULTY}` };
  }
  return { ok: true, durationMilliseconds };
}

/**
 * Wraps a grind so that it refuses to start when the preflight failed: it rejects with a {@link GrindError} that names the
 * reason, and never searches. Without a result (the preflight has not run) the grind is returned as it is.
 */
export function guardGrind(grind: GrindFunction, preflight: PreflightResult | undefined): GrindFunction {
  if (preflight === undefined || preflight.ok) return grind;
  const error = new GrindError(`the proof-of-work engine failed its start-up test (${preflight.reason}: ${preflight.detail}), so no proof of work is started`);
  return () => Promise.reject(error);
}
