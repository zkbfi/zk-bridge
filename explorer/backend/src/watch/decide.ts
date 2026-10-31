/**
 * Whether a new finalized header of the source chain makes a proof due, and when to wake the remote prover. Pure: no
 * network, no clock. The keep-alive rules are the planner's (`keepalive/plan.ts`); this file only asks it.
 */
import type { Hex } from "viem";
import { assess, currentSlotAt, type Assessment, type LightClientFacts, type Policy, type SourceHistory } from "../keepalive/plan.ts";

/** Public keys in a sync committee on both chains (`lc_core::chain::SYNC_COMMITTEE_SIZE`). */
export const SYNC_COMMITTEE_SIZE = 512;

/**
 * The fewest signers the light-client program accepts: `participants * 3 >= 512 * 2` (`lc_core::chain::MIN_PARTICIPANTS`).
 * The contract trusts the program's proof, so this is the threshold an update must meet. A test reads lc-core to keep
 * the two equal.
 */
export const MIN_PARTICIPANTS = Math.ceil((SYNC_COMMITTEE_SIZE * 2) / 3);

/** Slots of one epoch on every beacon chain the bridge follows. */
export const SLOTS_PER_EPOCH = 32;

/** A message of the direction that the indexer does not show as covered yet, with the beacon slot of its block. */
export type WaitingMessage = { readonly messageId: Hex; readonly slot: number };

/** A proof the backend made from `startSlot` to `newSlot` that is not on chain yet. */
export type PendingProof = { readonly startSlot: number; readonly newSlot: number };

/** Why a proof is due, or why not. */
export type ProofDecision =
  | { readonly due: true; readonly why: "message"; readonly messageIds: readonly Hex[]; readonly detail: string }
  | { readonly due: true; readonly why: "keep-alive"; readonly detail: string }
  | {
      readonly due: false;
      readonly why: "not-newer" | "insufficient-signatures" | "stranded" | "wait-for-finality" | "proof-pending" | "nothing-due";
      readonly detail: string;
    };

/** Input of {@link decideProof}. */
export type DecisionInput = {
  /** The slot of the new finalized header. */
  readonly finalizedSlot: number;
  /** How many sync committee members signed the update that carries it, or null when unknown. */
  readonly participants: number | null;
  readonly minParticipants: number;
  /** The destination light client. */
  readonly facts: LightClientFacts;
  readonly messages: readonly WaitingMessage[];
  /** The newest proof the backend made for the direction while it waits to land, or null. */
  readonly pendingProof: PendingProof | null;
  /** Whether the source serves the handoff updates the planner needs. `not-needed` when it needs none. */
  readonly history: SourceHistory;
  readonly policy: Policy;
  readonly nowSeconds: number;
};

/** A proof pending on the board still applies only while the light client head is the one it starts from. */
function applicable(pendingProof: PendingProof | null, facts: LightClientFacts): PendingProof | null {
  return pendingProof !== null && pendingProof.startSlot === facts.headSlot ? pendingProof : null;
}

/** The highest slot that the head, or a pending proof that still applies, already covers. */
function coveredSlot(facts: LightClientFacts, pendingProof: PendingProof | null): number {
  return Math.max(facts.headSlot, applicable(pendingProof, facts)?.newSlot ?? 0);
}

/** Whether the planner calls for a proof now: a keep-alive whose finality has crossed, or handoff steps. */
export function keepAliveDue(assessment: Assessment): boolean {
  return (assessment.verdict === "needs-keep-alive" && !assessment.waitForFinality) || assessment.verdict === "needs-stepping";
}

/**
 * Decides whether a proof is due now. Due when the update is signed by enough of the committee (the program's
 * two-thirds rule) and either a waiting message lies between the covered head and the new finalized header, or the
 * keep-alive planner calls for a proof.
 */
export function decideProof(input: DecisionInput): ProofDecision {
  const { finalizedSlot, participants, facts, policy, nowSeconds } = input;
  const covered = coveredSlot(facts, input.pendingProof);
  if (finalizedSlot <= covered) return { due: false, why: "not-newer", detail: `the finalized slot ${finalizedSlot} is not after the covered slot ${covered}` };
  if (participants === null) return { due: false, why: "insufficient-signatures", detail: "the participation is unknown" };
  if (participants < input.minParticipants) {
    return { due: false, why: "insufficient-signatures", detail: `${participants} of ${SYNC_COMMITTEE_SIZE} sync committee members signed; the program needs ${input.minParticipants}` };
  }
  const assessment = assess({ facts, source: { finalizedSlot }, history: input.history, policy, nowSeconds });
  if (assessment.verdict === "stranded") return { due: false, why: "stranded", detail: assessment.reason };
  if (assessment.waitForFinality && assessment.verdict !== "needs-stepping") return { due: false, why: "wait-for-finality", detail: `the source signs in period ${assessment.currentPeriod} and finality is still in period ${assessment.finalizedPeriod}` };
  const ready = input.messages.filter((message) => message.slot > covered && message.slot <= finalizedSlot);
  if (ready.length > 0) {
    return { due: true, why: "message", messageIds: ready.map((message) => message.messageId), detail: `${ready.length} waiting ${ready.length === 1 ? "message is" : "messages are"} final at slot ${finalizedSlot}` };
  }
  if (applicable(input.pendingProof, facts) !== null) return { due: false, why: "proof-pending", detail: `a proof to slot ${covered} waits to land` };
  if (keepAliveDue(assessment)) return { due: true, why: "keep-alive", detail: assessment.reason };
  return { due: false, why: "nothing-due", detail: assessment.reason };
}

