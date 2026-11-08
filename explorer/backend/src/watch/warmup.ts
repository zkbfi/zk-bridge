/**
 * When to wake the remote prover, and how long to keep it awake. Pure: no network, no clock, no database.
 *
 * The lead time is learned: a p75 (`leadP`) plus a few seconds of the time a worker took to answer ready, from the warm-up pings and from the jobs
 * that met a cold worker. A session starts that long before a proof is due, and once a worker answers ready it is kept
 * warm by a cheap ping just before the endpoint's idle timeout would stop it, until the job starts, the message is
 * covered, or the due time is past by the grace.
 */

/** A time at which a proof is expected to start. `keys` name what the proof is for: message identifiers, or a handoff. */
export type WarmupTarget = { readonly at: number; readonly why: "message" | "keep-alive"; readonly keys: readonly string[] };

/**
 * What an early start is for: the reason and the sorted keys it waits for. One direction starts at most one early worker
 * per prediction, however the predicted time moves (a late finality moves it to "now" again and again).
 */
export function predictionOf(target: WarmupTarget): string {
  return `${target.why}:${[...target.keys].sort().join(",")}`;
}

/** The warm-up settings (`watch.warmup`). Seconds unless named otherwise. */
export type WarmupConfig = {
  /** The quantile of the observed times to ready that the lead time takes. */
  readonly leadP: number;
  /** Added to that quantile: a few seconds so that the proof rarely waits for a worker that is almost ready. */
  readonly leadMarginSeconds: number;
  /** How many of the newest observations count. */
  readonly leadObservations: number;
  /** The lead time before there is any observation. */
  readonly defaultLeadSeconds: number;
  readonly minLeadSeconds: number;
  readonly maxLeadSeconds: number;
  /**
   * After a ready answer, ping again this long after it to keep the worker. Keep it below the endpoint's idle timeout
   * (60 s) by a margin that covers a slow answer.
   */
  readonly holdIntervalSeconds: number;
  /** While no worker is ready (the endpoint answered 204, or the ping failed), ping again this often. */
  readonly intervalSeconds: number;
  /** A session ends this long after its due time when no job started. */
  readonly graceSeconds: number;
  /** The endpoint's idle timeout: a worker stays up, and billed, this long after its last request. For the cost estimate. */
  readonly idleTimeoutSeconds: number;
  /** What the remote GPU costs per hour, in USD, for the cost estimate. */
  readonly gpuUsdPerHour: number;
  /** No new session starts within this long of a ping that timed out. */
  readonly minGapSeconds: number;
  /** The most seconds of warm-up sessions, both directions together, in any 24 hours. */
  readonly dailyCapSeconds: number;
  /** How long one ping may wait: the load-balancing endpoint holds it while a worker starts. */
  readonly pingTimeoutSeconds: number;
};

/** The defaults. */
export const DEFAULT_WARMUP: WarmupConfig = {
  leadP: 0.75,
  leadMarginSeconds: 5,
  leadObservations: 20,
  defaultLeadSeconds: 90,
  minLeadSeconds: 20,
  maxLeadSeconds: 600,
  holdIntervalSeconds: 40,
  intervalSeconds: 30,
  graceSeconds: 45,
  idleTimeoutSeconds: 60,
  gpuUsdPerHour: 2.25,
  minGapSeconds: 300,
  dailyCapSeconds: 3600,
  pingTimeoutSeconds: 300,
};

/**
 * A ready answer faster than this found a worker that was up already: it says nothing about a cold start and is not
 * kept as an observation.
 */
export const COLD_START_FLOOR_SECONDS = 5;

/** The lead time and what it rests on. */
export type Lead = { readonly seconds: number; readonly basis: "default" | "observed"; readonly observations: number };

/**
 * The lead time: the `leadP` quantile (nearest rank) of the newest `leadObservations` times to ready, plus `leadMarginSeconds`, clamped to
 * [`minLeadSeconds`, `maxLeadSeconds`]; the default, clamped the same way, while there is none.
 *
 * @param observations Seconds to ready, newest first.
 */
export function leadFrom(observations: readonly number[], config: WarmupConfig): Lead {
  const clamp = (seconds: number) => Math.min(config.maxLeadSeconds, Math.max(config.minLeadSeconds, Math.ceil(seconds)));
  const recent = observations.slice(0, config.leadObservations);
  if (recent.length === 0) return { seconds: clamp(config.defaultLeadSeconds), basis: "default", observations: 0 };
  const sorted = [...recent].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(config.leadP * sorted.length));
  return { seconds: clamp((sorted[rank - 1] as number) + config.leadMarginSeconds), basis: "observed", observations: sorted.length };
}

/**
 * The warm-up of one direction. `warming`: the first ping went out and no worker answered ready yet. `warm`: a worker
 * answered ready at `readyAt`, and last at `lastReadyAt`. `lastPingAt`: the last answer of any kind, or failure.
 */
export type WarmupSession =
  | { readonly phase: "idle"; readonly timedOutAt: number | null }
  | { readonly phase: "warming"; readonly id: string; readonly target: WarmupTarget; readonly startedAt: number; readonly lastPingAt: number }
  | {
      readonly phase: "warm";
      readonly id: string;
      readonly target: WarmupTarget;
      readonly startedAt: number;
      readonly readyAt: number;
      readonly lastReadyAt: number;
      readonly lastPingAt: number;
      readonly holds: number;
    };

