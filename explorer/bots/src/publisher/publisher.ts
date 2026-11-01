import type { Hex } from "viem";
import { ORACLE_PROOF_MESSAGE_VERSION, PROOF_MESSAGE_VERSION, encodeProofMessage, type ProofDirection } from "@zk-bridge/shared";
import type { Logger } from "../logging/logger.ts";
import type { BoardPublisher } from "@zk-bridge/shared/msgboard";
import type { StateFile } from "../runtime/state-file.ts";
import type { LightClientReader, ProofPackage } from "@zk-bridge/shared/prover";
import { classifyPending, decideProving, shouldRepublish, type ProvingPolicy } from "./decisions.ts";
import type { ProofSource } from "./proof-source.ts";
import type { PendingProof, PublisherState } from "./state.ts";

/** Everything one publisher step needs. A step is one look at the chain and at most one proof and one post. */
export interface PublisherDependencies {
  readonly pairName: string;
  readonly direction: ProofDirection;
  /** The msgboard category of the pair and direction. */
  readonly category: Hex;
  readonly lightClient: LightClientReader;
  readonly proofSource: ProofSource;
  readonly board: BoardPublisher;
  /** Asks the indexer whether a transfer or message waits for a head. Null when no indexer is configured. */
  readonly transferWaits: (() => Promise<boolean>) | null;
  readonly state: StateFile<PublisherState>;
  readonly policy: ProvingPolicy;
  readonly republishSeconds: number;
  readonly retryBackoffSeconds: number;
  readonly upToDateWaitSeconds: number;
  readonly now: () => number;
  readonly logger: Logger;
  /** Post proofs in the oracle form (version 2). Only the oracle backend sets it, for local testing. Default: strict. */
  readonly acceptOracleProof?: boolean;
}

/** What a step did. Tests and the log read it. */
export type PublisherStepResult =
  | { readonly action: "chain-unreadable" }
  | { readonly action: "idle"; readonly reason: string }
  | { readonly action: "dropped-proof"; readonly reason: "covered" | "head-moved" }
  | { readonly action: "republished"; readonly postCount: number }
  | { readonly action: "published"; readonly postCount: number; readonly newSlot: bigint }
  | { readonly action: "nothing-to-prove" }
  | { readonly action: "stale-proof" }
  | { readonly action: "prove-failed" }
  | { readonly action: "post-failed" };

function pendingFromPackage(proofPackage: ProofPackage, payload: Hex, nowMilliseconds: number): PendingProof {
  return {
    payload,
    startSlot: String(proofPackage.startHeadSlot),
    startRoot: proofPackage.startHeadRoot,
    newSlot: String(proofPackage.newHeadSlot),
    madeAtMilliseconds: nowMilliseconds,
    lastPostedAtMilliseconds: null,
    postCount: 0,
    messageHash: null,
  };
}

/** A publisher state that holds a proof. */
type StateWithProof = PublisherState & { readonly pending: PendingProof };

async function postPending(dependencies: PublisherDependencies, state: StateWithProof): Promise<StateWithProof | null> {
  const pending = state.pending;
  try {
    const posted = await dependencies.board.post({ category: dependencies.category, payload: pending.payload as Hex });
    const next: StateWithProof = {
      ...state,
      pending: { ...pending, lastPostedAtMilliseconds: dependencies.now(), postCount: pending.postCount + 1, messageHash: posted.messageHash },
    };
    await dependencies.state.save(next);
    dependencies.logger.info("proof_posted", {
      messageHash: posted.messageHash,
      startSlot: pending.startSlot,
      newSlot: pending.newSlot,
      postCount: pending.postCount + 1,
      grindMilliseconds: posted.grindMilliseconds,
      difficulty: posted.difficulty,
      threads: posted.threads,
    });
    return next;
  } catch (error) {
    dependencies.logger.error("proof_post_failed", { error, startSlot: pending.startSlot, newSlot: pending.newSlot });
    return null;
  }
}

/**
 * Runs one step of the publisher for one direction.
 *
 * 1. Read the stored head of the destination light client.
 * 2. Drop the latest proof when the head is at or past it (covered) or no longer at its start (head moved).
 * 3. When the proof is still useful, post it again if the last post is old.
 * 4. Otherwise decide by policy whether to prove. A proof is saved before it is posted, so a crash loses nothing.
 *
 * The step is idempotent: it repeats no work that the saved state shows done, and a restart continues from the state.
 */
export async function runPublisherStep(dependencies: PublisherDependencies): Promise<PublisherStepResult> {
  const { logger } = dependencies;
  let head;
  try {
    head = await dependencies.lightClient.read();
  } catch (error) {
    logger.error("light_client_unreadable", { error });
    return { action: "chain-unreadable" };
  }
  let state = await dependencies.state.load();
  const status = classifyPending(state.pending, { slot: head.headSlot, root: head.headRoot });
  if (status === "covered" || status === "head-moved") {
    logger.info("proof_dropped", { reason: status, headSlot: head.headSlot, newSlot: state.pending?.newSlot });
    state = { ...state, pending: null };
    await dependencies.state.save(state);
    return afterDrop(dependencies, state, status, head.headSlot, head.headRoot, head.programKey);
  }
  if (status === "useful") {
    const pending = state.pending as PendingProof;
    if (!shouldRepublish({ pending, nowMilliseconds: dependencies.now(), republishSeconds: dependencies.republishSeconds })) {
      return { action: "idle", reason: "proof-posted-recently" };
    }
    const next = await postPending(dependencies, { ...state, pending });
    if (next === null) return { action: "post-failed" };
    const postCount = next.pending.postCount;
    return pending.postCount === 0
      ? { action: "published", postCount, newSlot: BigInt(pending.newSlot) }
      : { action: "republished", postCount };
  }
  return proveIfWanted(dependencies, state, head.headSlot, head.headRoot, head.programKey);
}