/** The beacon slot of an execution block time (a block after the merge carries its slot's start time). */
export function slotAtTime(seconds: number, facts: Pick<LightClientFacts, "genesisTime" | "secondsPerSlot">): number {
  return Math.max(0, Math.floor((seconds - facts.genesisTime) / facts.secondsPerSlot));
}

/** The start of a slot, in seconds since 1970. */
const slotTime = (slot: number, facts: Pick<LightClientFacts, "genesisTime" | "secondsPerSlot">) => facts.genesisTime + slot * facts.secondsPerSlot;

/**
 * When the source chain is expected to finalize a block of `slot`, in seconds since 1970. The checkpoint at the start
 * of the next epoch (e + 1) covers it, and that checkpoint finalizes at the start of epoch e + 3 when the chain runs
 * normally. The signatures over that finality arrive one slot later.
 */
export function expectedFinalityAt(slot: number, facts: Pick<LightClientFacts, "genesisTime" | "secondsPerSlot">): number {
  const epoch = Math.floor(slot / SLOTS_PER_EPOCH);
  return slotTime((epoch + 3) * SLOTS_PER_EPOCH + 1, facts);
}

/** A time at which the remote prover should be warm, and why. */
export type WarmupTarget = { readonly at: number; readonly why: "message" | "keep-alive" };

/**
 * The times at which a proof is expected to start: the expected finality of each message that is not final yet, and
 * the next finality when the keep-alive planner turns due by then (it is not due now). Sorted by time.
 */
export function warmupTargets(input: Omit<DecisionInput, "participants" | "minParticipants">): WarmupTarget[] {
  const { facts, finalizedSlot, policy, nowSeconds, history } = input;
  const covered = coveredSlot(facts, input.pendingProof);
  const targets: WarmupTarget[] = input.messages
    .filter((message) => message.slot > covered && message.slot > finalizedSlot)
    .map((message) => ({ at: expectedFinalityAt(message.slot, facts), why: "message" }));
  if (applicable(input.pendingProof, facts) === null) {
    const nextEpoch = Math.floor(currentSlotAt(facts, nowSeconds) / SLOTS_PER_EPOCH) + 1;
    const nextFinality = slotTime(nextEpoch * SLOTS_PER_EPOCH + 1, facts);
    const projected = Math.max(finalizedSlot, (nextEpoch - 2) * SLOTS_PER_EPOCH);
    const dueNow = keepAliveDue(assess({ facts, source: { finalizedSlot }, history, policy, nowSeconds }));
    const dueNext = keepAliveDue(assess({ facts, source: { finalizedSlot: projected }, history, policy, nowSeconds: nextFinality }));
    if (!dueNow && dueNext) targets.push({ at: nextFinality, why: "keep-alive" });
  }
  return [...new Map(targets.map((target) => [target.at, target])).values()].sort((left, right) => left.at - right.at);
}

/** When to ping the remote prover. Seconds. */
export type WarmupConfig = {
  /** Ping this long before the expected start. Cover the cold start (about 24 s) and a scan interval. */
  readonly leadSeconds: number;
  /** Ping again this often inside a session. Keep it below the idle timeout of the endpoint. */
  readonly intervalSeconds: number;
  /** A session ends this long after its target. */
  readonly graceSeconds: number;
  /** No new session starts within this long of the last one. */
  readonly minGapSeconds: number;
};

/** The defaults: a 24 s cold start, the 60 s idle timeout of the endpoint, one session per five minutes at most. */
export const DEFAULT_WARMUP: WarmupConfig = { leadSeconds: 45, intervalSeconds: 30, graceSeconds: 90, minGapSeconds: 300 };

/** The warm-up state of one direction. Seconds, or null before the first session. */
export type WarmupState = { readonly sessionStartedAt: number | null; readonly sessionEndsAt: number | null; readonly lastPingAt: number | null };

/** The state before the first warm-up. */
export const NO_WARMUP: WarmupState = { sessionStartedAt: null, sessionEndsAt: null, lastPingAt: null };

/**
 * Whether to ping now. A session opens when a target is within the lead time (or past it by less than the grace), and
 * at most once per `minGapSeconds`. Inside a session the ping repeats every `intervalSeconds` until the session ends.
 * No ping goes out while a job runs: the prover's own requests hold the worker.
 */
export function warmupStep(input: {
  readonly nowSeconds: number;
  readonly targets: readonly WarmupTarget[];
  readonly state: WarmupState;
  readonly config: WarmupConfig;
  readonly jobActive: boolean;
}): { readonly ping: false } | { readonly ping: true; readonly newSession: boolean; readonly target: WarmupTarget; readonly state: WarmupState } {
  const { nowSeconds: now, state, config } = input;
  if (input.jobActive) return { ping: false };
  const target = input.targets.find((candidate) => now >= candidate.at - config.leadSeconds && now <= candidate.at + config.graceSeconds);
  if (target === undefined) return { ping: false };
  if (state.sessionEndsAt !== null && now <= state.sessionEndsAt) {
    if (state.lastPingAt !== null && now - state.lastPingAt < config.intervalSeconds) return { ping: false };
    return { ping: true, newSession: false, target, state: { ...state, lastPingAt: now } };
  }
  if (state.sessionStartedAt !== null && now - state.sessionStartedAt < config.minGapSeconds) return { ping: false };
  return { ping: true, newSession: true, target, state: { sessionStartedAt: now, sessionEndsAt: target.at + config.graceSeconds, lastPingAt: now } };
}
