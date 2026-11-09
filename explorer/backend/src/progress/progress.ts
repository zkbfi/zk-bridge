/**
 * Where one transfer is in the proving pipeline, and which service it waits on. Owner, 2026-11-01: "we should also be
 * updating things like indexer.zkb.fi or the frontend to show the progression of each small piece so that we can show
 * users when they are waiting on server a or service b. this may require us to expose a bit more information than we
 * are now such as i have the proof but i do not type of get endpoints".
 *
 * Pure: the route reads the indexer, the database and the watcher, and passes the facts in.
 */
import { clockFromSlot, expectedFinalityAt, slotAtTime, type ProofDirection, type SlotClock } from "@zk-bridge/shared";
import type { Job, PlannedJob } from "../requests/jobs.ts";
import type { HeldProof } from "../requests/held-proofs.ts";
import type { JobTiming } from "../requests/timings.ts";
import type { WatchDecision } from "../watch/decisions.ts";
import type { IndexedHead, IndexedMessage } from "./indexer.ts";

/** The stages of a transfer, in order. */
export const STAGE_KEYS = ["sent", "final", "batched", "proving", "proof-ready", "update-posted", "delivered"] as const;

/** One stage key. */
export type StageKey = (typeof STAGE_KEYS)[number];

/** What a transfer waits on. `none`: nothing; it is delivered (or its delivery ended). */
export type WaitingService =
  | "source-chain-finality"
  | "batch-profit"
  | "batch-max-wait"
  | "proof-dedup-pending"
  | "gpu-worker-start"
  | "gpu-proving"
  | "board-post"
  | "light-client-update"
  | "delivery"
  | "none";

/** One stage. `at`: when it was done (milliseconds since 1970), when known. */
export type Stage = { readonly key: StageKey; readonly status: "done" | "current" | "pending"; readonly at?: number; readonly detail?: string };

/** What the transfer waits on, since when, and when it is expected to end (milliseconds since 1970). */
export type WaitingOn = { readonly service: WaitingService; readonly since: number; readonly eta?: number; readonly detail?: string };

/** Where a proof is: stored by the webhook, posted to the msgboard, or applied on chain. */
export type ProofWhere = "stored" | "board" | "applied";

/** The proof that carries the transfer. Slots are numbers. */
export type ProofFacts = { readonly startSlot: number; readonly newSlot: number; readonly where: ProofWhere };

/** The answer of `GET /progress/:messageId`. */
export type Progress = {
  readonly messageId: string;
  readonly direction: ProofDirection;
  /** The status the chain indexer gives the message. */
  readonly status: string;
  /** The beacon slot of the source block, when the slot clock is known. */
  readonly slot: number | null;
  readonly stages: readonly Stage[];
  readonly waitingOn: WaitingOn;
  readonly proof?: ProofFacts;
  /** The job that proves it, when one does. */
  readonly job?: { readonly jobId: string; readonly status: string };
};

/** The slot clock of a source chain (`@zkb/core`): the start of slot 0 in seconds since 1970, and the slot length. */
export type { SlotClock };

/**
 * Medians from recent proofs, in milliseconds, or null without data. They make the `eta` of a stage. The proving steps
 * are the parts of the dapp's proof step (`provingPartsOf` and `saneProvingParts` in `@zkb/core`): null with too few
 * prover runs or when their sum is past the sanity limit. Covered to delivered is `deliveryRangeOfStat`.
 */
export type Estimates = {
  /** The wait for a worker of a job that met a cold one. */
  readonly workerWaitMs: number | null;
  /** The whole prover run. */
  readonly totalMs: number | null;
  /** From the webhook storing the proof to its board post (the proof of work and the post). */
  readonly webhookToBoardMs: number | null;
  /** From the board post to the light client update on chain. */
  readonly proofToOnChainMs: number | null;
  /** From the light client update to the delivery. */
  readonly coveredToDeliveredMs: number | null;
};

/** No estimates. */
export const NO_ESTIMATES: Estimates = { workerWaitMs: null, totalMs: null, webhookToBoardMs: null, proofToOnChainMs: null, coveredToDeliveredMs: null };

/** The slot clock from the light client head the indexer reports: its slot and the start time of that slot. */
export function clockFromHead(head: IndexedHead | null, secondsPerSlot: number): SlotClock | null {
  if (head === null || head.storedHeadSlot === null || head.storedHeadSlotTimestamp === null || head.storedHeadSlotTimestamp === undefined) return null;
  return clockFromSlot(head.storedHeadSlot, head.storedHeadSlotTimestamp, secondsPerSlot);
}

/** The slots a job proves to: what the prover reported, else what the watcher planned. Null when neither is known. */
export function jobNewSlot(job: PlannedJob): number | null {
  const text = job.newSlot ?? job.plannedNewSlot;
  return text === null ? null : Number(text);
}

/**
 * The first job that carries a message of `slot` sent at `sentAt`: not failed, made after the send, and proving to the
 * slot or past it. A job whose target is not known yet counts while it runs; one that found the chain up to date
 * proved nothing.
 */
