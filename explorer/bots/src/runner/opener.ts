import type { Address, Hex } from "viem";
import type { ProofDirection } from "@zk-bridge/shared";
import type { LightClientReader, OpeningProver } from "@zk-bridge/shared/prover";
import { sendTerms, type TransactionPort } from "../chain/transactions.ts";
import type { Logger } from "../logging/logger.ts";
import type { StateStore } from "../runtime/state-file.ts";
import { createSerialQueue, type SerialQueue } from "./serial-queue.ts";
import type { RunnerState } from "./state.ts";

/**
 * Everything the opener needs. It opens the bridge on the destination chain of the runner's direction.
 *
 * The mapping: the runner of the direction S to D posts updates to the light client on D, which stores blocks of S. The
 * bridge on D names that light client as its own, and the light client on S as its remote light client.
 * `openDeposits` on D proves that the light client on D stored a block of S in whose state the light client on S had
 * already stored a head. So each update that this runner posts or sees on D can open the bridge on D, once the other
 * direction's light client (on S) has its first update. For the prover that bridge is the SOURCE bridge of the
 * opposite route, D to S: it reads the head of the light client on D and runs `eth_getProof` on S at the block of that
 * head, which is the newest block of S the light client stored.
 */
export interface DepositOpenerDependencies {
  /** `runner.openDeposits` of the configuration. When false, every check returns `disabled` and reads nothing. */
  readonly enabled: boolean;
  /** The prover route whose source bridge opens (the route from D to S). For the logs. */
  readonly route: string;
  /** The direction of that route, for the prover wrapper. */
  readonly openingDirection: ProofDirection;
  /** The bridge on the destination chain. */
  readonly bridge: Address;
  /** Reads `depositsOpen()` of the bridge. */
  readonly readDepositsOpen: () => Promise<boolean>;
  /** The light client on the destination chain: its head is the newest block of the source chain it stored. */
  readonly lightClient: LightClientReader;
  readonly prover: OpeningProver;
  /** The port of the destination chain, with the runner's signer and fee settings. */
  readonly chain: TransactionPort;
  /** The queue of the runner's transactions on the destination chain, so that no two sends race for a nonce. */
  readonly queue: SerialQueue;
  /** The state file of the runner's direction. It keeps `depositsOpen` once the bridge is open. */
  readonly state: StateStore<RunnerState>;
  readonly now: () => number;
  readonly logger: Logger;
  /**
   * Runs `callback` once after `delayMilliseconds` and returns the function that cancels it. It drives the retries after
   * an RPC failure. Defaults to an unreferenced `setTimeout`, so a pending retry never keeps the process alive.
   */
  readonly schedule?: (callback: () => void, delayMilliseconds: number) => () => void;
  /** A number in [0, 1) for the jitter of the retry delay. Defaults to `Math.random`. */
  readonly random?: () => number;
}

/** What one check did. */
export type OpenerCheck =
  | { readonly kind: "disabled" }
  | { readonly kind: "open" }
  | { readonly kind: "opened"; readonly transactionHash: Hex }
  | { readonly kind: "waiting"; readonly reason: "no-new-head" | "backing-off" }
  | { readonly kind: "failed"; readonly reason: OpenFailure; readonly detail: string; readonly failureClass: FailureClass };

/**
 * What kind of failure it was. `rpc`: the node or the provider could not answer now (proof window, timeout, connection,
 * 429/5xx, "header not found"); the same head is retried on a timer. `logic`: the attempt itself was wrong or reverted;
 * it waits for a newer head and the backoff.
 */
export type FailureClass = "rpc" | "logic";

/** Why an attempt failed. A failure of the `logic` class waits for the next head and the backoff. */
export type OpenFailure = "read-failed" | "proof-failed" | "wrong-target" | "simulation-reverted" | "send-failed" | "transaction-reverted";

/** The opener of one bridge. */
export interface DepositOpener {
  /**
   * Opens the bridge if it is closed and the light client stored a head that no attempt used yet. Call it at start and
   * after each light client update. A failure is logged and returned. After a logic failure the next try waits for a newer
   * head and the backoff. After an RPC failure the opener retries the same head on its own timer, with a growing delay,
   * until it succeeds or a newer head arrives (a `check` then uses that head at once). It throws only when the state file
   * cannot be read or written; the timer logs that instead.
   */
  check(): Promise<OpenerCheck>;
  /** Cancels a pending retry. Call it when the runner stops. */
  stop(): void;
}

/** The wait after the first logic failure. It doubles with each further failure. */
export const OPEN_RETRY_BASE_MILLISECONDS = 60_000;
/** The longest wait between two attempts after logic failures. */
export const OPEN_RETRY_MAXIMUM_MILLISECONDS = 30 * 60_000;
/** The wait before the first retry of the same head after an RPC failure. It doubles with each further failure. */
export const RPC_RETRY_BASE_MILLISECONDS = 30_000;
/** The longest wait between two RPC retries, before the jitter. */
export const RPC_RETRY_MAXIMUM_MILLISECONDS = 10 * 60_000;
/** The jitter takes up to this share off a retry delay, so the delay never exceeds the cap. */
export const RPC_RETRY_JITTER = 0.25;

