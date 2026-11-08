/**
 * The wait-time timeline of a direction: Sent, Final on the source chain, Proved, Delivered, each with a typical
 * (median) and a worst case (90th percentile) in seconds. Pure: no network, no clock.
 *
 * Owner, 2026-11-07: "we should show a timeline somehow of ranges of wait times for different chains so that people can
 * manage their expectations", and "for the proved section, this will probably change the most for mainnet, when there
 * is real money and tiping/delivery".
 *
 * Where each range comes from:
 *
 * - Sent: one block of the source chain (typical one slot, worst case two).
 * - Final on the source: the chain's own rule, two epochs. The indexer's measured send-to-final time over the last 7
 *   days when it has {@link MIN_SAMPLES} deliveries, else the two epochs; the block of the send is taken off it.
 * - Proved: set by the proof rule and the user's fee. A fee that pays for a proof starts it at finality; a fee that
 *   does not waits for a batch, up to the direction's minimum interval. The proving time itself is the backend's
 *   measured total for the last 7 days, else {@link PROVING_DEFAULT}.
 * - Delivered: the indexer's measured covered-to-delivered time over the last 7 days, else {@link DELIVERY_DEFAULT}.
 *
 * A measured range far past what its step can take (see {@link SANE_LIMITS}) is a measuring fault, not a wait: it is
 * left out, the step falls back to the chain's or the rule's figure, and the line under the timeline says so. On
 * 2026-11-08 a backend fault read the proof's time to the chain as 52 h and the timeline showed "~57 h 7 min".
 */
import { defaultFinalitySeconds, secondsPerSlot } from "@zk-bridge/shared";
import type { DirectionTiming, WindowTiming } from "../explore/explore-source";

/** Deliveries needed in the window before a measured range is used. */
export const MIN_SAMPLES = 5;

/** Proving a header and posting the proof, when the backend has measured none: 2 min typical, 4 min worst case. */
export const PROVING_DEFAULT: Range = { typical: 120, worst: 240 };

/** Covered to delivered by a runner or by the user, when the indexer has measured none. */
export const DELIVERY_DEFAULT: Range = { typical: 60, worst: 300 };

/**
 * The longest worst case, in seconds, a measured range may have before it is left out as a measuring fault:
 * proving and posting a proof 30 min (it takes about two); covered to delivered 30 min (a runner delivers within
 * minutes); send to final three times the chain's two epochs; the measured proof wait twice the batch interval plus
 * the proving limit.
 */
export const SANE_LIMITS = { provingSeconds: 30 * 60, deliverySeconds: 30 * 60, finalityFactor: 3 } as const;

/** A typical and a worst-case wait, in seconds. */
export type Range = { readonly typical: number; readonly worst: number };

/** How a direction's proofs start, as the backend reports it (`rule` of `GET /directions/:direction/pipeline`). */
export type ProofRule = {
  readonly minIntervalSeconds: number;
  readonly profitMargin: number;
  /** The proof's share of the cost of one message, in dollars. */
  readonly proofCostUsd: number;
  /** False on a testnet: no token has a price, so no fee pays for a proof. */
  readonly priced: boolean;
};

/** What the user's fee does to the proof step. */
export type FeeReading =
  /** The fee and the cost of one message (proof plus delivery gas), in dollars. */
  | { readonly kind: "known"; readonly feeUsd: number; readonly costUsd: number }
  /** No fee is chosen (Activity, Explore). */
  | { readonly kind: "unknown" }
  /** Use the proof waits that were measured, whatever fees paid. */
  | { readonly kind: "observed" };

/** Everything a timeline is made from. */
export type WaitInputs = {
  readonly sourceChainId: number;
  /** The last 7 days of deliveries from the source chain, from the indexer; null when it gave none. */
  readonly timing: WindowTiming | null;
  readonly rule: ProofRule | null;
  /** The backend's measured proving time (total plus the time to the chain); null when it gave none. */
  readonly proving: Range | null;
};

/** What a step's range rests on. */
export type Basis = "measured" | "chain" | "rule";

/** How the proof step starts. */
export type ProofStart = "at-finality" | "batch" | "testnet" | "measured" | "unknown";

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
  readonly ignored: readonly ("final" | "proved" | "delivered")[];
};

