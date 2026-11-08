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

/**
 * What the destination bridge of a direction says about its deposits, and whether an update of the direction's light
 * client can open them.
 *
 * The mapping (as `explorer/bots/src/runner/opener.ts` does it): the direction S to D proves blocks of S to the light
 * client on D. The bridge on D names that light client as its own and the light client on S as its remote one.
 * `openDeposits` on D proves that the light client on D stored a block of S in whose state the light client on S already
 * held a head. So the bridge on D (the destination of this direction) opens only after an update of this direction's
 * light client, made from a finality of S after the light client on S got a head (the other direction's first update).
 */
export type DepositsFacts = {
  /** `depositsOpen()` of the bridge on the destination chain of the direction, or null when it could not be read. */
  readonly open: boolean | null;
  /** Whether the light client on the source chain (the other direction's) holds a head, or null when unknown. */
  readonly remoteHasHead: boolean | null;
};

/**
 * A situation in which a proof starts before the minimum interval since the direction's last proof
 * (`watch.minIntervalSeconds`) ends. Every other check still applies: a finality newer than the covered head, enough
 * signatures, no pending proof from the head, and the request service's gates and caps.
 *
 * - `deposits-locked`: the bridge on the destination chain reports `depositsOpen() == false` and the light client on
 *   the source chain holds a head, so an update of this direction's light client lets the runner open deposits. It
 *   proves at the first finality that is new, and again at most every {@link DEPOSITS_LOCKED_RETRY_SECONDS} while the
 *   bridge stays locked (an opening that failed waits for a newer head).
 * - `requested`: a user asked through `POST /requests`. That path never comes through {@link decideProof}: the request
 *   service starts the job itself (the indexer must show a need) and applies no batch rule, so the interval never holds
 *   it back. It is listed here so that every reason to prove before the interval is in one place, and the service logs it.
 *
 * Owner, 2026-11-07: "3600 is fine for a minimum, but we should have code in place that can say, oh, yes, we should
 * create a proof for this situation - especially when we are waiting for deposits to be enabled".
 */
export type UrgentReason = "deposits-locked" | "requested";

/** The urgent reasons the watcher's decision can return (a request never comes through it). */
export type WatchUrgentReason = Exclude<UrgentReason, "requested">;

/** While the destination bridge stays locked, a further `deposits-locked` proof waits this long after the last proof. */
export const DEPOSITS_LOCKED_RETRY_SECONDS = 600;

/** Input of {@link urgentReasons}. Times in seconds since 1970. */
export type UrgentInput = {
  readonly nowSeconds: number;
  /** The destination bridge's deposits. Absent: not known, and no deposit rule applies. */
  readonly deposits?: DepositsFacts;
  /** When the direction's last proof job started, or null for none. */
  readonly lastProofAt?: number | null;
  /** Whether a user asked for the proof (`POST /requests`). */
  readonly requested?: boolean;
};

/** One rule: when it applies. Add a situation by adding a rule. */
const URGENT_RULES: ReadonlyArray<{ readonly reason: UrgentReason; readonly applies: (input: UrgentInput) => boolean }> = [
  {
    reason: "deposits-locked",
    applies: ({ deposits, lastProofAt, nowSeconds }) =>
      deposits?.open === false && deposits.remoteHasHead === true && (lastProofAt === undefined || lastProofAt === null || nowSeconds - lastProofAt >= DEPOSITS_LOCKED_RETRY_SECONDS),
  },
  { reason: "requested", applies: ({ requested }) => requested === true },
];

/** The urgent reasons that apply now, in the order of the rules. Empty: the minimum interval holds. */
export function urgentReasons(input: UrgentInput): UrgentReason[] {
  return URGENT_RULES.filter((rule) => rule.applies(input)).map((rule) => rule.reason);
}

/** Why a proof is due, or why not. `stalePending`: a pending proof waited past its time and no longer holds the proof back. */
export type ProofDecision =
  | ({ readonly due: true; readonly why: "message"; readonly messageIds: readonly Hex[]; readonly detail: string; readonly stalePending?: PendingProof } & Partial<BatchFacts>)
  /**
   * `handoff`: the proof can move the light client into a newer sync committee period (the source finalized past the
   * head's period, or handoff steps are needed). Only then may the watcher take the proof past the indexer's age rule.
   * `riders`: waiting messages the batch rule held back, which the proof covers too.
   */
  | { readonly due: true; readonly why: "keep-alive"; readonly handoff: boolean; readonly detail: string; readonly riders?: number; readonly stalePending?: PendingProof }
  /**
   * An urgent reason ({@link urgentReasons}) proves before the minimum interval ends. `messageIds`: the final waiting
   * messages, which the proof covers too (`riders` counts them).
   */
  | { readonly due: true; readonly why: WatchUrgentReason; readonly messageIds: readonly Hex[]; readonly detail: string; readonly riders?: number; readonly stalePending?: PendingProof }
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
  /**
   * The facts of the urgent reasons the watcher reads: the destination bridge's deposits, and when the direction's last
   * proof job started (seconds since 1970, null for none). Absent: none applies.
   */
  readonly urgent?: { readonly deposits: DepositsFacts; readonly lastProofAt: number | null };
};

