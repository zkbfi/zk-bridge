/**
 * The wait-time timeline of a direction: Sent, Final on the source chain, Proved, Delivered, each with a typical
 * (median) and a worst case (90th percentile) in seconds. Pure: no network, no clock.
 *
 * Owner, 2026-11-07: "we should show a timeline somehow of ranges of wait times for different chains so that people can
 * manage their expectations", and "for the proved section, this will probably change the most for mainnet, when there
 * is real money and tiping/delivery".
 *
 * The numbers are `waitEstimate` of `@zkb/core`, the same functions the backend's progress and watcher use; this file
 * adds the words. Where each range comes from:
 *
 * - Sent: one block of the source chain (typical one slot, worst case two).
 * - Final on the source: the indexer's measured send-to-final time over the last 7 days when it has {@link MIN_SAMPLES}
 *   deliveries, else the chain's rule as the backend's watcher reads it (`expectedFinalityAt`: the next epoch's
 *   checkpoint finalizes two epochs later, 66 to 97 slots after the send); the block of the send is taken off it.
 * - Proved: set by the proof rule and the user's fee. A fee that pays for a proof starts it at finality; a fee that
 *   does not waits for a batch, up to the direction's minimum interval. The proving time itself is the backend's
 *   measured total for the last 7 days, else {@link PROVING_DEFAULT}.
 * - Delivered: the indexer's measured covered-to-delivered time over the last 7 days, else {@link DELIVERY_DEFAULT}.
 *
 * A measured range far past what its step can take (see {@link SANE_LIMITS}) is a measuring fault, not a wait: it is
 * left out, the step falls back to the chain's or the rule's figure, and the line under the timeline says so. On
 * 2026-11-08 a backend fault read the proof's time to the chain as 52 h and the timeline showed "~57 h 7 min".
 */
import {
  DELIVERY_DEFAULT,
  MIN_SAMPLES,
  PROVING_DEFAULT,
  SANE_LIMITS,
  feeVerdict,
  provingPartsOf,
  provingRangeOf,
  remainingWait,
  waitDurationText,
  waitEstimate,
  type Basis,
  type BenchmarkSteps,
  type CheckedStep,
  type FeeReading,
  type ProofRule,
  type ProofStart,
  type Range,
  type WaitInputs as SharedWaitInputs,
} from "@zk-bridge/shared";
import type { DirectionTiming, WindowTiming } from "../explore/explore-source";

// The numbers come from `@zkb/core` (wait-estimates), which the backend uses too; this file adds the words.
export { DELIVERY_DEFAULT, MIN_SAMPLES, PROVING_DEFAULT, SANE_LIMITS, feeVerdict };
export type { Basis, BenchmarkSteps, FeeReading, ProofRule, ProofStart, Range };

/** Everything a timeline is made from: the indexer's window, the backend's rule and proving time. */
export type WaitInputs = SharedWaitInputs & { readonly timing: WindowTiming | null };

/** One step of the timeline. */
export type WaitStep = {
  readonly key: "sent" | "final" | "proved" | "delivered";
  readonly label: string;
  /** One line on what happens in this step. */
  readonly note: string;
  readonly range: Range;
  readonly basis: Basis;
};

/** The timeline of a direction. */
export type Timeline = {
  readonly steps: readonly [WaitStep, WaitStep, WaitStep, WaitStep];
  readonly total: Range;
  /** "measured" when the send-to-final and covered-to-delivered ranges are the last 7 days'; else from the chain and the rule. */
  readonly basis: "measured" | "derived";
  /** Deliveries behind the measured ranges (0 when derived). */
  readonly samples: number;
  readonly start: ProofStart;
  /** The wait for a batch in seconds, when the proof may wait for one. */
  readonly batchSeconds: number | null;
  /** The steps whose measured range was past its {@link SANE_LIMITS} and left out. */
  readonly ignored: readonly CheckedStep[];
};

/** Seconds as "45 s", "18 min", "2 h" or "2 h 10 min". */
export const durationText = waitDurationText;

/** "typical 18 min · up to 75 min". */
export const rangeText = (range: Range): string => `typical ${durationText(range.typical)} · up to ${durationText(range.worst)}`;

/** The interval in words: "hourly" for an hour, else "every 90 min". */
const everyText = (seconds: number): string => (seconds === 3600 ? "hourly" : `every ${durationText(seconds)}`);

