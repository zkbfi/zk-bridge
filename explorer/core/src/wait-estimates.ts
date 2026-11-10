/**
 * The wait-time estimates of a transfer, computed the same way by the backend and the dapp: the chain's timing (slots,
 * epochs, finality, sync-committee periods and the stranding deadline), the proof rule (when a proof is due under the
 * batch interval and the profit margin), and the timeline of a direction (Sent, Final on the source, Proved, Delivered,
 * typical and worst case) from the rule and the measured step times.
 *
 * Owner, 2026-11-08: "make sure that your estimated calculations based on configuration and deterministic behavior
 * calculates the same thing on the backend and frontend. should be able to share functions too".
 *
 * Times are numbers, not bigints: seconds (or milliseconds where a name says so) since 1970 or as durations, whole
 * numbers for the chain's clock and fractions for measured medians. Money stays bigint, USD × 1e18, as in the fee
 * rules. Pure: no I/O, no clock. The vectors in `vectors/wait-estimates-vectors.json` pin the outputs; the backend and
 * the dapp each run them through their own path.
 */
import { PROOF_COST_USD, WAD } from "./fee-rules.js";

// ---------------------------------------------------------------------------------------------------------------------
// The chain's timing
// ---------------------------------------------------------------------------------------------------------------------

/** Slots of one epoch on every beacon chain the bridge follows. */
export const SLOTS_PER_EPOCH = 32;

/** The epochs a send waits for finality by default (the indexer's finality window, `finalitySeconds` of a pair side). */
export const FINALITY_EPOCHS = 2;

/** Slots of one sync-committee period: 8192 (256 epochs) on all four chains. */
export const SLOTS_PER_SYNC_COMMITTEE_PERIOD = 8192;

/** The slot length of each chain the bridge knows, in seconds. */
export const SECONDS_PER_SLOT = {
  1: 12,
  369: 10,
  11155111: 12,
  943: 10,
} as const satisfies Readonly<Record<number, number>>;

/** The slot length of a chain that has no entry in {@link SECONDS_PER_SLOT}. */
export const DEFAULT_SECONDS_PER_SLOT = 12;

/**
 * The seconds of one slot on a chain.
 *
 * @param chainId The chain identifier. A chain with no entry gets 12 seconds.
 */
export const secondsPerSlot = (chainId: number): number => (SECONDS_PER_SLOT as Readonly<Record<number, number>>)[chainId] ?? DEFAULT_SECONDS_PER_SLOT;

/** The seconds of one epoch on a chain: the default lookahead of the batch rule. */
export const epochSeconds = (chainId: number): number => secondsPerSlot(chainId) * SLOTS_PER_EPOCH;

/**
 * The finality window of the indexer: two epochs of 32 slots on the beacon chain of the source (Ethereum 768,
 * PulseChain 640, Sepolia 768, PulseChain testnet v4 640). A send older than this counts as waiting for finality. It is
 * the earliest a block can be final; {@link expectedFinalityAt} is when it is expected to be.
 *
 * @param chainId The source chain identifier.
 */
export const defaultFinalitySeconds = (chainId: number): number => secondsPerSlot(chainId) * SLOTS_PER_EPOCH * FINALITY_EPOCHS;

/** A beacon chain's clock: the start of slot 0 in seconds since 1970, and the slot length. */
export type SlotClock = { readonly genesisTime: number; readonly secondsPerSlot: number };

/**
 * The clock of a chain from one slot and its start time, as a light client head reports them.
 *
 * @param slot A slot.
 * @param slotTime The start of that slot, in seconds since 1970.
 * @param seconds The slot length.
 */
export const clockFromSlot = (slot: number, slotTime: number, seconds: number): SlotClock => ({ genesisTime: slotTime - slot * seconds, secondsPerSlot: seconds });

/** The beacon slot of an execution block time (a block after the merge carries its slot's start time); 0 before genesis. */
export const slotAtTime = (seconds: number, clock: SlotClock): number => Math.max(0, Math.floor((seconds - clock.genesisTime) / clock.secondsPerSlot));

/** The start of a slot, in seconds since 1970. */
export const slotStartTime = (slot: number, clock: SlotClock): number => clock.genesisTime + slot * clock.secondsPerSlot;

