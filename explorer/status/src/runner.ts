import type { Logger } from "../../backend/src/logger.ts";
import { sanitize } from "./sanitize.ts";
import type { Store } from "./store.ts";
import type { CheckDefinition, CheckResult, Outcome } from "./types.ts";

const DAY = 86_400_000;

export interface Runner {
  /** Runs every check once and stores the results. Returns nothing when a round is already running. */
  runRound(): Promise<CheckResult[]>;
  /** Runs a round now and then every `intervalMilliseconds`. */
  start(intervalMilliseconds: number): void;
  /** Stops the timer and waits for the round that runs. */
  stop(): Promise<void>;
}

export type RunnerInput = {
  readonly checks: readonly CheckDefinition[];
  readonly store: Store;
  readonly logger: Logger;
  readonly now: () => number;
  readonly timeoutMilliseconds: number;
  readonly retentionMilliseconds: number;
  /** The secret values this process holds; no detail may contain one. */
  readonly secrets: () => readonly string[];
};

/** Runs the checks together, each with its own timeout. A check that throws or does not answer is down. */
export function createRunner(input: RunnerInput): Runner {
  const { store, logger, now } = input;
  const info = Object.fromEntries(input.checks.map((check) => [check.id, { name: check.name, section: check.section }]));
  const lastState = new Map<string, string>();
  let running: Promise<CheckResult[]> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastPrune: number | null = null;

  const execute = async (check: CheckDefinition): Promise<CheckResult> => {
    const started = now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let outcome: Outcome;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`no answer within ${input.timeoutMilliseconds / 1000} s`)), input.timeoutMilliseconds);
      });
      outcome = await Promise.race([check.run(), deadline]);
    } catch (error) {
      outcome = { state: "down", detail: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timeout);
    }
    const finished = now();
    return { id: check.id, at: finished, state: outcome.state, latencyMs: finished - started, detail: sanitize(outcome.detail, input.secrets()) };
  };

  const round = async (): Promise<CheckResult[]> => {
    const results = await Promise.all(input.checks.map(execute));
    try {
      store.record(results, info);
    } catch (error) {
      logger.error("store_failed", { error });
    }
    for (const result of results) {
      const before = lastState.get(result.id);
      if (before !== undefined && before !== result.state) {
        logger.warn("check_changed", { check: result.id, from: before, to: result.state, detail: result.detail });
      }
      lastState.set(result.id, result.state);
    }
    if (lastPrune === null || now() - lastPrune >= DAY) {
      lastPrune = now();
      logger.info("pruned", { removed: store.prune(now() - input.retentionMilliseconds) });
    }
    return results;
  };

  const runRound = async (): Promise<CheckResult[]> => {
    if (running !== null) return [];
    running = round();
    try {
      return await running;
    } finally {
      running = null;
    }
  };

  return {
    runRound,
    start(intervalMilliseconds) {
      void runRound();
      timer = setInterval(() => void runRound(), intervalMilliseconds);
    },
    async stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      await running;
    },
  };
}
