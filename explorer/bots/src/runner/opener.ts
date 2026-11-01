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
}

/** What one check did. */
export type OpenerCheck =
  | { readonly kind: "disabled" }
  | { readonly kind: "open" }
  | { readonly kind: "opened"; readonly transactionHash: Hex }
  | { readonly kind: "waiting"; readonly reason: "no-new-head" | "backing-off" }
  | { readonly kind: "failed"; readonly reason: OpenFailure; readonly detail: string };

/** Why an attempt failed. Each one waits for the next head and the backoff. */
export type OpenFailure = "read-failed" | "proof-failed" | "wrong-target" | "simulation-reverted" | "send-failed" | "transaction-reverted";

/** The opener of one bridge. */
export interface DepositOpener {
  /**
   * Opens the bridge if it is closed and the light client stored a head that no attempt used yet. Call it at start and
   * after each light client update. A failure is logged and returned, and the next try waits for a newer head and the
   * backoff. It throws only when the state file cannot be read or written.
   */
  check(): Promise<OpenerCheck>;
}

/** The wait after the first failure. It doubles with each further failure. */
export const OPEN_RETRY_BASE_MILLISECONDS = 60_000;
/** The longest wait between two attempts. */
export const OPEN_RETRY_MAXIMUM_MILLISECONDS = 30 * 60_000;

class AttemptFailure extends Error {
  constructor(
    readonly reason: OpenFailure,
    readonly detail: string,
  ) {
    super(`${reason}: ${detail}`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs `job`, and turns what it throws into a failure of the given reason. */
async function failingAs<Result>(reason: OpenFailure, job: () => Promise<Result>): Promise<Result> {
  try {
    return await job();
  } catch (error) {
    throw new AttemptFailure(reason, messageOf(error));
  }
}

/**
 * Builds the opener. A bridge opens for good, so once it reports open the opener writes the flag to the state file and
 * never reads the chain again, also after a restart. Each attempt uses a head that no attempt used before: the proof
 * needs the state of the block that head stored, and a node serves that state only for a while after the block, so an
 * old head fails again. After a failure the next attempt also waits a backoff, which doubles up to 30 minutes.
 */
export function createDepositOpener(dependencies: DepositOpenerDependencies): DepositOpener {
  const { logger, bridge, route } = dependencies;
  let knownOpen = false;
  let lastAttemptHead: bigint | null = null;
  let failures = 0;
  let notBefore = 0;
  const checks = createSerialQueue();

  async function markOpen(): Promise<{ readonly kind: "open" }> {
    knownOpen = true;
    await dependencies.state.update((state) => ({ ...state, depositsOpen: true }));
    return { kind: "open" };
  }

  async function attempt(headSlot: bigint): Promise<OpenerCheck> {
    const open = await failingAs("read-failed", dependencies.readDepositsOpen);
    logger.info("deposits_open_checked", { bridge, headSlot, open });
    if (open) return markOpen();

    const opening = await failingAs("proof-failed", () => dependencies.prover.openingProof({ direction: dependencies.openingDirection }));
    if (opening.to.toLowerCase() !== bridge.toLowerCase()) throw new AttemptFailure("wrong-target", `the proof is for ${opening.to}, the bridge is ${bridge}`);
    if (opening.depositsOpen) return markOpen();
    logger.info("deposits_opening", { route, bridge, remoteSlot: opening.proof.remoteSlot, storedSlot: opening.proof.storedSlot, remoteBlockNumber: opening.remoteBlockNumber });

    const request = { to: bridge, data: opening.calldata as Hex };
    const receipt = await dependencies.queue.run(async () => {
      const simulation = await dependencies.chain.simulate(request);
      if (!simulation.ok) throw new AttemptFailure("simulation-reverted", simulation.reason);
      const terms = sendTerms(await dependencies.chain.feeQuote(), simulation.gas);
      return failingAs("send-failed", () => dependencies.chain.send({ ...request, ...terms }));
    });
    if (!receipt.success) throw new AttemptFailure("transaction-reverted", receipt.hash);
    // `openDeposits` either opened the bridge or returned at once because it was open already: either way it is open.
    logger.info("deposits_opened", { route, bridge, transactionHash: receipt.hash, gasUsed: receipt.gasUsed });
    await markOpen();
    return { kind: "opened", transactionHash: receipt.hash };
  }

  async function checkOnce(): Promise<OpenerCheck> {
    if (!dependencies.enabled) return { kind: "disabled" };
    if (knownOpen) return { kind: "open" };
    if ((await dependencies.state.load()).depositsOpen) {
      knownOpen = true;
      return { kind: "open" };
    }
    if (dependencies.now() < notBefore) return { kind: "waiting", reason: "backing-off" };
    let headSlot: bigint | null = null;
    try {
      headSlot = (await failingAs("read-failed", () => dependencies.lightClient.read())).headSlot;
      if (lastAttemptHead !== null && headSlot <= lastAttemptHead) return { kind: "waiting", reason: "no-new-head" };
      lastAttemptHead = headSlot;
      const result = await attempt(headSlot);
      failures = 0;
      return result;
    } catch (error) {
      // A step that fails throws an `AttemptFailure`. Anything else is a state file that cannot be written: it stops the
      // runner, as it does in a sweep.
      if (!(error instanceof AttemptFailure)) throw error;
      const failure = error;
      failures += 1;
      const wait = Math.min(OPEN_RETRY_BASE_MILLISECONDS * 2 ** (failures - 1), OPEN_RETRY_MAXIMUM_MILLISECONDS);
      notBefore = dependencies.now() + wait;
      logger.warn("deposits_open_failed", { route, bridge, headSlot, reason: failure.reason, detail: failure.detail, failures, retryAfterSeconds: wait / 1000 });
      return { kind: "failed", reason: failure.reason, detail: failure.detail };
    }
  }

  return { check: () => checks.run(checkOnce) };
}