/**
 * When the source chain is expected to finalize a block of `slot`, in seconds since 1970. The checkpoint at the start
 * of the next epoch (e + 1) covers it, and that checkpoint finalizes at the start of epoch e + 3 when the chain runs
 * normally. The signatures over that finality arrive one slot later. So a block waits 66 to 97 slots. A block in the
 * first slot of an epoch is that epoch's own checkpoint and finalizes an epoch sooner; the rule counts it late, which is
 * what the watcher has always assumed.
 */
export const expectedFinalityAt = (slot: number, clock: SlotClock): number => {
  const epoch = Math.floor(slot / SLOTS_PER_EPOCH);
  return slotStartTime((epoch + 3) * SLOTS_PER_EPOCH + 1, clock);
};

/**
 * The finalized slot the source is expected to have at a time (seconds since 1970): the checkpoint that finalized at
 * the start of the latest epoch E, which is the first slot of epoch E - 2. Consistent with {@link expectedFinalityAt}:
 * a block of slot `s` is covered from the time it returns.
 */
export const finalizedSlotAt = (seconds: number, clock: SlotClock): number => {
  const epoch = Math.floor(((seconds - clock.genesisTime) / clock.secondsPerSlot - 1) / SLOTS_PER_EPOCH);
  return Math.max(0, (epoch - 2) * SLOTS_PER_EPOCH);
};

/** A typical and a worst-case wait, in seconds. */
export type Range = { readonly typical: number; readonly worst: number };

/**
 * The wait from a send to the finality that covers it, by {@link expectedFinalityAt}, over the 32 places a send can
 * have in its epoch: typical the median (81.5 slots), worst case the first slot of an epoch (97 slots).
 *
 * @param seconds The slot length of the source chain.
 */
export const finalityWaitRange = (seconds: number): Range => {
  const clock: SlotClock = { genesisTime: 0, secondsPerSlot: seconds };
  const waits = Array.from({ length: SLOTS_PER_EPOCH }, (_, slot) => expectedFinalityAt(slot, clock) - slotStartTime(slot, clock)).sort((left, right) => left - right);
  const middle = SLOTS_PER_EPOCH / 2;
  return { typical: ((waits[middle - 1] as number) + (waits[middle] as number)) / 2, worst: waits[SLOTS_PER_EPOCH - 1] as number };
};

/** The sync-committee period of a slot. */
export const syncCommitteePeriodOf = (slot: number, slotsPerPeriod: number = SLOTS_PER_SYNC_COMMITTEE_PERIOD): number => Math.floor(slot / slotsPerPeriod);

/** What a light client contract reports that sets its stranding deadline. */
export type StrandingFacts = {
  readonly headSlot: number;
  /** Whether `syncCommittees(headPeriod + 1)` is set. */
  readonly nextCommitteeKnown: boolean;
  readonly slotsPerPeriod: number;
};

/**
 * When a light client strands if no proof lands: the first second of the period after the last committee it stores.
 * From then on its own committees verify no new update, and only handoff updates can move it.
 */
export type StrandingDeadline = {
  readonly headPeriod: number;
  /** The highest period whose committee the light client stores. */
  readonly lastKnownPeriod: number;
  /** The period it strands in: `lastKnownPeriod + 1`. */
  readonly strandPeriod: number;
  /** Seconds since 1970. */
  readonly deadlineSeconds: number;
};

/** The {@link StrandingDeadline} of a light client. */
export const strandingDeadline = (facts: StrandingFacts, clock: SlotClock): StrandingDeadline => {
  const headPeriod = syncCommitteePeriodOf(facts.headSlot, facts.slotsPerPeriod);
  const lastKnownPeriod = headPeriod + (facts.nextCommitteeKnown ? 1 : 0);
  return { headPeriod, lastKnownPeriod, strandPeriod: lastKnownPeriod + 1, deadlineSeconds: slotStartTime((lastKnownPeriod + 1) * facts.slotsPerPeriod, clock) };
};

/** The hours from `nowMs` to `atMs` (both milliseconds since 1970), negative once passed: "until stranded". */
export const hoursUntil = (atMs: number, nowMs: number): number => (atMs - nowMs) / 3_600_000;

