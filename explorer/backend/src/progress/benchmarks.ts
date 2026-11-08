/**
 * How long each step of the pipeline took over a window: the prover's own timings, the board post, the time from the
 * board to the light client update on chain, and from the send to the delivery. Owner, 2026-11-01: "i look forward to
 * seeing actual timing from bridges and proofs being generated."
 */
import { PROOF_DIRECTIONS, type ProofDirection } from "@zk-bridge/shared";
import type { Job } from "../requests/jobs.ts";
import { statOf, type JobTiming, type Stat } from "../requests/timings.ts";
import type { HeadUpdate, IndexedMessage } from "./indexer.ts";

/** The steps, in the order of a transfer. */
export const BENCHMARK_STEPS = ["workerWait", "remote", "workerQueue", "workerProve", "total", "webhookToBoard", "boardPost", "proofToOnChain", "coveredToDelivered", "sentToDelivered"] as const;

/** One step. */
export type BenchmarkStep = (typeof BENCHMARK_STEPS)[number];

/** The shortest and longest window, in seconds, and the default. */
export const WINDOW_LIMITS = { minimum: 3_600, maximum: 30 * 86_400, fallback: "24h" } as const;

/** Parses `30m`, `24h` or `7d` into seconds, or null when it is not one or lies outside the limits. */
export function parseWindow(text: string): number | null {
  const match = /^(\d{1,5})([mhd])$/.exec(text);
  if (match === null) return null;
  const seconds = Number(match[1]) * { m: 60, h: 3_600, d: 86_400 }[match[2] as "m" | "h" | "d"];
  return seconds >= WINDOW_LIMITS.minimum && seconds <= WINDOW_LIMITS.maximum ? seconds : null;
}

/** One proof of the window, for the table of recent proofs. Times in ms since 1970, durations in ms. */
export type RecentProof = {
  readonly jobId: string;
  readonly direction: ProofDirection;
  readonly startSlot: number | null;
  readonly newSlot: number | null;
  readonly provedAt: number | null;
  readonly waitWorkerMs: number | null;
  readonly coldWorker: boolean | null;
  readonly remoteMs: number | null;
  readonly workerProveMs: number | null;
  readonly totalMs: number | null;
  readonly grindMs: number | null;
  readonly boardPostedAt: number | null;
  readonly onChainAt: number | null;
  readonly endpoint: string | null;
  readonly workerGpu: string | null;
};

/** The answer of `GET /benchmarks`. */
export type Benchmarks = {
  readonly window: string;
  readonly windowSeconds: number;
  readonly from: number;
  readonly to: number;
  readonly steps: Readonly<Record<BenchmarkStep, Stat>>;
  readonly byDirection: Readonly<Record<ProofDirection, Readonly<Record<BenchmarkStep, Stat>>>>;
  /** The newest proofs of the window, newest first, at most {@link RECENT_LIMIT}. */
  readonly recent: readonly RecentProof[];
  /** Whether the chain indexer answered: without it the on-chain and delivery steps are empty. */
  readonly indexer: "ok" | "unavailable";
};

/** How many proofs `recent` lists. */
export const RECENT_LIMIT = 20;

/** Input of {@link buildBenchmarks}. */
export type BenchmarkInput = {
  readonly window: string;
  readonly windowSeconds: number;
  readonly now: number;
  /** The timings of the window, newest first. */
  readonly timings: readonly JobTiming[];
  readonly jobOf: (jobId: string) => Job | null;
  /** Per direction: the head updates of its destination chain, and its delivered messages. Null when the indexer failed. */
  readonly indexer: Readonly<Record<ProofDirection, { readonly headUpdates: readonly HeadUpdate[]; readonly delivered: readonly IndexedMessage[] }>> | null;
};

const difference = (later: number | null | undefined, earlier: number | null | undefined): number | null =>
  later == null || earlier == null || later < earlier ? null : later - earlier;

