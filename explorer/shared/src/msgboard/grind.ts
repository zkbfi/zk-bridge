import { Worker } from "node:worker_threads";
import type { Hex } from "viem";

export type { GrindInput, GrindResult, GrindFunction } from "@zkb/data";
import type { GrindFunction, GrindInput, GrindResult } from "@zkb/data";

/** The worker failed or ran out of time. */
export class GrindError extends Error {
  override readonly name = "GrindError";
}

type WorkerReply =
  | { readonly ok: true; readonly rlp: Hex; readonly hash: Hex; readonly nonce: string; readonly difficulty: string; readonly iterations: string; readonly durationMilliseconds: number }
  | { readonly ok: false; readonly error: string };

/**
 * Grinds in a worker thread, so the event loop of the bot keeps running. The worker is a plain module
 * (`grind-worker.mjs`) so that it loads without a TypeScript loader.
 *
 * @throws GrindError when the worker reports an error, crashes, or outlives `timeoutMilliseconds`.
 */
export const grindInWorker: GrindFunction = (input) =>
  new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./grind-worker.mjs", import.meta.url), {
      workerData: {
        url: input.boardUrl,
        category: input.category,
        payload: input.payload,
        timeoutMilliseconds: input.timeoutMilliseconds,
      },
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new GrindError(`the proof of work did not finish in ${input.timeoutMilliseconds} milliseconds`));
    }, input.timeoutMilliseconds);
    const finish = (): void => {
      clearTimeout(timer);
      void worker.terminate();
    };
    worker.once("message", (reply: WorkerReply) => {
      finish();
      if (!reply.ok) {
        reject(new GrindError(reply.error));
        return;
      }
      resolve({
        rlp: reply.rlp,
        hash: reply.hash,
        nonce: BigInt(reply.nonce),
        difficulty: BigInt(reply.difficulty),
        iterations: BigInt(reply.iterations),
        durationMilliseconds: reply.durationMilliseconds,
      });
    });
    worker.once("error", (error: Error) => {
      finish();
      reject(new GrindError(`the grind worker crashed: ${error.message}`));
    });
  });