/** {@link hoursUntil} to two decimals, as the backend's pipeline answer carries it (`deadline.hoursLeft`). */
export const hoursUntilRounded = (atMs: number, nowMs: number): number => Math.round((atMs - nowMs) / 36_000) / 100;

// ---------------------------------------------------------------------------------------------------------------------
// The proof rule
// ---------------------------------------------------------------------------------------------------------------------

/** A margin as a number (1.5) to WAD, to six decimals. */
export const marginWadOf = (margin: number): bigint => BigInt(Math.round(margin * 1_000_000)) * (WAD / 1_000_000n);

/** A WAD margin as a number (1.5e18 is 1.5). */
export const marginOfWad = (marginWad: bigint): number => Number(marginWad) / 1e18;

/** A cost times the margin, rounded up: what fees must reach. USD × 1e18. */
export const withMargin = (costUsd: bigint, marginWad: bigint): bigint => (costUsd * marginWad + WAD - 1n) / WAD;

/** The cost of proving and delivering `count` messages, times the margin, rounded up. USD × 1e18. */
export const batchCostUsd = (count: number, deliveryUsd: bigint, marginWad: bigint): bigint => withMargin(PROOF_COST_USD + BigInt(count) * deliveryUsd, marginWad);

/**
 * Whether fees pay for a proof: they reach the cost times the margin ({@link withMargin}). The backend's batch rule and
 * the dapp's "your fee pays for a proof alone" both ask this.
 */
export const feesPay = (feesUsd: bigint, costUsd: bigint, marginWad: bigint): boolean => feesUsd >= withMargin(costUsd, marginWad);

/**
 * When the last proof's minimum interval ends, in seconds since 1970: `-Infinity` when the direction has no proof yet
 * (the interval never holds the first proof back).
 */
export const intervalEndsAt = (lastProofAt: number | null, minIntervalSeconds: number): number => (lastProofAt === null ? Number.NEGATIVE_INFINITY : lastProofAt + minIntervalSeconds);

/**
 * Whether the minimum interval lets a proof start now: it is 0, the direction has no proof yet, or the last proof
 * started at least that long ago.
 */
export const intervalAllows = (nowSeconds: number, lastProofAt: number | null, minIntervalSeconds: number): boolean => minIntervalSeconds === 0 || nowSeconds >= intervalEndsAt(lastProofAt, minIntervalSeconds);

/**
 * When a batch that does not pay is due anyway: the minimum interval after the last proof, and no earlier than the
 * first finality of a message of the batch (a proof needs a final message). Seconds since 1970.
 */
export const batchDueAt = (oldestFinalAt: number, lastProofAt: number | null, minIntervalSeconds: number): number => Math.max(oldestFinalAt, intervalEndsAt(lastProofAt, minIntervalSeconds));

/**
 * The wait for a proof after finality, as a range over when the last proof was: a fee that pays proves at finality
 * (the proving time); one that does not waits for the interval to end, any time up to the whole interval after its
 * finality (half of it typically), then proves.
 *
 * @param minIntervalSeconds The direction's minimum interval; 0 proves at finality.
 * @param proving The proving time.
 * @param pays Whether the fee pays for a proof alone.
 */
export const proofWaitRange = (minIntervalSeconds: number, proving: Range, pays: boolean): Range =>
  pays || minIntervalSeconds === 0 ? proving : { typical: minIntervalSeconds / 2 + proving.typical, worst: minIntervalSeconds + proving.worst };

// ---------------------------------------------------------------------------------------------------------------------
// Measured step times
// ---------------------------------------------------------------------------------------------------------------------

/** Samples needed in a window before a measured range is used. */
export const MIN_SAMPLES = 5;

/** Proving a header and posting the proof, when nothing is measured: 2 min typical, 4 min worst case. */
export const PROVING_DEFAULT: Range = { typical: 120, worst: 240 };

/** Covered to delivered by a runner or by the user, when nothing is measured. */
export const DELIVERY_DEFAULT: Range = { typical: 60, worst: 300 };

/**
 * The longest worst case, in seconds, a measured range may have before it is left out as a measuring fault: proving
 * and posting a proof 30 min (it takes about two); covered to delivered 30 min (a runner delivers within minutes);
 * the measured proof wait twice the batch interval plus the proving limit. On 2026-11-08 a backend fault read the proof's time to the chain as 52 h.
 */