/**
 * When the light client stored this proof's own head: the earliest update of exactly its new slot, in ms since 1970.
 *
 * A later head that merely covers the slot is not this proof landing. Matching "the first update at or past the slot"
 * put a proof whose own update is missing (deduplicated on the board, or posted to a light client that has since been
 * redeployed and is no longer indexed) on the next head the runner posted, hours or days later: on 2026-11-08 that read
 * proofToOnChain as a 52 h median over 7 d, when each proof lands seconds after its board post.
 */
function onChainAt(updates: readonly HeadUpdate[], newSlot: number | null): number | null {
  if (newSlot === null) return null;
  let first: HeadUpdate | null = null;
  for (const update of updates) if (update.slot === newSlot && (first === null || update.timestamp < first.timestamp)) first = update;
  return first === null ? null : first.timestamp * 1000;
}

/** Builds the benchmarks of a window. */
export function buildBenchmarks(input: BenchmarkInput): Benchmarks {
  const from = input.now - input.windowSeconds * 1000;
  const recent: RecentProof[] = input.timings.map((timing) => {
    const job = input.jobOf(timing.jobId);
    const startSlot = job?.startSlot == null ? null : Number(job.startSlot);
    const newSlot = job?.newSlot == null ? null : Number(job.newSlot);
    return {
      jobId: timing.jobId,
      direction: timing.direction,
      startSlot,
      newSlot,
      provedAt: timing.provedAt,
      waitWorkerMs: timing.waitWorkerMs,
      coldWorker: timing.notReadyCount === null ? null : timing.notReadyCount > 0,
      remoteMs: timing.remoteMs,
      workerProveMs: timing.workerProveMs,
      totalMs: timing.totalMs,
      grindMs: timing.grindMs,
      boardPostedAt: timing.boardPostedAt,
      onChainAt: input.indexer === null ? null : onChainAt(input.indexer[timing.direction].headUpdates, newSlot),
      endpoint: timing.endpoint,
      workerGpu: timing.workerGpu,
    };
  });
  const stepsOf = (direction: ProofDirection | null): Record<BenchmarkStep, Stat> => {
    const timings = input.timings.filter((timing) => direction === null || timing.direction === direction);
    const proofs = recent.filter((proof) => direction === null || proof.direction === direction);
    const delivered =
      input.indexer === null
        ? []
        : (direction === null ? PROOF_DIRECTIONS : [direction]).flatMap((one) => (input.indexer as NonNullable<BenchmarkInput["indexer"]>)[one].delivered.filter((message) => message.delivered !== null && message.delivered.timestamp * 1000 >= from));
    return {
      workerWait: statOf(timings.map((timing) => timing.waitWorkerMs)),
      remote: statOf(timings.map((timing) => timing.remoteMs)),
      workerQueue: statOf(timings.map((timing) => timing.workerQueueMs)),
      workerProve: statOf(timings.map((timing) => timing.workerProveMs)),
      total: statOf(timings.map((timing) => timing.totalMs)),
      webhookToBoard: statOf(timings.map((timing) => difference(timing.boardPostedAt, timing.webhookStoredAt))),
      boardPost: statOf(timings.map((timing) => timing.grindMs)),
      proofToOnChain: statOf(proofs.map((proof) => difference(proof.onChainAt, proof.boardPostedAt))),
      coveredToDelivered: statOf(delivered.map((message) => difference((message.delivered as { timestamp: number }).timestamp * 1000, message.covered?.timestamp == null ? null : message.covered.timestamp * 1000))),
      sentToDelivered: statOf(delivered.map((message) => difference((message.delivered as { timestamp: number }).timestamp * 1000, message.sent === null ? null : message.sent.timestamp * 1000))),
    };
  };
  return {
    window: input.window,
    windowSeconds: input.windowSeconds,
    from,
    to: input.now,
    steps: stepsOf(null),
    byDirection: Object.fromEntries(PROOF_DIRECTIONS.map((direction) => [direction, stepsOf(direction)])) as Record<ProofDirection, Record<BenchmarkStep, Stat>>,
    recent: recent.slice(0, RECENT_LIMIT),
    indexer: input.indexer === null ? "unavailable" : "ok",
  };
}
