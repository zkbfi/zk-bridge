/**
 * Whether a new finalized header of the source chain makes a proof due, and when to wake the remote prover. Pure: no
 * network, no clock. The keep-alive rules are the planner's (`keepalive/plan.ts`); this file only asks it.
 */
import type { Hex } from "viem";
import { assess, currentSlotAt, formatHours, type Assessment, type LightClientFacts, type Policy, type SourceHistory } from "../keepalive/plan.ts";
import type { ProofPlace } from "../requests/held-proofs.ts";
import { planBatch, usdText, type BatchPlan, type BatchRule, type Economics } from "./batch.ts";
import type { WarmupTarget } from "./warmup.ts";

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

/**
 * A proof we have from `startSlot` to `newSlot` that is not on chain yet: where it is (`held-proofs.ts`) and since when
 * (milliseconds since 1970), when known.
 */
export type PendingProof = { readonly startSlot: number; readonly newSlot: number; readonly where?: ProofPlace; readonly since?: number };

/** What a message proof of a batch carries for the log. */
export type BatchFacts = {
  readonly trigger: "profit" | "interval";
  readonly batch: number;
  readonly waitedSeconds: number;
  readonly feesUsd: string | null;
  readonly costUsd: string | null;
};

/** Why a proof is due, or why not. `stalePending`: a pending proof waited past its time and no longer holds the proof back. */
export type ProofDecision =
  | ({ readonly due: true; readonly why: "message"; readonly messageIds: readonly Hex[]; readonly detail: string; readonly stalePending?: PendingProof } & Partial<BatchFacts>)
  /**
   * `handoff`: the proof can move the light client into a newer sync committee period (the source finalized past the
   * head's period, or handoff steps are needed). Only then may the watcher take the proof past the indexer's age rule.
   * `riders`: waiting messages the batch rule held back, which the proof covers too.
   */
  | { readonly due: true; readonly why: "keep-alive"; readonly handoff: boolean; readonly detail: string; readonly riders?: number; readonly stalePending?: PendingProof }
  | {
      readonly due: false;
      readonly why: "not-newer" | "insufficient-signatures" | "stranded" | "wait-for-finality" | "proof-pending" | "nothing-due" | "min-interval";
      readonly detail: string;
      /** For `min-interval`: the batch, for the log and the timer that wakes the watcher when it is due. */
      readonly plan?: Extract<BatchPlan, { due: false }>;
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
  /** A pending proof older than this no longer holds a new proof back (`limits.pendingProofStaleSeconds`). Default: never. */
  readonly pendingStaleSeconds?: number;
  /**
   * The batching of the direction, what the batch is worth, and when the direction's last proof job started (seconds
   * since 1970, null for none). Without it, or with no minimum interval, a message proves at once.
   */
  readonly batch?: { readonly rule: BatchRule; readonly economics: Economics; readonly lastProofAt: number | null };
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
 * What a keep-alive proof can achieve now, or null when it achieves nothing:
 *
 * - `no-head`: the light client holds no head yet.
 * - `handoff`: the planner calls for handoff steps, or the source finalized a header in a period after the head's. The
 *   proof moves the light client into a newer committee period, which pushes its deadline out.
 * - `age`: the head is older than `policy.keepAliveSeconds`, the age rule of the indexer's gate.
 *
 * A young head in the period of the source's finality gets none of these. A proof then moves the head inside the same
 * period and proves no new committee, so the deadline stays where it is: on 2026-10-31 that ran a proof every finality.
 */
export function keepAliveProgress(assessment: Assessment, facts: LightClientFacts, policy: Policy): "no-head" | "handoff" | "age" | null {
  if (facts.headSlot === 0) return "no-head";
  if (assessment.verdict === "needs-stepping" || assessment.handoffPeriods.length > 0 || assessment.finalizedPeriod > assessment.headPeriod) return "handoff";
  if (assessment.headAgeSeconds > policy.keepAliveSeconds) return "age";
  return null;
}

/** The keep-alive the planner calls for that a proof can make progress on, or null. */
export function keepAliveCall(assessment: Assessment, facts: LightClientFacts, policy: Policy): "no-head" | "handoff" | "age" | null {
  return keepAliveDue(assessment) ? keepAliveProgress(assessment, facts, policy) : null;
}

/** Why a keep-alive the planner calls for is not due: the head and the finality share a period. */
function noProgressDetail(assessment: Assessment, facts: LightClientFacts, policy: Policy, nowSeconds: number): string {
  const next = assessment.headPeriod + 1;
  const begins = facts.genesisTime + next * facts.slotsPerPeriod * facts.secondsPerSlot;
  const ageLeft = policy.keepAliveSeconds - assessment.headAgeSeconds;
  return `the head (slot ${facts.headSlot}) and the source's finality are both in period ${assessment.headPeriod}: a proof cannot hand off to a new committee before period ${next} begins at ${new Date(begins * 1000).toISOString()} (in ${formatHours(begins - nowSeconds)}) and the source finalizes in it; the age rule calls for one in ${formatHours(ageLeft)} (${assessment.reason})`;
}

/** The pending proof that applies, and whether it waited past its time. */
function pendingOf(input: Pick<DecisionInput, "pendingProof" | "facts" | "nowSeconds" | "pendingStaleSeconds">): { proof: PendingProof | null; stale: boolean } {
  const proof = applicable(input.pendingProof, input.facts);
  const stale = proof?.since !== undefined && input.pendingStaleSeconds !== undefined && input.nowSeconds * 1000 - proof.since > input.pendingStaleSeconds * 1000;
  return { proof, stale };
}

/** "the proof from slot 1 to slot 2 (board)". */
const describePending = (proof: PendingProof) => `the proof from slot ${proof.startSlot} to slot ${proof.newSlot}${proof.where === undefined ? "" : ` (${proof.where})`}`;

/** The batch facts of a log line. */
function batchFacts(plan: Extract<BatchPlan, { due: true }>): BatchFacts {
  return {
    trigger: plan.trigger,
    batch: plan.messageIds.length,
    waitedSeconds: plan.waitedSeconds,
    feesUsd: plan.feesUsd === null ? null : usdText(plan.feesUsd),
    costUsd: plan.costUsd === null ? null : usdText(plan.costUsd),
  };
}

/** Why a batch waits, for `proof_not_due`. */
function waitingDetail(plan: Extract<BatchPlan, { due: false }>, rule: BatchRule): string {
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
  const worth =
    plan.unknownWhy !== null
      ? `the fees cannot be valued (${plan.unknownWhy})`
      : `fees $${usdText(plan.feesUsd as bigint)} against a cost of $${usdText(plan.costUsd as bigint)}`;
  const when = plan.startWhy === "profit" ? `the batch is expected to pay at ${iso(plan.startAt)}` : `no batch pays within the lookahead`;
  return `${plan.ready} ${plan.ready === 1 ? "message waits" : "messages wait"}, the oldest final since ${iso(plan.oldestFinalAt)}: ${worth}; ${when}; the last proof started at ${iso(plan.lastProofAt as number)}, so the next one is due at ${iso(plan.dueAt)} at the latest (min interval ${rule.minIntervalSeconds} s)`;
}

/**
 * Decides whether a proof is due now. Due when the update is signed by enough of the committee (the program's
 * two-thirds rule) and either a waiting message lies between the covered head and the new finalized header and its
 * batch is due ({@link planBatch}: it pays, or the last proof started `minIntervalSeconds` ago), or the keep-alive
 * planner calls for a proof that can make progress ({@link keepAliveProgress}). A handoff or a keep-alive of the age
 * rule never waits for the interval: the waiting messages ride along. With no waiting message, only a keep-alive can
 * be due, however long ago the last proof was.
 *
 * A proof we have that starts at the head and can still land holds every new proof back, until it waited longer than
 * `pendingStaleSeconds`: it covers what it reaches, and a second proof from the same head would be paid for twice.
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
  // Stepping waits too: the prover and the contract refuse an update signed in a period the finalized header does not
  // reach ("the finalized header does not cross into it"), and finality crosses about two epochs after the border.
  if (assessment.waitForFinality) return { due: false, why: "wait-for-finality", detail: `the source signs in period ${assessment.currentPeriod} and finality is still in period ${assessment.finalizedPeriod}` };
  const ready = input.messages.filter((message) => message.slot > covered && message.slot <= finalizedSlot);
  const pending = pendingOf(input);
  if (pending.proof !== null && !pending.stale) {
    const beyond = ready.length === 0 ? "" : `; ${ready.length} ${ready.length === 1 ? "message after it waits" : "messages after it wait"} for it to land`;
    return { due: false, why: "proof-pending", detail: `${describePending(pending.proof)} waits to land${beyond}` };
  }
  const stale = pending.proof === null ? {} : { stalePending: pending.proof };
  const call = keepAliveCall(assessment, facts, policy);
  if (ready.length > 0) {
    const batch = input.batch;
    if (batch === undefined || batch.rule.minIntervalSeconds === 0) {
      return { due: true, why: "message", messageIds: ready.map((message) => message.messageId), detail: `${ready.length} waiting ${ready.length === 1 ? "message is" : "messages are"} final at slot ${finalizedSlot}`, ...stale };
    }
    // The batch counts every uncovered message, final or not: the ones not final yet tell when it is expected to pay.
    const uncovered = input.messages.filter((message) => message.slot > covered).map((message) => ({ ...message, finalAt: expectedFinalityAt(message.slot, facts) }));
    const plan = planBatch({ messages: uncovered, finalizedSlot, nowSeconds, rule: batch.rule, economics: batch.economics, lastProofAt: batch.lastProofAt }) as BatchPlan;
    if (plan.due) {
      const how =
        plan.trigger === "profit"
          ? "their fees cover the cost"
          : batch.lastProofAt === null
            ? "the direction has no proof yet"
            : `the last proof started ${Math.round(nowSeconds - batch.lastProofAt)} s ago (min interval ${batch.rule.minIntervalSeconds} s)`;
      return { due: true, why: "message", messageIds: plan.messageIds as Hex[], detail: `${ready.length} waiting ${ready.length === 1 ? "message is" : "messages are"} final at slot ${finalizedSlot}: ${how}`, ...batchFacts(plan), ...stale };
    }
    // Liveness first: a handoff or an old head proves now, and the waiting messages ride along.
    if (call !== null) return { due: true, why: "keep-alive", handoff: call === "handoff", detail: `${assessment.reason}; ${ready.length} waiting ${ready.length === 1 ? "message rides" : "messages ride"} along`, riders: ready.length, ...stale };
    return { due: false, why: "min-interval", detail: waitingDetail(plan, batch.rule), plan };
  }
  if (!keepAliveDue(assessment)) return { due: false, why: "nothing-due", detail: assessment.reason };
  if (call === null) return { due: false, why: "nothing-due", detail: noProgressDetail(assessment, facts, policy, nowSeconds) };
  return { due: true, why: "keep-alive", handoff: call === "handoff", detail: assessment.reason, ...stale };
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

/** What the warm-up looks at: the times a proof is expected, and the keys that still wait for one. */
export type WarmupPlan = { readonly targets: readonly WarmupTarget[]; readonly live: ReadonlySet<string> };

/** The key of a period handoff from the head `headSlot`: a new head is another handoff. */
export const handoffKey = (headSlot: number) => `handoff:${headSlot}`;

/**
 * The times at which a proof is expected to start, sorted, one per time: the expected finality of each message that is
 * not final yet (with a minimum interval, one time for the whole batch: when it is expected to pay, else when the
 * interval since the last proof ends, and never before its first finality), and the first finality within
 * `horizonSeconds` (the lead time) that makes a period handoff due, when no
 * keep-alive is due now. A handoff is due once the source's finality crosses into the new period, about two epochs
 * after the border, not when the clock crosses it. A keep-alive of the age rule asks for no warm worker.
 *
 * `live` holds every message the head (or a pending proof that still applies) does not cover, final or not, and the
 * handoff while one is due now or ahead: a warm-up for a key that left it is over.
 */
export function warmupPlan(input: Omit<DecisionInput, "participants" | "minParticipants"> & { readonly horizonSeconds: number }): WarmupPlan {
  const { facts, finalizedSlot, policy, nowSeconds, history } = input;
  const covered = coveredSlot(facts, input.pendingProof);
  const waiting = input.messages.filter((message) => message.slot > covered);
  const live = new Set<string>(waiting.map((message) => message.messageId));
  const byTime = new Map<number, { why: WarmupTarget["why"]; keys: string[] }>();
  const batch = input.batch;
  if (batch !== undefined && batch.rule.minIntervalSeconds > 0) {
    // One session per batch, timed to when its proof is expected to start: when it pays, else when the interval ends.
    const plan = planBatch({ messages: waiting.map((message) => ({ ...message, finalAt: expectedFinalityAt(message.slot, facts) })), finalizedSlot, nowSeconds, rule: batch.rule, economics: batch.economics, lastProofAt: batch.lastProofAt });
    if (plan !== null) byTime.set(plan.due ? nowSeconds : plan.startAt, { why: "message", keys: waiting.map((message) => message.messageId) });
  } else {
    for (const message of waiting.filter((candidate) => candidate.slot > finalizedSlot)) {
      const at = expectedFinalityAt(message.slot, facts);
      const entry = byTime.get(at) ?? { why: "message" as const, keys: [] };
      entry.keys.push(message.messageId);
      byTime.set(at, entry);
    }
  }
  if (applicable(input.pendingProof, facts) === null) {
    const key = handoffKey(facts.headSlot);
    // What a proof could do at a time, as decideProof would see it: nothing while the source signs in a period that
    // finality has not reached (the prover and the contract refuse the handoff until finality crosses the border).
    const callAt = (finalized: number, known: SourceHistory, time: number) => {
      const assessment = assess({ facts, source: { finalizedSlot: finalized }, history: known, policy, nowSeconds: time });
      return assessment.waitForFinality ? null : keepAliveCall(assessment, facts, policy);
    };
    const dueNow = callAt(finalizedSlot, history, nowSeconds);
    if (dueNow === "handoff") live.add(key);
    // The source has served the handoffs so far; a period it has not been asked for yet is not counted as missing.
    const nextHistory: SourceHistory = history.kind === "not-needed" ? { kind: "serves" } : history;
    const firstEpoch = Math.floor(currentSlotAt(facts, nowSeconds) / SLOTS_PER_EPOCH) + 1;
    for (let epoch = firstEpoch; dueNow === null; epoch += 1) {
      const finalityAt = slotTime(epoch * SLOTS_PER_EPOCH + 1, facts);
      // The next finality is always looked at; later ones while they lie within the horizon.
      if (epoch > firstEpoch && finalityAt > nowSeconds + input.horizonSeconds) break;
      // At the start of epoch E the checkpoint of epoch E - 2 finalizes.
      if (callAt(Math.max(finalizedSlot, (epoch - 2) * SLOTS_PER_EPOCH), nextHistory, finalityAt) === "handoff") {
        live.add(key);
        const entry = byTime.get(finalityAt) ?? { why: "keep-alive" as const, keys: [] };
        entry.keys.push(key);
        byTime.set(finalityAt, entry);
        break;
      }
    }
  }
  const targets = [...byTime.entries()].map(([at, entry]) => ({ at, why: entry.why, keys: entry.keys })).sort((left, right) => left.at - right.at);
  return { targets, live };
}
