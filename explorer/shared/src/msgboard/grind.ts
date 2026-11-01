import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { Hex } from "viem";
import { MAXIMUM_THREADS } from "./grind-stamper.mjs";

export type { GrindInput, GrindResult, GrindFunction } from "@zkb/data";
import type { GrindFunction, GrindInput, GrindResult } from "@zkb/data";

/** The worker failed or ran out of time. */
export class GrindError extends Error {
  override readonly name = "GrindError";
}

type WorkerReply =
  | { readonly ok: true; readonly rlp: Hex; readonly hash: Hex; readonly nonce: string; readonly difficulty: string; readonly iterations: string; readonly durationMilliseconds: number }
  | { readonly ok: false; readonly error: string };

/** One thread per core, so that the whole machine searches for the nonce. At least one, and no more than the ranges allow. */
export function threadsForGrind(): number {
  return Math.max(1, Math.min(availableParallelism(), MAXIMUM_THREADS));
}

/**
 * Grinds on `threads` worker threads at once, so that the event loop of the bot keeps running. Each thread searches a
 * range of nonces of its own, and the first to find a valid nonce wins: the others stop. The worker is a plain module
 * (`grind-worker.mjs`) so that it loads without a TypeScript loader.
 *
 * @throws GrindError when every worker reports an error or crashes, or when none finishes within `timeoutMilliseconds`.
 */
export function grindOnThreads(input: GrindInput, threads: number): Promise<GrindResult> {
  return new Promise((resolve, reject) => {
    const started = Array.from(
      { length: threads },
      (_, threadIndex) =>
        new Worker(new URL("./grind-worker.mjs", import.meta.url), {
          workerData: {
            url: input.boardUrl,
            category: input.category,
            payload: input.payload,
            timeoutMilliseconds: input.timeoutMilliseconds,
            threadIndex,
          },
        }),
    );
    let settled = false;
    let failures = 0;
    let firstError: GrindError | undefined;
    const finish = (): void => {
      settled = true;
      clearTimeout(timer);
      for (const worker of started) void worker.terminate();
    };
    const timer = setTimeout(() => {
      finish();
      reject(new GrindError(`the proof of work did not finish in ${input.timeoutMilliseconds} milliseconds`));
    }, input.timeoutMilliseconds);
    // A failed thread does not end the grind while another thread still searches: its range may be the only one that failed.
    const fail = (error: GrindError): void => {
      failures += 1;
      firstError ??= error;
      if (failures === threads) {
        finish();
        reject(firstError);
      }
    };
    for (const worker of started) {
      worker.once("message", (reply: WorkerReply) => {
        if (settled) return;
        if (!reply.ok) {
          fail(new GrindError(reply.error));
          return;
        }
        finish();
        resolve({
          rlp: reply.rlp,
          hash: reply.hash,
          nonce: BigInt(reply.nonce),
          difficulty: BigInt(reply.difficulty),
          iterations: BigInt(reply.iterations),
          durationMilliseconds: reply.durationMilliseconds,
          threads,
        });
      });
      worker.once("error", (error: Error) => {
        if (!settled) fail(new GrindError(`the grind worker crashed: ${error.message}`));
      });
    }
  });
}

/** Grinds on one thread per core. */
export const grindInWorker: GrindFunction = (input) => grindOnThreads(input, threadsForGrind());