async function afterDrop(
  dependencies: PublisherDependencies,
  state: PublisherState,
  reason: "covered" | "head-moved",
  headSlot: bigint,
  headRoot: Hex,
  programKey: Hex,
): Promise<PublisherStepResult> {
  const result = await proveIfWanted(dependencies, state, headSlot, headRoot, programKey);
  return result.action === "idle" ? { action: "dropped-proof", reason } : result;
}

async function proveIfWanted(
  dependencies: PublisherDependencies,
  state: PublisherState,
  headSlot: bigint,
  headRoot: Hex,
  programKey: Hex,
): Promise<PublisherStepResult> {
  const { logger } = dependencies;
  const decision = await decideProving({
    nowMilliseconds: dependencies.now(),
    policy: dependencies.policy,
    state,
    retryBackoffSeconds: dependencies.retryBackoffSeconds,
    upToDateWaitSeconds: dependencies.upToDateWaitSeconds,
    transferWaits: dependencies.transferWaits ?? (async () => false),
  });
  if (!decision.prove) return { action: "idle", reason: decision.reason };
  logger.info("proving_started", { reason: decision.reason, headSlot });
  const attempt = (outcome: "proof" | "up-to-date" | "failed") => ({ atMilliseconds: dependencies.now(), outcome });
  let outcome;
  try {
    outcome = await dependencies.proofSource.produce({ direction: dependencies.direction });
  } catch (error) {
    logger.error("proving_failed", { error });
    await dependencies.state.save({ ...state, lastProveAttempt: attempt("failed") });
    return { action: "prove-failed" };
  }
  if (outcome.kind === "up-to-date") {
    logger.info("nothing_to_prove", { headSlot });
    await dependencies.state.save({ ...state, lastProveAttempt: attempt("up-to-date") });
    return { action: "nothing-to-prove" };
  }
  const proofPackage = outcome.proofPackage;
  const usable = await usableAgainstHead(dependencies, proofPackage, { headSlot, headRoot, programKey });
  if (!usable.ok) {
    logger.warn("proof_discarded", { reason: usable.reason, startSlot: proofPackage.startHeadSlot, headSlot });
    await dependencies.state.save({ ...state, lastProveAttempt: attempt("failed") });
    return { action: "stale-proof" };
  }
  const nowMilliseconds = dependencies.now();
  const withProof: StateWithProof = {
    ...state,
    pending: pendingFromPackage(proofPackage, usable.payload, nowMilliseconds),
    lastProveAttempt: attempt("proof"),
    lastProofMadeAtMilliseconds: nowMilliseconds,
  };
  // The proof is saved before the post: it costs minutes of graphics processor time, and a crash must not lose it.
  await dependencies.state.save(withProof);
  logger.info("proof_made", { startSlot: proofPackage.startHeadSlot, newSlot: proofPackage.newHeadSlot, latestFinalizedSlot: proofPackage.latestFinalizedSlot, backend: proofPackage.backend });
  const next = await postPending(dependencies, withProof);
  if (next === null) return { action: "post-failed" };
  return { action: "published", postCount: 1, newSlot: BigInt(proofPackage.newHeadSlot) };
}

type Usable = { readonly ok: true; readonly payload: Hex } | { readonly ok: false; readonly reason: string };

/** The proof must start where the light client is now, and carry the program key that the light client stores. */
async function usableAgainstHead(
  dependencies: PublisherDependencies,
  proofPackage: ProofPackage,
  head: { readonly headSlot: bigint; readonly headRoot: Hex; readonly programKey: Hex },
): Promise<Usable> {
  if (proofPackage.programKey.toLowerCase() !== head.programKey.toLowerCase()) return { ok: false, reason: "program-key-differs" };
  let current = head;
  if (BigInt(proofPackage.startHeadSlot) !== head.headSlot) {
    // The head may have moved while the proof was made. Read again before the proof is called stale.
    const fresh = await dependencies.lightClient.read();
    current = { headSlot: fresh.headSlot, headRoot: fresh.headRoot, programKey: fresh.programKey };
  }
  if (BigInt(proofPackage.startHeadSlot) !== current.headSlot || proofPackage.startHeadRoot.toLowerCase() !== current.headRoot.toLowerCase()) {
    return { ok: false, reason: "start-differs-from-head" };
  }
  try {
    const oracle = dependencies.acceptOracleProof === true;
    const payload = encodeProofMessage({
      version: oracle ? ORACLE_PROOF_MESSAGE_VERSION : PROOF_MESSAGE_VERSION,
      pair: dependencies.pairName,
      direction: dependencies.direction,
      programKey: proofPackage.programKey as Hex,
      startSlot: BigInt(proofPackage.startHeadSlot),
      startRoot: proofPackage.startHeadRoot as Hex,
      newSlot: BigInt(proofPackage.newHeadSlot),
      newRoot: proofPackage.newHeadRoot as Hex,
      publicValues: proofPackage.publicValues as Hex,
      proof: proofPackage.proof as Hex,
    }, { acceptOracleProof: oracle });
    return { ok: true, payload };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}
