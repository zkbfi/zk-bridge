import type { Hex } from "viem";

/**
 * The guard in front of the local proof check (B-4, K-5).
 *
 * The head of a light client is public, so anyone can post a forged proof that names it: such a proof passes every
 * cheap check of the intake (shape, pair, direction, program key, start at the head, new slot past the head, public
 * values that agree with the header) and reaches the verifier, which spawns a process. A flood of distinct forgeries
 * would keep the verifier busy. The guard bounds that cost, per source (the board category of a direction):
 *
 * - It remembers the payloads that definitely failed the check at the current head of their source, and refuses a
 *   repeat without a new check. Each source keeps its own head and memory, so two directions never clear each other's.
 *   A source's memory is cleared when its head moves: a proof is only ever checked against the head it starts at.
 * - It caps the checks per minute: a general budget, first come, for each source and for all sources together.
 * - It keeps a reserve per source that the general budget cannot use: a check from the reserve goes only to a proof
 *   that would move the head further than every proof checked at this head of the source so far. A flood of forgeries
 *   that names the head and a slot it already claimed cannot use the reserve, so an honest proof that reaches further
 *   is still checked in the same minute.
 *
 * A check over the caps is dropped, not queued: the payload is refused as `verify-budget-exhausted`, a refusal that may
 * pass on a later look. The drops are counted, and logged at most once per source and minute.
 *
 * What the guard cannot do: tell a forgery from a valid proof that makes the same claim. Board messages carry no sender,
 * so there is no publisher to trust, and every field a forger needs is public. A forger who claims ever higher new slots
 * also passes the reserve test, once per higher slot; the light client refuses a slot after its own clock
 * (`HeadInFuture`), a check that the intake does not repeat because the head reader does not read the clock settings.
 */

/** The width of the window in which the checks are counted. */
export const VERIFY_WINDOW_MILLISECONDS = 60_000;

/** The limits of a {@link VerifyGuard}. */
export interface VerifyLimits {
  /** How many checks of the general budget all sources together may run in one minute. */
  readonly perMinute: number;
  /** How many checks of the general budget one source may run in one minute. */
  readonly perSourcePerMinute: number;
  /** How many more checks one source may run in one minute for proofs that reach further than any checked at its head. */
  readonly reservePerSourcePerMinute: number;
  /** How many refused payloads the guard remembers for the current head of one source. The oldest goes first. */
  readonly refusalsRemembered: number;
}

/**
 * The default limits. An honest publisher posts a proof every few minutes and posts it again a few times, so an honest
 * load is a few checks a minute. A check of a real proof takes about a second of one core at most.
 */
export const DEFAULT_VERIFY_LIMITS: VerifyLimits = { perMinute: 30, perSourcePerMinute: 16, reservePerSourcePerMinute: 4, refusalsRemembered: 4096 };

/** The head that a proof is checked against. */
export interface GuardHead {
  readonly headSlot: bigint;
  readonly headRoot: Hex;
}

/** What the guard says about a check that the intake is about to run. */
export type VerifyAdmission =
  | { readonly kind: "check"; readonly from: "general" | "reserve" }
  | { readonly kind: "refused-before" }
  | { readonly kind: "dropped"; readonly scope: "all" | "source" };

/** One check that the intake asks for. */
export interface VerifyRequestKey {
  /** The payload key. */
  readonly key: Hex;
  /** The head that the proof starts at. */
  readonly head: GuardHead;
  /** The slot that the proof would move the head to. */
  readonly newSlot: bigint;
  readonly source: string;
}

/** The guard in front of the local proof check. One guard serves every intake path of one process. */
export interface VerifyGuard {
  /** Asks to run one local check. A `check` answer counts against the budget. */
  admit(input: VerifyRequestKey): VerifyAdmission;
  /** Remembers that the payload definitely failed the check at this head of its source. */
  refused(input: { readonly key: Hex; readonly head: GuardHead; readonly source: string }): void;
  /** How many checks were dropped since the start, in total and by source. */
  dropped(): { readonly total: number; readonly bySource: Readonly<Record<string, number>> };
}