export const SANE_LIMITS = { provingSeconds: 30 * 60, deliverySeconds: 30 * 60 } as const;

/** The interval that stands in when the rule is unknown: an hour, the testnet's. */
export const UNKNOWN_INTERVAL_SECONDS = 3600;

/** A range when its worst case is within `limit` seconds, else null. */
export const saneRange = (range: Range | null, limit: number): Range | null => (range === null || range.worst > limit ? null : range);

/** A median and a 90th percentile in seconds (the indexer's spread). */
export type Spread = { readonly median: number | null; readonly p90: number | null };

/** A measured spread as a range (worst never under typical), or null without both figures. */
export const rangeOfSpread = (spread: Spread | undefined): Range | null =>
  spread === undefined || spread.median === null || spread.p90 === null ? null : { typical: spread.median, worst: Math.max(spread.median, spread.p90) };

/** A step of the backend's benchmarks: samples, median and 90th percentile in milliseconds. */
export type BenchmarkStat = { readonly count: number; readonly medianMs: number | null; readonly p90Ms: number | null };

/** The steps of `GET /benchmarks` the proving time is read from (`webhookToBoard` is absent from an older backend). */
export type BenchmarkSteps = Readonly<Record<"total" | "proofToOnChain", BenchmarkStat>> & { readonly webhookToBoard?: BenchmarkStat };

/** The parts of the proving time, in seconds: the prover's run, its answer to the board post, and the board to the chain. */
export type ProvingParts = { readonly total: Range; readonly webhookToBoard: Range; readonly proofToOnChain: Range };

/** A benchmark step in seconds; 0 for a step with no figures. */
const secondsOfStat = (stat: BenchmarkStat | undefined): Range => ({ typical: (stat?.medianMs ?? 0) / 1000, worst: (stat?.p90Ms ?? 0) / 1000 });

/**
 * The parts of the proving time from the backend's benchmarks, or null with fewer than {@link MIN_SAMPLES} prover runs
 * or without their figures. A missing later step counts 0.
 */
export const provingPartsOf = (steps: BenchmarkSteps | undefined): ProvingParts | null => {
  if (steps === undefined || steps.total.count < MIN_SAMPLES || steps.total.medianMs === null || steps.total.p90Ms === null) return null;
  return { total: secondsOfStat(steps.total), webhookToBoard: secondsOfStat(steps.webhookToBoard), proofToOnChain: secondsOfStat(steps.proofToOnChain) };
};

/** The sum of ranges. */
export const addRanges = (...ranges: readonly Range[]): Range => ({ typical: ranges.reduce((sum, range) => sum + range.typical, 0), worst: ranges.reduce((sum, range) => sum + range.worst, 0) });

/** The proving time of {@link ProvingParts}: the prover's total, then to the board, then to the chain. */
export const provingRangeOf = (parts: ProvingParts | null): Range | null => (parts === null ? null : addRanges(parts.total, parts.webhookToBoard, parts.proofToOnChain));

/**
 * The proving parts the estimates may use: null when there are none or their sum is past
 * {@link SANE_LIMITS}.provingSeconds (a measuring fault, as the 52 h of 2026-11-08). The backend's stage times and the
 * dapp's proof step both read this.
 */
export const saneProvingParts = (parts: ProvingParts | null): ProvingParts | null => (saneRange(provingRangeOf(parts), SANE_LIMITS.provingSeconds) === null ? null : parts);

/** A covered-to-delivered benchmark as a range in seconds, or null with too few samples or past its limit. */
export const deliveryRangeOfStat = (stat: BenchmarkStat | undefined): Range | null =>
  stat === undefined || stat.count < MIN_SAMPLES || stat.medianMs === null || stat.p90Ms === null ? null : saneRange({ typical: stat.medianMs / 1000, worst: Math.max(stat.medianMs, stat.p90Ms) / 1000 }, SANE_LIMITS.deliverySeconds);

// ---------------------------------------------------------------------------------------------------------------------
// The timeline of a direction
// ---------------------------------------------------------------------------------------------------------------------

