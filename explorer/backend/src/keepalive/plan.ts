/**
 * The plan that keeps a `BeaconLightClient` able to move. Pure: no network, no clock. See docs/testnet-run.md,
 * "Keeping the light clients alive".
 *
 * The rules come from the light-client program (`lc-core`, `verify_step`) and the contract:
 *
 * - A light client with its head in period P stores the committee of P, and of P + 1 once an update proved it. Call the
 *   highest stored period K (P + 1 or P).
 * - One update is verified by a stored committee: its signature lies in period P or P + 1, and P + 1 only with the next
 *   committee stored. So once the source chain signs in period K + 1, the newest update cannot be verified by anything
 *   the light client holds.
 * - From there only a chain of committee handoff updates helps: the update of period p (attested and signed in p)
 *   proves the committee of p + 1. The prover reads them from `/eth/v1/beacon/light_client/updates` and folds them
 *   with the newest update into one proof (up to 64 updates per proof). A source node that does not serve that route
 *   (chain 943), or that pruned a period, leaves the light client stranded: no proof can move it again.
 *
 * So the deadline of a light client is the first slot of period K + 1. Before it, one ordinary proof (a keep-alive)
 * moves the head to the newest finalized header and the next committee it proves pushes the deadline one period out.
 */

/** What the light client contract reports. Slots and times are whole numbers well below 2^53. */
export type LightClientFacts = {
  readonly headSlot: number;
  readonly slotsPerPeriod: number;
  /** Genesis time of the source beacon chain, in seconds since 1970. */
  readonly genesisTime: number;
  readonly secondsPerSlot: number;
  /** Whether `syncCommittees(headPeriod + 1)` is set. */
  readonly nextCommitteeKnown: boolean;
};

/** What the source beacon node reports. */
export type SourceFacts = {
  /** The slot of the newest finalized header. */
  readonly finalizedSlot: number;
};

/**
 * Whether the source node can give the committee handoff updates that a catch-up needs.
 *
 * - `serves`: it gave the update of every needed period.
 * - `missing`: no source has `period`: the beacon node lacks it (the route answers 404, as on chain 943, or the node
 *   pruned it), and so do the states, the handoff URLs and the handoff archive when they are asked.
 * - `not-needed`: no handoff is needed, so nobody asked.
 */
export type SourceHistory =
  | { readonly kind: "serves" }
  /** `tried`: each source asked and what it answered, by host, when several were asked. */
  | { readonly kind: "missing"; readonly period: number; readonly tried?: readonly string[] }
  | { readonly kind: "not-needed" };

/** When the planner calls for action. */
export type Policy = {
  /** A head older than this needs a proof (the backend's `limits.keepAliveSeconds`, 43200 by default). */
  readonly keepAliveSeconds: number;
  /** Act when the deadline is closer than this, whatever the head age. */
  readonly marginSeconds: number;
};

/** The defaults: the backend's keep-alive age, and six hours of margin (two runs of a three-hour timer). */
export const DEFAULT_POLICY: Policy = { keepAliveSeconds: 43_200, marginSeconds: 6 * 3600 };

/** The largest number of updates that one proof folds (`lc_core::update::MAX_FOLD_UPDATES`). */
export const MAX_FOLD_UPDATES = 64;

/** The verdicts, from good to bad. */
export const VERDICTS = ["fresh", "needs-keep-alive", "needs-stepping", "stranded"] as const;
export type Verdict = (typeof VERDICTS)[number];

/**
 * One update inside the proofs that move the light client. Every step is signed by a committee that the light client
 * stores when the step runs: the stored next committee, or the one the step before proved.
 */
export type Step =
  | { readonly kind: "handoff"; readonly period: number; readonly signedBy: number; readonly proves: number }
  | { readonly kind: "latest"; readonly period: number; readonly signedBy: number };