export function coveringJob(jobs: readonly PlannedJob[], slot: number | null, sentAt: number): PlannedJob | null {
  for (const job of jobs) {
    if (job.status === "failed" || job.createdAt < sentAt) continue;
    const target = jobNewSlot(job);
    if (target === null) {
      if (job.status === "queued" || job.status === "proving") return job;
      continue;
    }
    if (slot === null || target >= slot) return job;
  }
  return null;
}

/** The step of a running job: the service it waits on, and when it is expected to end. */
export function jobStep(input: { job: Job; workerWarm: boolean; estimates: Estimates; now: number }): WaitingOn {
  const { job, estimates } = input;
  const eta = estimates.totalMs === null ? {} : { eta: job.createdAt + estimates.totalMs };
  if (job.status === "queued") return { service: "gpu-worker-start", since: job.createdAt, ...eta, detail: "the job waits for the prover to start" };
  const elapsed = input.now - job.createdAt;
  const coldWait = estimates.workerWaitMs ?? 0;
  if (!input.workerWarm && elapsed < coldWait) {
    return { service: "gpu-worker-start", since: job.createdAt, ...eta, detail: `estimated from recent jobs: a cold worker took ${Math.round(coldWait / 1000)} s to start; the prover reports its steps when it ends` };
  }
  const why = input.workerWarm ? "a warm-up made a worker ready before the job" : "estimated from recent jobs; the prover reports its steps when it ends";
  return { service: "gpu-proving", since: job.createdAt, ...eta, detail: why };
}

/** Input of {@link buildProgress}. Times in milliseconds since 1970. */
export type ProgressInput = {
  readonly messageId: string;
  readonly direction: ProofDirection;
  readonly message: IndexedMessage & { readonly sent: NonNullable<IndexedMessage["sent"]> };
  /** The destination light client, as the indexer reports it. */
  readonly head: IndexedHead | null;
  readonly clock: SlotClock | null;
  readonly decision: WatchDecision | null;
  /** The jobs of the direction made since the send, oldest first. */
  readonly jobs: readonly PlannedJob[];
  readonly timingOf: (jobId: string) => JobTiming | null;
  /** The proofs of the direction the backend has (`readHeldProofs`). */
  readonly held: readonly HeldProof[];
  /** Whether a warm-up made a worker ready before a job started. */
  readonly workerWarmFor: (job: PlannedJob) => boolean;
  readonly estimates: Estimates;
  readonly now: number;
};

const DELIVERED_STATUSES = new Set(["delivered", "release_failed"]);

const plus = (at: number, milliseconds: number | null) => (milliseconds === null ? {} : { eta: at + milliseconds });

/** The first value that is a number. */
function firstKnown(...values: ReadonlyArray<number | null | undefined>): number | undefined {
  for (const value of values) if (typeof value === "number") return value;
  return undefined;
}