/** How a direction's proofs start (`rule` of `GET /directions/:direction/pipeline`). */
export type ProofRule = {
  readonly minIntervalSeconds: number;
  readonly profitMargin: number;
  /** The proof's share of the cost of one message, in dollars. */
  readonly proofCostUsd: number;
  /**
   * False on a testnet: no token has a price, so a fee is never valued; only a tip at the automatic maximum (1% of the
   * amount, `tip-verdict.ts`) pays for a proof there.
   */
  readonly priced: boolean;
};

/** What the user's fee does to the proof step. */
export type FeeReading =
  /** The fee and the cost of one message (proof plus delivery gas), USD × 1e18. */
  | { readonly kind: "known"; readonly feeUsd: bigint; readonly costUsd: bigint }
  /** No fee is chosen. */
  | { readonly kind: "unknown" }
  /**
   * The fee cannot be valued (no market for the token or the destination coin, or no price can be read): whether the
   * tip is at least the automatic maximum of the amount (`atAutomaticMaximum`), which counts as paying.
   */
  | { readonly kind: "unpriced"; readonly atMaximum: boolean }
  /** Use the proof waits that were measured, whatever fees paid. */
  | { readonly kind: "observed" };

/**
 * The indexer's measured steps of a window: send to final, the wait for a proof after finality, covered to delivered.
 * The first is not read: the indexer defines it as the send plus two epochs, not a measurement, and the timeline uses
 * the watcher's finality rule instead (owner, 2026-11-08: "yes, use the watcher's rule").
 */
export type MeasuredSteps = { readonly count: number; readonly steps: readonly [Spread, Spread, Spread] };

/** Everything a timeline is made from. */
export type WaitInputs = {
  readonly sourceChainId: number;
  /** The last 7 days of deliveries from the source chain; null when none were given. */
  readonly timing: MeasuredSteps | null;
  readonly rule: ProofRule | null;
  /** The measured proving time (total, to the board, to the chain); null when none was given. */
  readonly proving: Range | null;
};

/** What a step's range rests on. */
export type Basis = "measured" | "chain" | "rule";

/** How the proof step starts. */
export type ProofStart = "at-finality" | "batch" | "testnet" | "measured" | "unknown";

/** A step of the timeline that a measured range can be left out of. */
export type CheckedStep = "proved" | "delivered";

/** The ranges of a timeline, without its words. */
export type WaitEstimate = {
  readonly sent: Range;
  readonly final: Range;
  readonly proved: Range;
  readonly delivered: Range;
  readonly basis: { readonly final: Basis; readonly proved: Basis; readonly delivered: Basis };
  readonly total: Range;
  /** True when the covered-to-delivered range is measured; else from the chain and the rule. */
  readonly measured: boolean;
  /** Deliveries behind the measured ranges (0 when derived). */
  readonly samples: number;
  readonly start: ProofStart;
  /** The wait for a batch in seconds, when the proof may wait for one. */
  readonly batchSeconds: number | null;
  /** The steps whose measured range was past its {@link SANE_LIMITS} and left out. */
  readonly ignored: readonly CheckedStep[];
};

/**
 * Whether a fee pays for a proof alone, by the backend's profit rule ({@link feesPay}). An unpriced tip at the automatic
 * maximum pays, as in the backend's batch (`tip-verdict.ts`).
 *
 * @returns `"pays"`, `"short"` (it does not) or `"unknown"` (no fee chosen, or no price).
 */
export const feeVerdict = (rule: ProofRule, fee: FeeReading): "pays" | "short" | "unknown" => {
  if (fee.kind === "unpriced") return fee.atMaximum ? "pays" : "unknown";
  if (fee.kind !== "known" || !rule.priced) return "unknown";
  return feesPay(fee.feeUsd, fee.costUsd, marginWadOf(rule.profitMargin)) ? "pays" : "short";
};

/**
 * The ranges of a direction's timeline.
 *
 * - Sent: one block of the source chain (one slot typical, two worst).
 * - Final on the source: always {@link finalityWaitRange}, the watcher's rule (66 to 97 slots after the send), less
 *   the send's own block. The indexer's send-to-final is its window, not a measurement, so it is not read.
 * - Proved: {@link proofWaitRange} by the rule and the fee, with the measured proving time or {@link PROVING_DEFAULT};
 *   without a rule, or for `observed`, the measured wait.
 * - Delivered: the measured covered-to-delivered time, else {@link DELIVERY_DEFAULT}.
 *
 * A measured range past {@link SANE_LIMITS} is left out and named in `ignored`.
 */