/** What the proof step says, by how it starts. */
const provedNoteOf = (start: ProofStart, batchSeconds: number | null, fee: FeeReading): string => {
  switch (start) {
    case "measured":
      return "The wait for a proof, as measured";
    case "unknown":
      return "A proof of the finalized block is made and posted";
    case "at-finality":
      return "A proof starts at finality";
    case "testnet":
      return `Testnet: proofs run at least ${everyText(batchSeconds as number)}`;
    default:
      return `Waits for a batch: up to ${durationText(batchSeconds as number)}${fee.kind === "known" ? "; your fee does not pay for a proof alone" : ""}`;
  }
};

/**
 * The timeline of a direction: the ranges of `waitEstimate` (`@zkb/core`) with a label and a note for each step.
 *
 * @param inputs The measured and rule data.
 * @param fee What the user pays, when known.
 */
export const buildTimeline = (inputs: WaitInputs, fee: FeeReading): Timeline => {
  const estimate = waitEstimate(inputs, fee);
  const steps = [
    { key: "sent", label: "Sent", note: "The transaction is in a block", range: estimate.sent, basis: "chain" },
    { key: "final", label: "Final on the source", note: "Set by the chain: final two epochs after the next epoch begins", range: estimate.final, basis: estimate.basis.final },
    { key: "proved", label: "Proved", note: provedNoteOf(estimate.start, estimate.batchSeconds, fee), range: estimate.proved, basis: estimate.basis.proved },
    { key: "delivered", label: "Delivered", note: "A delivery bot or you delivers it once proved", range: estimate.delivered, basis: estimate.basis.delivered },
  ] as const satisfies readonly WaitStep[];
  return { steps, total: estimate.total, basis: estimate.measured ? "measured" : "derived", samples: estimate.samples, start: estimate.start, batchSeconds: estimate.batchSeconds, ignored: estimate.ignored };
};

/** The line under a timeline: what its numbers rest on. A measured proof time that was left out is named. */
export const basisText = (timeline: Timeline): string => {
  if (timeline.basis !== "measured") return "Based on the chain and the proof rule.";
  const head = `Based on ${timeline.samples} transfers in the last 7 days`;
  if (timeline.ignored.includes("proved")) return `${head}; the proof step is based on the chain and the proof rule.`;
  return `${head}${timeline.start === "measured" ? "." : "; the proof step follows the proof rule."}`;
};

/**
 * What is left of a transfer that is in flight (`remainingWait` of `@zkb/core`): the timeline's total less the time since
 * the send, and never less than the delivery step. A transfer past its worst case is `late`.
 *
 * @param timeline The direction's timeline.
 * @param status The transfer's status.
 * @param elapsedSeconds Seconds since it was sent.
 * @returns The range left, or null for a transfer that is not in flight.
 */
export const remainingOf = (timeline: Timeline, status: string, elapsedSeconds: number): (Range & { readonly late: boolean }) | null =>
  remainingWait({ delivered: timeline.steps[3].range, total: timeline.total }, status, elapsedSeconds);

/** A clock time, "14:32", of `unix` seconds in the viewer's zone. */
export const clockText = (unix: number): string => new Date(unix * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });

/** The direction's timing from the indexer's per-direction list, or null. */
export const timingFor = (timings: readonly { readonly sourceChainId: number; readonly timing: DirectionTiming | null }[], sourceChainId: number): WindowTiming | null =>
  timings.find((row) => row.sourceChainId === sourceChainId)?.timing?.last7d ?? null;

/**
 * The proving time of a direction from the backend's benchmarks (`provingPartsOf` of `@zkb/core`): the prover's total,
 * the time from its answer to the board post, and the time from the board to the light client on chain, typical and
 * worst case. Null with fewer than {@link MIN_SAMPLES} proofs. The timeline leaves out a result past {@link SANE_LIMITS}.
 *
 * @param steps The direction's steps over the window.
 */
export const provingOf = (steps: BenchmarkSteps | undefined): Range | null => provingRangeOf(provingPartsOf(steps));

/** The part of `GET /directions/:direction/pipeline` the rule is read from. */
export type PipelineRuleWire = {
  readonly minIntervalSeconds: number;
  readonly profitMargin: number;
  readonly proofCostUsd: string;
  readonly priced: boolean;
} | undefined;

/** The rule of a pipeline answer; null from an older backend that does not report it. */
export const ruleOf = (wire: PipelineRuleWire): ProofRule | null =>
  wire === undefined ? null : { minIntervalSeconds: wire.minIntervalSeconds, profitMargin: wire.profitMargin, proofCostUsd: Number(wire.proofCostUsd), priced: wire.priced };