/** Builds the progress of one message. */
export function buildProgress(input: ProgressInput): Progress {
  const { message, head, clock, decision, now } = input;
  const sentAt = message.sent.timestamp * 1000;
  const slot = clock === null ? null : slotAtTime(message.sent.timestamp, clock);
  const finalAt = clock === null ? null : expectedFinalityAt(slot as number, clock) * 1000;
  const status = message.status;
  const delivered = DELIVERED_STATUSES.has(status);
  const headSlot = head?.storedHeadSlot ?? null;
  const covered = delivered || status === "covered" || (slot !== null && headSlot !== null && headSlot >= slot);
  const finalizedSlot = head?.finalizedSlot ?? decision?.finalizedSlot ?? null;
  const job = coveringJob(input.jobs, slot, sentAt);
  const timing = job === null ? null : input.timingOf(job.id);

  // The proof that carries it: the job's, or a proof we hold that reaches the slot and can still land.
  const jobSlots = job !== null && job.startSlot !== null && job.newSlot !== null ? { startSlot: Number(job.startSlot), newSlot: Number(job.newSlot) } : null;
  const heldProof = slot === null ? null : (input.held.filter((proof) => proof.newSlot >= slot && (headSlot === null || proof.startSlot >= headSlot)).sort((left, right) => left.since - right.since)[0] ?? null);
  const proofSlots = jobSlots ?? (heldProof === null ? null : { startSlot: heldProof.startSlot, newSlot: heldProof.newSlot });
  const posted = firstKnown(timing?.boardPostedAt);
  const onBoard = posted !== undefined || job?.status === "published" || job?.status === "on-chain" || heldProof?.where === "board";
  const provedAt = firstKnown(timing?.webhookStoredAt, timing?.provedAt, heldProof?.since, jobSlots === null ? null : job?.updatedAt);
  const final = covered || job !== null || heldProof !== null || (slot !== null && finalizedSlot !== null && slot <= finalizedSlot) || status === "waiting_for_finality";

  const coveredAt = firstKnown(message.covered?.timestamp);
  const atOf: Record<StageKey, number | undefined> = {
    sent: sentAt,
    final: finalAt === null ? undefined : Math.min(finalAt, now),
    batched: job?.createdAt,
    proving: provedAt,
    "proof-ready": posted,
    "update-posted": coveredAt === undefined ? undefined : coveredAt * 1000,
    delivered: message.delivered === null ? undefined : message.delivered.timestamp * 1000,
  };
  const done: Record<StageKey, boolean> = {
    sent: true,
    final,
    batched: covered || job !== null || heldProof !== null,
    proving: covered || onBoard || provedAt !== undefined,
    "proof-ready": covered || onBoard,
    "update-posted": covered,
    delivered,
  };
  const current = STAGE_KEYS.find((key) => !done[key]) ?? null;
  // The time of the newest earlier stage that has one; the send always has one.
  const previousAt = (key: StageKey): number =>
    STAGE_KEYS.slice(0, STAGE_KEYS.indexOf(key))
      .map((earlier) => atOf[earlier])
      .filter((at): at is number => at !== undefined)
      .at(-1) as number;

  let waitingOn: WaitingOn;
  if (current === null) {
    waitingOn = { service: "none", since: atOf.delivered ?? sentAt, detail: status === "delivered" ? "delivered" : `the delivery ended as ${status.replace(/_/g, " ")}` };
  } else {
    const since = previousAt(current);
    waitingOn = waitFor(current, since, { input, finalAt, job });
  }

  const details: Partial<Record<StageKey, string>> = {
    final: slot === null ? undefined : `slot ${slot}${finalizedSlot === null ? "" : `; the source chain finalized slot ${finalizedSlot}`}`,
    batched: job === null ? undefined : `job ${job.id}`,
    "update-posted": headSlot === null ? undefined : `the light client head is at slot ${headSlot}`,
    delivered: status === "release_failed" ? `the delivery ended as ${status.replace(/_/g, " ")}` : undefined,
  };
  const stages: Stage[] = STAGE_KEYS.map((key) => {
    const state = done[key] ? "done" : key === current ? "current" : "pending";
    const at = done[key] ? atOf[key] : undefined;
    const detail = details[key];
    return { key, status: state, ...(at === undefined ? {} : { at }), ...(detail === undefined ? {} : { detail }) };
  });

  const where: ProofWhere = covered ? "applied" : onBoard ? "board" : "stored";
  const proof = proofSlots === null ? {} : { proof: { ...proofSlots, where: headSlot !== null && headSlot >= proofSlots.newSlot ? ("applied" as const) : where } };
  return {
    messageId: input.messageId,
    direction: input.direction,
    status,
    slot,
    stages,
    waitingOn,
    ...proof,
    ...(job === null ? {} : { job: { jobId: job.id, status: job.status } }),
  };
}

type WaitFacts = {
  readonly input: ProgressInput;
  readonly finalAt: number | null;
  readonly job: PlannedJob | null;
};

/** What the current stage waits on. */
function waitFor(stage: StageKey, since: number, facts: WaitFacts): WaitingOn {
  const { input } = facts;
  const { estimates } = input;
  switch (stage) {
    case "final":
      return { service: "source-chain-finality", since, ...(facts.finalAt === null ? {} : { eta: facts.finalAt }), detail: "the source chain finalizes the block of the send about two epochs after it" };
    case "batched":
      return batchWait(input.decision, since);
    case "proving": {
      const job = facts.job as PlannedJob;
      return jobStep({ job, workerWarm: input.workerWarmFor(job), estimates, now: input.now });
    }
    case "proof-ready":
      return { service: "board-post", since, ...plus(since, estimates.webhookToBoardMs), detail: "the backend has the proof and posts it to the msgboard (proof of work first)" };
    case "update-posted":
      return { service: "light-client-update", since, ...plus(since, estimates.proofToOnChainMs), detail: "the proof is on the msgboard; a runner posts it to the destination light client" };
    default:
      return { service: "delivery", since, ...plus(since, estimates.coveredToDeliveredMs), detail: "the light client covers the transfer; a runner delivers it" };
  }
}

/** Why a final message has no job yet, from the watcher's latest decision. */
function batchWait(decision: WatchDecision | null, since: number): WaitingOn {
  if (decision === null) return { service: "source-chain-finality", since, detail: "the watcher has decided nothing since the backend started; it acts on the next finality of the source chain" };
  // `batch-max-wait` keeps its first name on the wire: the batch waits for the minimum interval since the last proof.
  if (decision.why === "min-interval" && decision.batch !== undefined) {
    const batch = decision.batch;
    return batch.startWhy === "profit"
      ? { service: "batch-profit", since, eta: batch.startAt, detail: decision.detail }
      : { service: "batch-max-wait", since, eta: batch.dueAt, detail: decision.detail };
  }
  if (decision.why === "proof-pending") return { service: "proof-dedup-pending", since, detail: decision.detail };
  return { service: "source-chain-finality", since, detail: `the watcher acts on the next finality of the source chain; its last decision: ${decision.detail}` };
}
