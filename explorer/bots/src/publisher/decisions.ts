import type { Hex } from "viem";
import type { PendingProof, PublisherState } from "./state.ts";

/** The stored head of the destination light client. */
export interface StoredHead {
  readonly slot: bigint;
  readonly root: Hex;
}

/** How a proof stands against the stored head. */
export type PendingStatus =
  /** There is no proof. */
  | "none"
  /** The proof starts at the stored head: the light client accepts it. */
  | "useful"
  /** The stored head is at or past the end of the proof. */
  | "covered"
  /** The stored head moved to a slot other than the start of the proof, so the contract would refuse it. */
  | "head-moved";

/**
 * Decides whether the proof can still move the light client.
 *
 * @param pending The latest proof, or null.
 * @param head The head that the light client stores now.
 */
export function classifyPending(pending: PendingProof | null, head: StoredHead): PendingStatus {
  if (pending === null) return "none";
  if (head.slot >= BigInt(pending.newSlot)) return "covered";
  const startsAtHead = head.slot === BigInt(pending.startSlot) && head.root.toLowerCase() === pending.startRoot.toLowerCase();
  return startsAtHead ? "useful" : "head-moved";
}

/** Input of {@link shouldRepublish}. */
export interface RepublishInput {
  readonly pending: PendingProof;
  readonly nowMilliseconds: number;
  readonly republishSeconds: number;
}

/**
 * A message lasts about 120 blocks on the board. The publisher posts the proof again when it never posted it, or when
 * the last post is `republishSeconds` old.
 */
export function shouldRepublish(input: RepublishInput): boolean {
  const { pending } = input;
  if (pending.lastPostedAtMilliseconds === null) return true;
  return input.nowMilliseconds - pending.lastPostedAtMilliseconds >= input.republishSeconds * 1000;
}

/** The proving policy from the setup file. */
export interface ProvingPolicy {
  readonly proveWhenTransferWaits: boolean;
  readonly intervalSeconds: number;
}

/** Input of {@link decideProving}. */
export interface ProvingInput {
  readonly nowMilliseconds: number;
  readonly policy: ProvingPolicy;
  readonly state: PublisherState;
  readonly retryBackoffSeconds: number;
  readonly upToDateWaitSeconds: number;
  /** Asks the indexer whether a transfer or message waits for a head. Called only when the answer can matter. */
  readonly transferWaits: () => Promise<boolean>;
}

/** Why the publisher proves, or why it does not. */
export type ProvingDecision =
  | { readonly prove: true; readonly reason: "transfer-waiting" | "interval" }
  | { readonly prove: false; readonly reason: "backoff" | "up-to-date-recently" | "no-demand" };

/**
 * Decides whether to run the prover now. The caller asks only when it holds no useful proof. The order is: a recent failure or
 * a recent "nothing to prove" answer waits; a waiting transfer proves; the interval proves.
 */
export async function decideProving(input: ProvingInput): Promise<ProvingDecision> {
  const attempt = input.state.lastProveAttempt;
  const sinceAttemptSeconds = attempt === null ? Number.POSITIVE_INFINITY : (input.nowMilliseconds - attempt.atMilliseconds) / 1000;
  if (attempt?.outcome === "failed" && sinceAttemptSeconds < input.retryBackoffSeconds) return { prove: false, reason: "backoff" };
  if (attempt?.outcome === "up-to-date" && sinceAttemptSeconds < input.upToDateWaitSeconds) return { prove: false, reason: "up-to-date-recently" };
  if (input.policy.proveWhenTransferWaits && (await input.transferWaits())) return { prove: true, reason: "transfer-waiting" };
  if (input.policy.intervalSeconds === 0) return { prove: false, reason: "no-demand" };
  const last = input.state.lastProofMadeAtMilliseconds;
  const intervalPassed = last === null || input.nowMilliseconds - last >= input.policy.intervalSeconds * 1000;
  return intervalPassed ? { prove: true, reason: "interval" } : { prove: false, reason: "no-demand" };
}