/** Seconds as "45 s", "18 min", "2 h" or "2 h 10 min". */
export const durationText = (seconds: number): string => {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${whole} s`;
  const minutes = Math.round(whole / 60);
  if (minutes < 120) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
};

/** "typical 18 min · up to 75 min". */
export const rangeText = (range: Range): string => `typical ${durationText(range.typical)} · up to ${durationText(range.worst)}`;

/** The interval in words: "hourly" for an hour, else "every 90 min". */
const everyText = (seconds: number): string => (seconds === 3600 ? "hourly" : `every ${durationText(seconds)}`);

const add = (...ranges: readonly Range[]): Range => ({ typical: ranges.reduce((sum, range) => sum + range.typical, 0), worst: ranges.reduce((sum, range) => sum + range.worst, 0) });

/** The measured median and p90 of a step, or null. */
const measuredOf = (step: { readonly median: number | null; readonly p90: number | null } | undefined): Range | null =>
  step === undefined || step.median === null || step.p90 === null ? null : { typical: step.median, worst: Math.max(step.median, step.p90) };

/**
 * Whether a fee pays for a proof alone: the backend's profit rule, fees at least cost times the margin.
 *
 * @param rule The direction's rule.
 * @param fee What the user pays.
 * @returns `"pays"`, `"short"` (it does not) or `"unknown"` (no fee chosen, or no price).
 */
export const feeVerdict = (rule: ProofRule, fee: FeeReading): "pays" | "short" | "unknown" => {
  if (fee.kind !== "known" || !rule.priced) return "unknown";
  // A hair of tolerance: 0.1 x 1.5 is 0.15000000000000002 in floating point.
  return fee.feeUsd >= fee.costUsd * rule.profitMargin - 1e-9 ? "pays" : "short";
};

/**
 * The timeline of a direction.
 *
 * @param inputs The measured and rule data.
 * @param fee What the user pays, when known.
 */
export const buildTimeline = (inputs: WaitInputs, fee: FeeReading): Timeline => {
  const slot = secondsPerSlot(inputs.sourceChainId);
  const finality = defaultFinalitySeconds(inputs.sourceChainId);
  const rule = inputs.rule;
  const interval = rule === null ? 0 : rule.minIntervalSeconds;
  const ignored: ("final" | "proved" | "delivered")[] = [];
  /** The range when its worst case is within `limit`, else null, and the step is named as left out. */
  const sane = (range: Range | null, limit: number, key: "final" | "proved" | "delivered"): Range | null => {
    if (range === null || range.worst <= limit) return range;
    if (!ignored.includes(key)) ignored.push(key);
    return null;
  };
  const timing = inputs.timing !== null && inputs.timing.count >= MIN_SAMPLES ? inputs.timing : null;
  const [sentToFinal, wait, delivery] =
    timing === null
      ? [null, null, null]
      : [
          sane(measuredOf(timing.steps[0]), SANE_LIMITS.finalityFactor * finality, "final"),
          // Without a rule the interval is unknown: an hour, the testnet's, stands in.
          sane(measuredOf(timing.steps[1]), 2 * (rule === null ? 3600 : interval) + SANE_LIMITS.provingSeconds, "proved"),
          sane(measuredOf(timing.steps[2]), SANE_LIMITS.deliverySeconds, "delivered"),
        ];
  const sent: Range = { typical: slot, worst: 2 * slot };

  // Final on the source: the chain's rule; the send's own block is part of the sent step.
  const finalSource = sentToFinal ?? { typical: finality, worst: finality };
  const final: Range = { typical: Math.max(0, finalSource.typical - sent.typical), worst: Math.max(0, finalSource.worst - sent.typical) };

  const measuredProving = sane(inputs.proving, SANE_LIMITS.provingSeconds, "proved");
  const proving = measuredProving ?? PROVING_DEFAULT;
  const provingBasis: Basis = measuredProving === null ? "chain" : "measured";
  let start: ProofStart;
  let proved: Range;
  let provedBasis: Basis;
  let provedNote: string;
  let batchSeconds: number | null = null;
  const waitsText = (seconds: number) => `Waits for a batch: up to ${durationText(seconds)}`;
  if (rule === null || fee.kind === "observed") {
    // No rule to apply, or the caller wants what happened: the measured wait, else the proving time alone.
    start = wait === null ? "unknown" : "measured";
    proved = wait ?? proving;
    provedBasis = wait === null ? provingBasis : "measured";
    provedNote = wait === null ? "A proof of the finalized block is made and posted" : "The wait for a proof, as measured";
  } else if (interval === 0 || feeVerdict(rule, fee) === "pays") {
    start = "at-finality";
    proved = proving;
    provedBasis = provingBasis;
    provedNote = "A proof starts at finality";
  } else {
    batchSeconds = interval;
    proved = { typical: interval / 2 + proving.typical, worst: interval + proving.worst };
    provedBasis = "rule";
    if (!rule.priced) {
      start = "testnet";
      provedNote = `Testnet: proofs run at least ${everyText(interval)}`;
    } else {
      start = "batch";
      provedNote = `${waitsText(interval)}${fee.kind === "known" ? "; your fee does not pay for a proof alone" : ""}`;
    }
  }
  const delivered = delivery ?? DELIVERY_DEFAULT;
  const measured = sentToFinal !== null && delivery !== null;
  const steps = [
    { key: "sent", label: "Sent", note: "The transaction is in a block", range: sent, basis: "chain" },
    { key: "final", label: "Final on the source", note: "Set by the chain: two epochs", range: final, basis: sentToFinal === null ? "chain" : "measured" },
    { key: "proved", label: "Proved", note: provedNote, range: proved, basis: provedBasis },
    { key: "delivered", label: "Delivered", note: "A delivery bot or you delivers it once proved", range: delivered, basis: delivery === null ? "chain" : "measured" },
  ] as const satisfies readonly WaitStep[];
  return { steps, total: add(...steps.map((step) => step.range)), basis: measured ? "measured" : "derived", samples: measured ? (timing as WindowTiming).count : 0, start, batchSeconds, ignored };
};

/** The line under a timeline: what its numbers rest on. A measured proof time that was left out is named. */
export const basisText = (timeline: Timeline): string => {
  if (timeline.basis !== "measured") return "Based on the chain and the proof rule.";
  const head = `Based on ${timeline.samples} transfers in the last 7 days`;
  if (timeline.ignored.includes("proved")) return `${head}; the proof step is based on the chain and the proof rule.`;
  return `${head}${timeline.start === "measured" ? "." : "; the proof step follows the proof rule."}`;
};

/**
 * What is left of a transfer that is in flight: the timeline's total less the time since the send, and never less than
 * the delivery step. A transfer past its worst case is `late` and has the delivery step left.
 *
 * @param timeline The direction's timeline.
 * @param status The transfer's status.
 * @param elapsedSeconds Seconds since it was sent.
 * @returns The range left, or null for a transfer that is not in flight.
 */
export const remainingOf = (timeline: Timeline, status: string, elapsedSeconds: number): (Range & { readonly late: boolean }) | null => {
  if (status === "delivered" || status === "release_failed") return null;
  const delivered = timeline.steps[3].range;
  if (status === "covered") return { ...delivered, late: false };
  const elapsed = Math.max(0, elapsedSeconds);
  return { typical: Math.max(delivered.typical, timeline.total.typical - elapsed), worst: Math.max(delivered.worst, timeline.total.worst - elapsed), late: elapsed > timeline.total.worst };
};

/** A clock time, "14:32", of `unix` seconds in the viewer's zone. */
export const clockText = (unix: number): string => new Date(unix * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });

/** The direction's timing from the indexer's per-direction list, or null. */
export const timingFor = (timings: readonly { readonly sourceChainId: number; readonly timing: DirectionTiming | null }[], sourceChainId: number): WindowTiming | null =>
  timings.find((row) => row.sourceChainId === sourceChainId)?.timing?.last7d ?? null;

type BenchmarkStat = { readonly count: number; readonly medianMs: number | null; readonly p90Ms: number | null };

/** The part of `GET /benchmarks` the proving time is read from (`webhookToBoard` is absent from an older backend). */
export type BenchmarkSteps = Readonly<Record<"total" | "proofToOnChain", BenchmarkStat>> & { readonly webhookToBoard?: BenchmarkStat };

/**
 * The proving time of a direction from the backend's benchmarks: the prover's total, the time from its answer to the
 * board post, and the time from the board to the light client on chain, typical and worst case. Null with fewer than
 * {@link MIN_SAMPLES} proofs. The timeline leaves out a result past {@link SANE_LIMITS}.
 *
 * @param steps The direction's steps over the window.
 */
export const provingOf = (steps: BenchmarkSteps | undefined): Range | null => {
  if (steps === undefined || steps.total.count < MIN_SAMPLES || steps.total.medianMs === null || steps.total.p90Ms === null) return null;
  const after = [steps.webhookToBoard, steps.proofToOnChain];
  return {
    typical: after.reduce((sum, step) => sum + (step?.medianMs ?? 0), steps.total.medianMs) / 1000,
    worst: after.reduce((sum, step) => sum + (step?.p90Ms ?? 0), steps.total.p90Ms) / 1000,
  };
};

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