/**
 * Error text of an RPC that cannot answer now: the proof window of the provider (`eth_getProof` too far back), timeouts,
 * connection errors, HTTP 429 and 5xx, a header the node does not have, rate limits. It matches the stderr of the prover
 * and the messages of viem's transport errors.
 */
const RPC_ERROR_TEXT =
  /proof window|distance to target block|header not found|missing trie node|timed? ?out|etimedout|econn(?:reset|refused|aborted)|enotfound|eai_again|epipe|socket|network|connection|fetch failed|dns|rate.?limit|too many requests|limit exceeded|\b4444\b|-32005|http request failed|\bstatus:? ?(?:429|5\d\d)\b|\b(?:429|50[0-4])\b|bad gateway|service unavailable|gateway time-?out/i;

/** Whether an error message is one of an RPC that cannot answer now. */
export function isRpcErrorText(text: string): boolean {
  return RPC_ERROR_TEXT.test(text);
}

class AttemptFailure extends Error {
  constructor(
    readonly reason: OpenFailure,
    readonly detail: string,
    readonly failureClass: FailureClass = "logic",
  ) {
    super(`${reason}: ${detail}`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs `job`, and turns what it throws into a failure of the given reason. `classify`: "rpc" makes every error of the job
 * an RPC failure (a plain read), "logic" makes every one a logic failure, "text" lets the error text decide.
 */
async function failingAs<Result>(reason: OpenFailure, job: () => Promise<Result>, classify: "rpc" | "text" | "logic"): Promise<Result> {
  try {
    return await job();
  } catch (error) {
    const detail = messageOf(error);
    const failureClass: FailureClass = classify === "rpc" || (classify === "text" && isRpcErrorText(detail)) ? "rpc" : "logic";
    throw new AttemptFailure(reason, detail, failureClass);
  }
}

/** The default scheduler. The timer is unreferenced: a pending retry does not keep the process alive. */
function timeoutScheduler(callback: () => void, delayMilliseconds: number): () => void {
  const timer = setTimeout(callback, delayMilliseconds);
  timer.unref();
  return () => clearTimeout(timer);
}

/**
 * Builds the opener. A bridge opens for good, so once it reports open the opener writes the flag to the state file and
 * never reads the chain again, also after a restart. Each attempt uses a head that no attempt used before: the proof
 * needs the state of the block that head stored, and a node serves that state only for a while after the block, so an
 * old head fails again. After a logic failure the next attempt also waits a backoff, which doubles up to 30 minutes.
 * After an RPC failure (the provider's proof window is too short, a timeout, a 429) the head is not at fault: the opener
 * retries the same head on a timer of 30 seconds that doubles up to 10 minutes, with jitter, until it works or a newer
 * head arrives. Each retry reads `depositsOpen` and simulates before it sends, so the bridge opens once.
 */
export function createDepositOpener(dependencies: DepositOpenerDependencies): DepositOpener {
  const { logger, bridge, route } = dependencies;
  let knownOpen = false;
  let lastAttemptHead: bigint | null = null;
  let failures = 0;
  let rpcFailures = 0;
  let notBefore = 0;
  /** True from an RPC failure until the next attempt: a timer is pending, and only a newer head cuts it short. */
  let rpcRetryPending = false;
  let cancelRetry: (() => void) | null = null;
  /** Changes whenever a timer is set or cancelled, so a callback that was queued behind a check can tell it is stale. */
  let timerGeneration = 0;
  const checks = createSerialQueue();
  const schedule = dependencies.schedule ?? timeoutScheduler;
  const random = dependencies.random ?? Math.random;

  function cancelTimer(): void {
    timerGeneration += 1;
    rpcRetryPending = false;
    cancelRetry?.();
    cancelRetry = null;
  }

  async function markOpen(): Promise<{ readonly kind: "open" }> {
    knownOpen = true;
    await dependencies.state.update((state) => ({ ...state, depositsOpen: true }));
    return { kind: "open" };
  }

  async function attempt(headSlot: bigint): Promise<OpenerCheck> {
    const open = await failingAs("read-failed", dependencies.readDepositsOpen, "rpc");
    logger.info("deposits_open_checked", { bridge, headSlot, open });
    if (open) return markOpen();

    const opening = await failingAs("proof-failed", () => dependencies.prover.openingProof({ direction: dependencies.openingDirection }), "text");
    if (opening.to.toLowerCase() !== bridge.toLowerCase()) throw new AttemptFailure("wrong-target", `the proof is for ${opening.to}, the bridge is ${bridge}`);
    if (opening.depositsOpen) return markOpen();
    logger.info("deposits_opening", { route, bridge, remoteSlot: opening.proof.remoteSlot, storedSlot: opening.proof.storedSlot, remoteBlockNumber: opening.remoteBlockNumber });

    const request = { to: bridge, data: opening.calldata as Hex };
    const receipt = await dependencies.queue.run(async () => {
      const simulation = await dependencies.chain.simulate(request);
      if (!simulation.ok) throw new AttemptFailure("simulation-reverted", simulation.reason);
      const terms = sendTerms(await dependencies.chain.feeQuote(), simulation.gas);
      return failingAs("send-failed", () => dependencies.chain.send({ ...request, ...terms }), "logic");
    });
    if (!receipt.success) throw new AttemptFailure("transaction-reverted", receipt.hash);
    // `openDeposits` either opened the bridge or returned at once because it was open already: either way it is open.
    logger.info("deposits_opened", { route, bridge, transactionHash: receipt.hash, gasUsed: receipt.gasUsed });
    await markOpen();
    return { kind: "opened", transactionHash: receipt.hash };
  }

  /** The delay of the next RPC retry: 30 s doubling to 10 min, minus up to 25 percent of jitter. */
  function rpcDelay(): number {
    const base = Math.min(RPC_RETRY_BASE_MILLISECONDS * 2 ** (rpcFailures - 1), RPC_RETRY_MAXIMUM_MILLISECONDS);
    return Math.round(base * (1 - RPC_RETRY_JITTER * random()));
  }

  function scheduleRetry(delay: number): void {
    const generation = timerGeneration;
    cancelRetry = schedule(() => {
      checks
        .run(async (): Promise<OpenerCheck> => {
          // A check that ran since (a newer head, an open bridge, a logic failure) cancelled this timer.
          if (generation !== timerGeneration) return { kind: "waiting", reason: "backing-off" };
          cancelRetry = null;
          return checkOnce(true);
        })
        .catch((error: unknown) => logger.error("deposits_open_retry_crashed", { route, bridge, error }));
    }, delay);
  }

  /** `fromTimer`: the retry timer of an RPC failure fired, so the same head is tried again. */
  async function checkOnce(fromTimer: boolean): Promise<OpenerCheck> {
    if (!dependencies.enabled) return { kind: "disabled" };
    if (knownOpen) return { kind: "open" };
    if ((await dependencies.state.load()).depositsOpen) {
      knownOpen = true;
      cancelTimer();
      return { kind: "open" };
    }
    if (!rpcRetryPending && dependencies.now() < notBefore) return { kind: "waiting", reason: "backing-off" };
    let headSlot: bigint | null = null;
    try {
      if (rpcRetryPending && !fromTimer) {
        // The timer owns the retries of the head that failed. Only a newer head cuts it short, and a head that cannot be
        // read now is the timer's business too.
        const newest = await dependencies.lightClient.read().then(
          (read) => read.headSlot,
          () => null,
        );
        if (newest === null || lastAttemptHead === null || newest <= lastAttemptHead) return { kind: "waiting", reason: "backing-off" };
        headSlot = newest;
        rpcFailures = 0;
      } else {
        headSlot = (await failingAs("read-failed", () => dependencies.lightClient.read(), "rpc")).headSlot;
        if (!fromTimer && lastAttemptHead !== null && headSlot <= lastAttemptHead) return { kind: "waiting", reason: "no-new-head" };
      }
      cancelTimer();
      if (lastAttemptHead === null || headSlot > lastAttemptHead) lastAttemptHead = headSlot;
      const result = await attempt(headSlot);
      failures = 0;
      rpcFailures = 0;
      return result;
    } catch (error) {
      // A step that fails throws an `AttemptFailure`. Anything else is a state file that cannot be written: it stops the
      // runner, as it does in a sweep.
      if (!(error instanceof AttemptFailure)) throw error;
      const failure = error;
      cancelTimer();
      if (failure.failureClass === "rpc") {
        failures = 0;
        rpcFailures += 1;
        const wait = rpcDelay();
        notBefore = dependencies.now() + wait;
        rpcRetryPending = true;
        scheduleRetry(wait);
        logger.warn("deposits_open_failed", { route, bridge, headSlot, reason: failure.reason, failureClass: "rpc", detail: failure.detail, failures: rpcFailures, retryAfterSeconds: wait / 1000 });
        logger.info("deposits_open_retry", { route, bridge, headSlot, reason: failure.reason, reasonClass: "rpc", attempt: rpcFailures, retryAfterSeconds: wait / 1000 });
      } else {
        rpcFailures = 0;
        failures += 1;
        const wait = Math.min(OPEN_RETRY_BASE_MILLISECONDS * 2 ** (failures - 1), OPEN_RETRY_MAXIMUM_MILLISECONDS);
        notBefore = dependencies.now() + wait;
        logger.warn("deposits_open_failed", { route, bridge, headSlot, reason: failure.reason, failureClass: "logic", detail: failure.detail, failures, retryAfterSeconds: wait / 1000 });
      }
      return { kind: "failed", reason: failure.reason, detail: failure.detail, failureClass: failure.failureClass };
    }
  }

  return { check: () => checks.run(() => checkOnce(false)), stop: cancelTimer };
}