/** What an urgent proof achieves, for the log. */
function urgentDetail(reason: WatchUrgentReason, lastProofAt: number | null, nowSeconds: number): string {
  const last = lastProofAt === null ? "the direction has no proof yet" : `the last proof started ${Math.round(nowSeconds - lastProofAt)} s ago`;
  return `${reason}: the bridge on the destination chain reports deposits closed and the light client on the source chain holds a head; an update of this light client lets the runner open them (${last}; the minimum interval does not hold it back)`;
}

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
 * be due, however long ago the last proof was, or an urgent reason ({@link urgentReasons}: the destination bridge waits
 * for deposits to open). An urgent reason proves before the interval ends too, after a keep-alive that is due.
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
  // The watcher reads no request, so only a watch reason can apply here.
  const urgentInput = input.urgent;
  const urgent = urgentInput === undefined ? [] : (urgentReasons({ nowSeconds, deposits: urgentInput.deposits, lastProofAt: urgentInput.lastProofAt }) as WatchUrgentReason[]);
  const urgentDecision = (reason: WatchUrgentReason): ProofDecision => {
    const ride = ready.length === 0 ? "" : `; ${ready.length} waiting ${ready.length === 1 ? "message rides" : "messages ride"} along`;
    return { due: true, why: reason, messageIds: ready.map((message) => message.messageId), detail: `${urgentDetail(reason, (urgentInput as NonNullable<typeof urgentInput>).lastProofAt, nowSeconds)}${ride}`, ...(ready.length === 0 ? {} : { riders: ready.length }), ...stale };
  };
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
    // Then a situation that needs a proof now: the messages ride along.
    if (urgent.length > 0) return urgentDecision(urgent[0] as WatchUrgentReason);
    return { due: false, why: "min-interval", detail: waitingDetail(plan, batch.rule), plan };
  }
  if (call !== null) return { due: true, why: "keep-alive", handoff: call === "handoff", detail: assessment.reason, ...stale };
  if (urgent.length > 0) return urgentDecision(urgent[0] as WatchUrgentReason);
  if (!keepAliveDue(assessment)) return { due: false, why: "nothing-due", detail: assessment.reason };
  return { due: false, why: "nothing-due", detail: noProgressDetail(assessment, facts, policy, nowSeconds) };
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

/**
 * The finalized slot the source is expected to have at a time (seconds since 1970): the checkpoint that finalized at
 * the start of the latest epoch E, which is the first slot of epoch E - 2. Consistent with {@link expectedFinalityAt}:
 * a block of slot `s` is covered from the time it returns.
 */
export function finalizedSlotAt(seconds: number, facts: Pick<LightClientFacts, "genesisTime" | "secondsPerSlot">): number {
  const epoch = Math.floor(((seconds - facts.genesisTime) / facts.secondsPerSlot - 1) / SLOTS_PER_EPOCH);
  return Math.max(0, (epoch - 2) * SLOTS_PER_EPOCH);
}

/** What the warm-up looks at: the time a proof is expected (at most one target), and the keys that still wait for one. */
export type WarmupPlan = { readonly targets: readonly WarmupTarget[]; readonly live: ReadonlySet<string> };

/** The key of a period handoff from the head `headSlot`: a new head is another handoff. */
export const handoffKey = (headSlot: number) => `handoff:${headSlot}`;

/** Input of {@link warmupPlan}. */
export type WarmupPlanInput = Omit<DecisionInput, "participants" | "minParticipants" | "urgent"> & {
  /** How far ahead a handoff finality is looked for (the lead time). */
  readonly horizonSeconds: number;
  /** The participation of the newest finality, null when unknown (nothing is due now then); absent assumes the threshold. Later finalities assume the threshold. */
  readonly participants?: number | null;
  readonly minParticipants?: number;
  /**
   * When the request service admits a new job of the direction (seconds since 1970): after a failed job, the spacing
   * between jobs, or a spent daily budget. Absent: now.
   */
  readonly admitAtSeconds?: number;
  /** The newest finalized slot a job started or joined for: a proof for it or an older one is never started again. */
  readonly doneSlot?: number;
  /** The sync-committee period in which the watcher last started a keep-alive: another one waits for an old head. */
  readonly keepAlivePeriod?: number | null;
};