/** The part of a logger that the guard uses. */
export interface GuardLogger {
  warn(event: string, fields: Record<string, unknown>): void;
}

/** Input of {@link createVerifyGuard}. */
export interface VerifyGuardInput {
  /** Milliseconds since 1970. */
  readonly now: () => number;
  readonly limits?: VerifyLimits;
  readonly logger?: GuardLogger;
}

/** What the guard keeps for one source. */
type SourceState = {
  readonly general: number[];
  readonly reserve: number[];
  /** The head that the memory below belongs to. */
  head: string | null;
  readonly refusals: Set<Hex>;
  /** The highest new slot of a proof checked at `head`. */
  furthestChecked: bigint;
  dropped: number;
  loggedAt: number | null;
};

/** Builds a guard. It keeps everything in memory: a restart starts with a full budget and no refusals. */
export function createVerifyGuard(input: VerifyGuardInput): VerifyGuard {
  const limits = input.limits ?? DEFAULT_VERIFY_LIMITS;
  const allGeneral: number[] = [];
  const sources = new Map<string, SourceState>();
  let droppedTotal = 0;

  const headText = (head: GuardHead): string => `${head.headSlot}:${head.headRoot.toLowerCase()}`;

  const stateOf = (source: string): SourceState => {
    const known = sources.get(source);
    if (known !== undefined) return known;
    const created: SourceState = { general: [], reserve: [], head: null, refusals: new Set(), furthestChecked: 0n, dropped: 0, loggedAt: null };
    sources.set(source, created);
    return created;
  };

  /** Moves the memory of a source to `head`. A new head forgets the refusals and the furthest slot of the old one. */
  const atHead = (state: SourceState, head: GuardHead): void => {
    const text = headText(head);
    if (state.head === text) return;
    state.head = text;
    state.refusals.clear();
    state.furthestChecked = head.headSlot;
  };

  /** Drops the times that left the window. The arrays are in time order and never longer than their cap. */
  const recent = (times: number[], since: number): number[] => {
    while (times.length > 0 && (times[0] as number) <= since) times.shift();
    return times;
  };

  const drop = (source: string, state: SourceState, scope: "all" | "source", current: number): VerifyAdmission => {
    droppedTotal += 1;
    state.dropped += 1;
    if (state.loggedAt === null || current - state.loggedAt >= VERIFY_WINDOW_MILLISECONDS) {
      state.loggedAt = current;
      input.logger?.warn("proof_verify_dropped", { source, scope, droppedFromSource: state.dropped, droppedTotal });
    }
    return { kind: "dropped", scope };
  };

  return {
    admit({ key, head, newSlot, source }) {
      const state = stateOf(source);
      atHead(state, head);
      if (state.refusals.has(key)) return { kind: "refused-before" };
      const current = input.now();
      const since = current - VERIFY_WINDOW_MILLISECONDS;
      const take = (times: number[], from: "general" | "reserve"): VerifyAdmission => {
        times.push(current);
        if (from === "general") allGeneral.push(current);
        if (newSlot > state.furthestChecked) state.furthestChecked = newSlot;
        return { kind: "check", from };
      };
      const sourceFull = recent(state.general, since).length >= limits.perSourcePerMinute;
      const allFull = recent(allGeneral, since).length >= limits.perMinute;
      if (!sourceFull && !allFull) return take(state.general, "general");
      // The reserve serves only a proof that reaches further than every proof checked at this head.
      if (newSlot > state.furthestChecked && recent(state.reserve, since).length < limits.reservePerSourcePerMinute) return take(state.reserve, "reserve");
      return drop(source, state, sourceFull ? "source" : "all", current);
    },
    refused({ key, head, source }) {
      const state = stateOf(source);
      atHead(state, head);
      state.refusals.add(key);
      while (state.refusals.size > limits.refusalsRemembered) state.refusals.delete(state.refusals.values().next().value as Hex);
    },
    dropped() {
      const bySource: Record<string, number> = {};
      for (const [source, state] of sources) if (state.dropped > 0) bySource[source] = state.dropped;
      return { total: droppedTotal, bySource };
    },
  };
}