/** Everything the status command prints for one light client. */
export type Assessment = {
  readonly verdict: Verdict;
  /** One sentence: why this verdict. */
  readonly reason: string;
  readonly headPeriod: number;
  /** The periods whose committee the light client stores, in order. */
  readonly periodsKnown: readonly number[];
  readonly lastKnownPeriod: number;
  readonly currentSlot: number;
  readonly currentPeriod: number;
  readonly finalizedPeriod: number;
  /** How many period borders the source chain passed since the head. */
  readonly periodsBehind: number;
  readonly headAgeSeconds: number;
  /** The first second of period `lastKnownPeriod + 1`: from then on only handoff updates can move the light client. */
  readonly deadlineSeconds: number;
  /** Negative once the deadline passed. */
  readonly secondsUntilDeadline: number;
  /** The periods whose handoff update a proof needs now, in order. Empty for a keep-alive. */
  readonly handoffPeriods: readonly number[];
  /** The updates that move the light client to the newest finalized header, in order. */
  readonly steps: readonly Step[];
  /** How many proofs those steps take (one proof folds up to 64 updates). Zero when fresh. */
  readonly proofs: number;
  /**
   * The source chain just crossed into a new period and its newest finalized header is still in the old one. The
   * program refuses an update signed in the next period that does not cross into it, so a proof must wait the few
   * epochs until finality crosses too.
   */
  readonly waitForFinality: boolean;
};

const periodOf = (slot: number, slotsPerPeriod: number): number => Math.floor(slot / slotsPerPeriod);

const range = (start: number, end: number): number[] => Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index);

/** The current slot of the source chain by the clock of the light client. */
export function currentSlotAt(facts: LightClientFacts, nowSeconds: number): number {
  return Math.max(0, Math.floor((nowSeconds - facts.genesisTime) / facts.secondsPerSlot));
}

/**
 * The periods whose handoff update moves the light client to the source chain as it is now: from the last stored
 * period up to the period that signs now (the clock) or that the newest finalized header is in, whichever is later.
 * Empty when the stored committees cover both. The caller asks the source node for these, and only these.
 */
export function neededHandoffPeriods(facts: LightClientFacts, source: SourceFacts, nowSeconds: number): number[] {
  const headPeriod = periodOf(facts.headSlot, facts.slotsPerPeriod);
  const lastKnown = headPeriod + (facts.nextCommitteeKnown ? 1 : 0);
  const signing = periodOf(currentSlotAt(facts, nowSeconds), facts.slotsPerPeriod);
  const finalized = periodOf(source.finalizedSlot, facts.slotsPerPeriod);
  return range(lastKnown, Math.max(signing, finalized));
}

/**
 * Judges one light client.
 *
 * @param input.facts What the contract reports.
 * @param input.source The newest finalized slot of the source chain.
 * @param input.history Whether the source node gives the handoffs of {@link neededHandoffPeriods}.
 * @param input.policy When to act.
 * @param input.nowSeconds The time, in seconds since 1970.
 */
export function assess(input: {
  readonly facts: LightClientFacts;
  readonly source: SourceFacts;
  readonly history: SourceHistory;
  readonly policy: Policy;
  readonly nowSeconds: number;
}): Assessment {
  const { facts, source, history, policy, nowSeconds } = input;
  const perPeriod = facts.slotsPerPeriod;
  const headPeriod = periodOf(facts.headSlot, perPeriod);
  const lastKnownPeriod = headPeriod + (facts.nextCommitteeKnown ? 1 : 0);
  const currentSlot = currentSlotAt(facts, nowSeconds);
  const currentPeriod = periodOf(currentSlot, perPeriod);
  const finalizedPeriod = periodOf(source.finalizedSlot, perPeriod);
  const slotTime = (slot: number) => facts.genesisTime + slot * facts.secondsPerSlot;
  const deadlineSeconds = slotTime((lastKnownPeriod + 1) * perPeriod);
  const handoffPeriods = neededHandoffPeriods(facts, source, nowSeconds);
  const moves = source.finalizedSlot > facts.headSlot;
  const steps: Step[] = [
    ...handoffPeriods.map((period): Step => ({ kind: "handoff", period, signedBy: period, proves: period + 1 })),
    ...(moves ? [{ kind: "latest", period: finalizedPeriod, signedBy: currentPeriod } as const] : []),
  ];
  const base = {
    headPeriod,
    periodsKnown: range(headPeriod, lastKnownPeriod + 1),
    lastKnownPeriod,
    currentSlot,
    currentPeriod,
    finalizedPeriod,
    periodsBehind: Math.max(0, currentPeriod - headPeriod),
    headAgeSeconds: Math.max(0, nowSeconds - slotTime(facts.headSlot)),
    deadlineSeconds,
    secondsUntilDeadline: deadlineSeconds - nowSeconds,
    handoffPeriods,
    steps,
    proofs: steps.length === 0 ? 0 : Math.ceil(steps.length / MAX_FOLD_UPDATES),
    waitForFinality: currentPeriod > finalizedPeriod,
  };

  if (handoffPeriods.length > 0) {
    if (history.kind === "serves") {
      const count = handoffPeriods.length;
      return {
        ...base,
        verdict: "needs-stepping",
        reason: `the source signs in period ${currentPeriod} and the light client stores committees up to ${lastKnownPeriod}: ${count} handoff ${count === 1 ? "step" : "steps"} (${count === 1 ? "period" : "periods"} ${handoffPeriods.join(", ")}) in ${base.proofs} ${base.proofs === 1 ? "proof" : "proofs"}`,
      };
    }
    const missing = history.kind === "missing" ? history.period : (handoffPeriods[0] as number);
    const tried = history.kind === "missing" && history.tried !== undefined && history.tried.length > 0 ? history.tried : null;
    const nobody = tried === null ? "the source node gives no handoff update" : "no source has the handoff update";
    return {
      ...base,
      verdict: "stranded",
      reason: `the light client stores committees up to period ${lastKnownPeriod}, the source signs in period ${currentPeriod}, and ${nobody} for period ${missing}: no proof can move it${tried === null ? "" : `. Tried: ${tried.join("; ")}`}`,
    };
  }
  if (!moves) return { ...base, verdict: "fresh", reason: "the head is the newest finalized header" };
  if (base.waitForFinality) {
    return { ...base, verdict: "needs-keep-alive", reason: `the source crossed into period ${currentPeriod}; wait until finality crosses too, then prove` };
  }
  if (base.secondsUntilDeadline < policy.marginSeconds) {
    return { ...base, verdict: "needs-keep-alive", reason: `the deadline is ${formatHours(base.secondsUntilDeadline)} away, inside the margin of ${formatHours(policy.marginSeconds)}` };
  }
  if (base.headAgeSeconds > policy.keepAliveSeconds) {
    return { ...base, verdict: "needs-keep-alive", reason: `the head is ${formatHours(base.headAgeSeconds)} old, past the keep-alive age of ${formatHours(policy.keepAliveSeconds)}` };
  }
  return { ...base, verdict: "fresh", reason: `the head is ${formatHours(base.headAgeSeconds)} old and the deadline is ${formatHours(base.secondsUntilDeadline)} away` };
}

