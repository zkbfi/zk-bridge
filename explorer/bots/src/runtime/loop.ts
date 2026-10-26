import type { Logger } from "../logging/logger.ts";

/** Waits for a time, or until the signal fires. Resolves in both cases. */
export function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

/** Input of {@link runLoop}. */
export interface LoopInput {
  readonly name: string;
  readonly intervalMilliseconds: number;
  /** One pass of the bot. An error is logged and the loop goes on, because the next pass may succeed. */
  readonly step: () => Promise<unknown>;
  readonly signal: AbortSignal;
  /** Run one pass and return. */
  readonly runOnce: boolean;
  readonly logger: Logger;
}

/**
 * Runs a step again and again until the signal fires. A step that throws does not stop the loop.
 */
export async function runLoop(input: LoopInput): Promise<void> {
  while (!input.signal.aborted) {
    try {
      await input.step();
    } catch (error) {
      input.logger.error("step_failed", { loop: input.name, error });
    }
    if (input.runOnce) return;
    await sleep(input.intervalMilliseconds, input.signal);
  }
}