/** No session yet. */
export const IDLE: WarmupSession = { phase: "idle", timedOutAt: null };

/**
 * Why a session ended. `used`: the job started. The others wasted the warm-up. `unusable`: the decision that the real
 * proof follows says no proof is due (the minimum interval, the retry wait, a thin finality), or not before the lead
 * time and the worker's wait: ended at once, not held to the grace.
 */
export type WarmupEnd = "used" | "covered" | "grace" | "cap" | "unusable";

/** What to do now. */
export type WarmupAction =
  | { readonly kind: "none" }
  | { readonly kind: "start"; readonly target: WarmupTarget }
  /** A target is within the lead time, but the daily cap is spent. */
  | { readonly kind: "capped"; readonly target: WarmupTarget }
  /** A target is within the lead time, but its prediction had an early start already: none follows, the job starts when finality is seen. */
  | { readonly kind: "skipped"; readonly target: WarmupTarget }
  /** Ping again: no worker is ready yet. */
  | { readonly kind: "repeat" }
  /** Ping a ready worker before its idle timeout. */
  | { readonly kind: "hold" }
  | { readonly kind: "end"; readonly reason: WarmupEnd };

/** When a warm session pings next: the hold interval after the last ready answer, and the interval after any answer. */
export function nextHoldAt(session: Extract<WarmupSession, { phase: "warm" }>, config: WarmupConfig): number {
  return Math.max(session.lastReadyAt + config.holdIntervalSeconds, session.lastPingAt + Math.min(config.intervalSeconds, config.holdIntervalSeconds));
}

/** Input of {@link warmupStep}. */
export type WarmupStepInput = {
  readonly nowSeconds: number;
  /** The targets that ask for a warm worker, sorted by time. */
  readonly targets: readonly WarmupTarget[];
  /** The keys that still wait for a proof: a session whose target has none of them left ends. */
  readonly live: ReadonlySet<string>;
  readonly session: WarmupSession;
  readonly config: WarmupConfig;
  readonly leadSeconds: number;
  readonly jobActive: boolean;
  readonly pingOutstanding: boolean;
  /** Whether the warm-up seconds of the last 24 hours reached the daily cap. */
  readonly capReached: boolean;
  /** Whether an early start was made for the target's prediction already ({@link predictionOf}) and spent. */
  readonly predictionStarted: (target: WarmupTarget) => boolean;
};

/**
 * The next warm-up action of a direction.
 *
 * - A running session ends when the job starts (`used`), when none of its keys still waits (`covered`), when its due
 *   time is past by the grace (`grace`), when no proof is forecast within the lead time (`unusable`), or, while warm,
 *   when the daily cap is spent (`cap`).
 * - Otherwise, with no ping outstanding: a session without a ready worker pings again every `intervalSeconds`; a warm
 *   one pings `holdIntervalSeconds` after the last ready answer, and after a hold that was not answered ready, no
 *   sooner than `intervalSeconds` after it.
 * - With no session, no job and no ping outstanding, the first target whose start (due time minus the lead) has come,
 *   and whose due time is not past by the grace, starts a session, unless a ping timed out within `minGapSeconds` or the
 *   cap is spent. A target whose prediction had a session already (`predictionStarted`) starts none: `skipped`, and the
 *   job starts when finality is actually seen.
 */
export function warmupStep(input: WarmupStepInput): WarmupAction {
  const { nowSeconds: now, session, config } = input;
  if (session.phase !== "idle") {
    if (input.jobActive) return { kind: "end", reason: "used" };
    if (!session.target.keys.some((key) => input.live.has(key))) return { kind: "end", reason: "covered" };
    if (now > session.target.at + config.graceSeconds) return { kind: "end", reason: "grace" };
    // The plan holds the proof the decision forecasts. Without one, or one further off than the lead time and a ping
    // interval, holding the worker only costs: end now, and start again when the proof comes within the lead time.
    const planned = input.targets[0];
    if (planned === undefined || planned.at - now > input.leadSeconds + config.intervalSeconds) return { kind: "end", reason: "unusable" };
    if (input.pingOutstanding) return { kind: "none" };
    if (session.phase === "warming") return now - session.lastPingAt >= config.intervalSeconds ? { kind: "repeat" } : { kind: "none" };
    if (now < nextHoldAt(session, config)) return { kind: "none" };
    return input.capReached ? { kind: "end", reason: "cap" } : { kind: "hold" };
  }
  if (input.jobActive || input.pingOutstanding) return { kind: "none" };
  if (session.timedOutAt !== null && now - session.timedOutAt < config.minGapSeconds) return { kind: "none" };
  const target = input.targets.find((candidate) => now >= candidate.at - input.leadSeconds && now <= candidate.at + config.graceSeconds);
  if (target === undefined) return { kind: "none" };
  if (input.predictionStarted(target)) return { kind: "skipped", target };
  return input.capReached ? { kind: "capped", target } : { kind: "start", target };
}