/**
 * When a light client strands if no proof lands: the first second of the period after the last committee it stores.
 * From then on its own committees verify no new update, and only handoff updates (from a beacon node or the handoff
 * archive) can move it. Pure: the facts of the contract are enough, no beacon node is asked.
 */
export type Deadline = {
  readonly headSlot: number;
  readonly headPeriod: number;
  /** The highest period whose committee the light client stores. */
  readonly lastKnownPeriod: number;
  /** The period it strands in: `lastKnownPeriod + 1`. */
  readonly strandPeriod: number;
  /** Seconds since 1970. */
  readonly deadlineSeconds: number;
  /** Negative once the deadline passed. */
  readonly secondsLeft: number;
};

/** The {@link Deadline} of a light client at `nowSeconds`. */
export function deadlineOf(facts: LightClientFacts, nowSeconds: number): Deadline {
  const headPeriod = periodOf(facts.headSlot, facts.slotsPerPeriod);
  const lastKnownPeriod = headPeriod + (facts.nextCommitteeKnown ? 1 : 0);
  const deadlineSeconds = facts.genesisTime + (lastKnownPeriod + 1) * facts.slotsPerPeriod * facts.secondsPerSlot;
  return { headSlot: facts.headSlot, headPeriod, lastKnownPeriod, strandPeriod: lastKnownPeriod + 1, deadlineSeconds, secondsLeft: deadlineSeconds - nowSeconds };
}

/** Hours with one decimal, such as `12.5 h`. */
export function formatHours(seconds: number): string {
  return `${(seconds / 3600).toFixed(1)} h`;
}

/** The exit code of a verdict: 0 fresh, 10 needs a keep-alive, 11 needs stepping, 12 stranded. */
export const VERDICT_EXIT_CODES: Readonly<Record<Verdict, number>> = {
  fresh: 0,
  "needs-keep-alive": 10,
  "needs-stepping": 11,
  stranded: 12,
};

/** The exit code when a chain or a beacon node could not be read. */
export const EXIT_READ_FAILED = 3;

/** The worse of two exit codes: stranded first, then a failed read, then stepping, keep-alive and fresh. */
export function worseExitCode(left: number, right: number): number {
  const rank = (code: number) => [0, 10, 11, EXIT_READ_FAILED, 12].indexOf(code);
  const known = (code: number) => (rank(code) === -1 ? 99 : rank(code));
  return known(left) >= known(right) ? left : right;
}
