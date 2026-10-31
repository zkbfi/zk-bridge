import type { Hex } from "viem";

/**
 * The guard in front of the local proof check (B-4, K-5).
 *
 * The head of a light client is public, so anyone can post a forged proof that names it: such a proof passes every
 * cheap check of the intake and reaches the verifier, which spawns a process. A flood of distinct forgeries would keep
 * the verifier busy. The guard bounds that cost in two ways:
 *
 * - It remembers the payloads that failed the check at the current head, and refuses a repeat without a new check. The
 *   memory is cleared when the head moves, because a proof is only ever checked against the head that it starts at.
 * - It caps the checks per minute, for all sources together and for each source. A check over a cap is dropped, not
 *   queued: the payload is refused as `verify-budget-exhausted`, a refusal that may pass on a later look. The drops are
 *   counted, and logged at most once per source and minute.
 */

/** The width of the window in which the checks are counted. */
export const VERIFY_WINDOW_MILLISECONDS = 60_000;

/** The limits of a {@link VerifyGuard}. */
export interface VerifyLimits {
  /** How many local checks all sources together may run in one minute. */
  readonly perMinute: number;
  /** How many local checks one source may run in one minute. */
  readonly perSourcePerMinute: number;
  /** How many refused payloads the guard remembers for the current head. The oldest goes first. */
  readonly refusalsRemembered: number;
}

/**
 * The default limits. An honest publisher posts a proof every few minutes and posts it again a few times, so an honest
 * load is a few checks a minute. A check of a real proof takes about a second of one core at most.
 */
export const DEFAULT_VERIFY_LIMITS: VerifyLimits = { perMinute: 30, perSourcePerMinute: 20, refusalsRemembered: 4096 };

/** The head that a proof is checked against. */
export interface GuardHead {
  readonly headSlot: bigint;
  readonly headRoot: Hex;
}

/** What the guard says about a check that the intake is about to run. */
export type VerifyAdmission =
  | { readonly kind: "check" }
  | { readonly kind: "refused-before" }
  | { readonly kind: "dropped"; readonly scope: "all" | "source" };

/** The guard in front of the local proof check. One guard serves every intake path of one process. */
export interface VerifyGuard {
  /** Asks to run one local check of `key` (the payload key) for `source`, against `head`. A `check` answer counts. */
  admit(input: { readonly key: Hex; readonly head: GuardHead; readonly source: string }): VerifyAdmission;
  /** Remembers that the payload failed the check at this head. */
  refused(input: { readonly key: Hex; readonly head: GuardHead }): void;
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

/** Builds a guard. It keeps everything in memory: a restart starts with a full budget and no refusals. */
export function createVerifyGuard(input: VerifyGuardInput): VerifyGuard {
  const limits = input.limits ?? DEFAULT_VERIFY_LIMITS;
  const allChecks: number[] = [];
  const checksBySource = new Map<string, number[]>();
  const droppedBySource: Record<string, number> = {};
  const loggedAt = new Map<string, number>();
  let droppedTotal = 0;
  let refusalHead: string | null = null;
  const refusals = new Set<Hex>();

  const headText = (head: GuardHead): string => `${head.headSlot}:${head.headRoot.toLowerCase()}`;

  /** Drops the times that left the window. The arrays are in time order and never longer than their cap. */
  const recent = (times: number[], since: number): number[] => {
    while (times.length > 0 && (times[0] as number) <= since) times.shift();
    return times;
  };

  const drop = (source: string, scope: "all" | "source", current: number): VerifyAdmission => {
    droppedTotal += 1;
    droppedBySource[source] = (droppedBySource[source] ?? 0) + 1;
    const last = loggedAt.get(source);
    if (last === undefined || current - last >= VERIFY_WINDOW_MILLISECONDS) {
      loggedAt.set(source, current);
      input.logger?.warn("proof_verify_dropped", { source, scope, droppedFromSource: droppedBySource[source], droppedTotal });
    }
    return { kind: "dropped", scope };
  };

  return {
    admit({ key, head, source }) {
      if (refusalHead === headText(head) && refusals.has(key)) return { kind: "refused-before" };
      const current = input.now();
      const since = current - VERIFY_WINDOW_MILLISECONDS;
      const ofSource = recent(checksBySource.get(source) ?? [], since);
      checksBySource.set(source, ofSource);
      if (ofSource.length >= limits.perSourcePerMinute) return drop(source, "source", current);
      if (recent(allChecks, since).length >= limits.perMinute) return drop(source, "all", current);
      ofSource.push(current);
      allChecks.push(current);
      return { kind: "check" };
    },
    refused({ key, head }) {
      const text = headText(head);
      if (refusalHead !== text) {
        refusalHead = text;
        refusals.clear();
      }
      refusals.add(key);
      while (refusals.size > limits.refusalsRemembered) refusals.delete(refusals.values().next().value as Hex);
    },
    dropped() {
      return { total: droppedTotal, bySource: { ...droppedBySource } };
    },
  };
}