export const waitEstimate = (inputs: WaitInputs, fee: FeeReading): WaitEstimate => {
  const slot = secondsPerSlot(inputs.sourceChainId);
  const finality = finalityWaitRange(slot);
  const rule = inputs.rule;
  const interval = rule === null ? 0 : rule.minIntervalSeconds;
  const ignored: CheckedStep[] = [];
  /** The range when its worst case is within `limit`, else null, and the step is named as left out. */
  const sane = (range: Range | null, limit: number, key: CheckedStep): Range | null => {
    const kept = saneRange(range, limit);
    if (range !== null && kept === null && !ignored.includes(key)) ignored.push(key);
    return kept;
  };
  const timing = inputs.timing !== null && inputs.timing.count >= MIN_SAMPLES ? inputs.timing : null;
  const [wait, delivery] =
    timing === null
      ? [null, null]
      : [
          sane(rangeOfSpread(timing.steps[1]), 2 * (rule === null ? UNKNOWN_INTERVAL_SECONDS : interval) + SANE_LIMITS.provingSeconds, "proved"),
          sane(rangeOfSpread(timing.steps[2]), SANE_LIMITS.deliverySeconds, "delivered"),
        ];
  const sent: Range = { typical: slot, worst: 2 * slot };
  const final: Range = { typical: finality.typical - sent.typical, worst: finality.worst - sent.typical };

  const measuredProving = sane(inputs.proving, SANE_LIMITS.provingSeconds, "proved");
  const proving = measuredProving ?? PROVING_DEFAULT;
  const provingBasis: Basis = measuredProving === null ? "chain" : "measured";
  let start: ProofStart;
  let proved: Range;
  let provedBasis: Basis;
  let batchSeconds: number | null = null;
  if (rule === null || fee.kind === "observed") {
    start = wait === null ? "unknown" : "measured";
    proved = wait ?? proving;
    provedBasis = wait === null ? provingBasis : "measured";
  } else {
    const pays = interval === 0 || feeVerdict(rule, fee) === "pays";
    proved = proofWaitRange(interval, proving, pays);
    if (pays) {
      start = "at-finality";
      provedBasis = provingBasis;
    } else {
      batchSeconds = interval;
      provedBasis = "rule";
      start = rule.priced ? "batch" : "testnet";
    }
  }
  const delivered = delivery ?? DELIVERY_DEFAULT;
  const measured = delivery !== null;
  return {
    sent,
    final,
    proved,
    delivered,
    basis: { final: "chain", proved: provedBasis, delivered: delivery === null ? "chain" : "measured" },
    total: addRanges(sent, final, proved, delivered),
    measured,
    samples: measured ? (timing as MeasuredSteps).count : 0,
    start,
    batchSeconds,
    ignored,
  };
};

/**
 * What is left of a transfer in flight: the total less the time since the send, and never less than the delivery step.
 * A transfer past its worst case is `late` and has the delivery step left.
 *
 * @param estimate The direction's timeline.
 * @param status The transfer's status.
 * @param elapsedSeconds Seconds since it was sent.
 * @returns The range left, or null for a transfer that is not in flight.
 */
export const remainingWait = (estimate: Pick<WaitEstimate, "delivered" | "total">, status: string, elapsedSeconds: number): (Range & { readonly late: boolean }) | null => {
  if (status === "delivered" || status === "release_failed") return null;
  const delivered = estimate.delivered;
  if (status === "covered") return { ...delivered, late: false };
  const elapsed = Math.max(0, elapsedSeconds);
  return { typical: Math.max(delivered.typical, estimate.total.typical - elapsed), worst: Math.max(delivered.worst, estimate.total.worst - elapsed), late: elapsed > estimate.total.worst };
};

/** Seconds as "45 s", "18 min", "2 h" or "2 h 10 min". */
export const waitDurationText = (seconds: number): string => {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${whole} s`;
  const minutes = Math.round(whole / 60);
  if (minutes < 120) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
};