/**
 * When a proof is next due, and whether it is certain: the single forecast of the warm-up, built on {@link decideProof}
 * so the warm-up and the real proof cannot disagree. It collects the moments at which something could change the
 * answer (now, the expected finality of each waiting message, the end of the batch interval and the moment the batch
 * is expected to pay, the finality that crosses into a new committee period, and when the request service admits a
 * job), asks `decideProof` at each of them with the finalized slot expected then, and takes the first at which it says
 * due. A moment before the service admits a job, or at a finalized slot a job started for already, is not due.
 * A keep-alive of the age rule asks for no warm worker.
 *
 * `live` holds every message the head (or a pending proof that still applies) does not cover, final or not, and the
 * handoff while one is due now or ahead: a warm-up for a key that left it is over.
 */
export function warmupPlan(input: WarmupPlanInput): WarmupPlan {
  const { facts, finalizedSlot, policy, nowSeconds, history } = input;
  const minParticipants = input.minParticipants ?? MIN_PARTICIPANTS;
  const covered = coveredSlot(facts, input.pendingProof);
  const waiting = input.messages.filter((message) => message.slot > covered);
  const live = new Set<string>(waiting.map((message) => message.messageId));
  const candidates = new Set<number>();
  const handoffAt = new Set<number>();
  if (waiting.length > 0) {
    candidates.add(nowSeconds);
    for (const message of waiting) candidates.add(expectedFinalityAt(message.slot, facts));
    const batch = input.batch;
    if (batch !== undefined && batch.rule.minIntervalSeconds > 0) {
      const plan = planBatch({ messages: waiting.map((message) => ({ ...message, finalAt: expectedFinalityAt(message.slot, facts) })), finalizedSlot, nowSeconds, rule: batch.rule, economics: batch.economics, lastProofAt: batch.lastProofAt });
      if (plan !== null && !plan.due) {
        candidates.add(plan.startAt);
        candidates.add(plan.dueAt);
      }
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
    // Due now: the proof starts with the finality that made it due, a warm-up would only race it.
    if (dueNow === "handoff") live.add(key);
    // The source has served the handoffs so far; a period it has not been asked for yet is not counted as missing.
    const firstEpoch = Math.floor(currentSlotAt(facts, nowSeconds) / SLOTS_PER_EPOCH) + 1;
    for (let epoch = firstEpoch; dueNow === null; epoch += 1) {
      const finalityAt = slotTime(epoch * SLOTS_PER_EPOCH + 1, facts);
      // The next finality is always looked at; later ones while they lie within the horizon.
      if (epoch > firstEpoch && finalityAt > nowSeconds + input.horizonSeconds) break;
      // At the start of epoch E the checkpoint of epoch E - 2 finalizes.
      if (callAt(Math.max(finalizedSlot, (epoch - 2) * SLOTS_PER_EPOCH), history.kind === "not-needed" ? { kind: "serves" } : history, finalityAt) === "handoff") {
        live.add(key);
        candidates.add(finalityAt);
        handoffAt.add(finalityAt);
        break;
      }
    }
  }
  const admitAt = Math.max(nowSeconds, input.admitAtSeconds ?? nowSeconds);
  const moments = [...new Set([...candidates].map((moment) => Math.max(moment, admitAt)))].sort((left, right) => left - right);
  for (const moment of moments) {
    // The finalized slot the clock says the source has by then. A finality the clock has passed but the watcher has not
    // seen yet counts too (a late finality is awaited, not given up): it is the observed one only while nothing newer is due.
    const finalized = Math.max(finalizedSlot, finalizedSlotAt(moment, facts));
    const observed = finalized === finalizedSlot;
    if (finalized <= (input.doneSlot ?? -1)) continue;
    const decision = decideProof({
      finalizedSlot: finalized,
      participants: observed ? (input.participants === undefined ? minParticipants : input.participants) : minParticipants,
      minParticipants,
      facts,
      messages: input.messages,
      pendingProof: input.pendingProof,
      history: !observed && history.kind === "not-needed" ? { kind: "serves" } : history,
      policy,
      nowSeconds: moment,
      ...(input.pendingStaleSeconds === undefined ? {} : { pendingStaleSeconds: input.pendingStaleSeconds }),
      ...(input.batch === undefined ? {} : { batch: input.batch }),
    });
    if (!decision.due) continue;
    if (decision.why === "keep-alive") {
      // The age rule is the indexer's gate, not the warm-up's. The watcher also holds a second keep-alive of a period back.
      if (!decision.handoff) continue;
      const headAge = moment - (facts.genesisTime + facts.headSlot * facts.secondsPerSlot);
      if (input.keepAlivePeriod === Math.floor(finalized / facts.slotsPerPeriod) && headAge <= policy.keepAliveSeconds) continue;
    }
    const handoff = handoffAt.has(moment) ? [handoffKey(facts.headSlot)] : [];
    const keys = decision.why === "message" ? [...decision.messageIds, ...handoff] : [handoffKey(facts.headSlot)];
    // The warm-up asks decideProof without the urgent facts: an urgent proof starts cold (about a minute more).
    return { targets: [{ at: moment, why: decision.why === "message" ? "message" : "keep-alive", keys }], live };
  }
  return { targets: [], live };
}
