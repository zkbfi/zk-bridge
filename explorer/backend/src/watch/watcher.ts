/**
 * The watcher of one proof direction. On each new finalized header of the source chain it decides whether a proof is
 * due ({@link decideProof}) and starts the job through the request service, which applies every gate of a request. On
 * a timer it wakes the remote prover a learned lead time before a proof is expected and keeps the worker warm until the
 * job starts ({@link warmupStep}), so a worker is ready when the job starts.
 */
import type { Hex } from "viem";
import type { ProofDirection } from "@zk-bridge/shared";
import { neededHandoffPeriods, type LightClientFacts, type Policy, type SourceHistory } from "../keepalive/plan.ts";
import type { Logger } from "../logger.ts";
import type { Job } from "../requests/jobs.ts";
import type { ProofRequest, SubmitResult } from "../requests/service.ts";
import { decideProof, slotAtTime, warmupPlan, type PendingProof, type WaitingMessage } from "./decide.ts";
import type { FinalityObservation } from "./feed.ts";
import { COLD_START_FLOOR_SECONDS, IDLE, nextHoldAt, warmupStep, type WarmupConfig, type WarmupEnd, type WarmupSession, type WarmupTarget } from "./warmup.ts";
import type { WarmupStore } from "./warmup-store.ts";

/** The caller key of the watcher's requests. The rate limits count it like any caller. */
export const WATCH_CALLER = "watch";

/** How long to wait before asking again after the indexer said there is nothing to prove (it may lag a block). */
export const REFUSED_RETRY_SECONDS = 15;

/** How often a refusal of the indexer is retried for one finalized header. */
export const REFUSED_RETRIES = 3;

/** How long a light-client reading serves the warm-up planner, in milliseconds. */
export const FACTS_REUSE_MILLISECONDS = 60_000;

/** A message of the direction, as the indexer lists it: its identifier and the time of its source block. */
export type ListedMessage = { readonly messageId: Hex; readonly timestamp: number };

/** Input of {@link createDirectionWatcher}. */
export type DirectionWatcherInput = {
  readonly pairName: string;
  readonly direction: ProofDirection;
  readonly sourceChainId: number;
  /** The destination light client. */
  readonly readFacts: () => Promise<LightClientFacts>;
  /** The messages of the direction that the indexer shows as sent or waiting for finality. */
  readonly readMessages: () => Promise<readonly ListedMessage[]>;
  /** Whether the source serves the handoff updates of these periods. */
  readonly readHistory: (periods: readonly number[], slotsPerPeriod: number) => Promise<SourceHistory>;
  readonly findActiveJob: () => Job | null;
  readonly findLatestJob: () => Job | null;
  readonly submit: (request: ProofRequest) => Promise<SubmitResult>;
  /** Pings the remote prover and answers the HTTP status, or null when warm-ups are off. */
  readonly ping: (() => Promise<number>) | null;
  readonly policy: Policy;
  readonly minParticipants: number;
  readonly warmup: WarmupConfig;
  /** The observed times to ready and the warm-up sessions, in the backend database. */
  readonly warmupStore: WarmupStore;
  /** A refusal with a longer wait than this is left to the next finalized header. */
  readonly maxRetrySeconds: number;
  readonly logger: Logger;
  /** Milliseconds since 1970. */
  readonly now: () => number;
};

/** A running watcher. */
export interface DirectionWatcher {
  /** Takes a new reading of the feed. Readings are handled one at a time; only the newest waiting one is kept. */
  observe(observation: FinalityObservation): void;
  /** Reads the messages and starts, holds or ends the warm-up of the remote prover. */
  scan(): Promise<void>;
  /** Resolves when no reading is being handled. */
  settled(): Promise<void>;
  /** Cancels the retry timer and waits for the running work. */
  stop(): Promise<void>;
}

/** A warm-up session that runs. */
type ActiveSession = Exclude<WarmupSession, { phase: "idle" }>;

/** The proof the backend made for the direction that waits to land: the newest job, once its proof exists. */
export function pendingProofOf(job: Job | null): PendingProof | null {
  if (job === null || (job.status !== "proving" && job.status !== "published") || job.startSlot === null || job.newSlot === null) return null;
  return { startSlot: Number(job.startSlot), newSlot: Number(job.newSlot) };
}

/** Builds the watcher of one direction. */
export function createDirectionWatcher(input: DirectionWatcherInput): DirectionWatcher {
  const { direction, logger, now } = input;
  /** The newest finalized slot for which a job started or joined: nothing at or below it starts another. */
  let doneSlot = -1;
  let running: Promise<void> | null = null;
  let waiting: { observation: FinalityObservation; attempt: number } | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let lastSeen = "";
  let known: { facts: LightClientFacts; at: number; finalizedSlot: number; history: SourceHistory } | null = null;
  let session: WarmupSession = IDLE;
  let scanFailing = false;
  /** Whether a warm-up ping waits for its answer: never more than one per direction. */
  let pingOutstanding = false;
  /** Wakes the scan when a warm worker needs its next ping, which may come before the next scan. */
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  /** The target whose start the daily cap refused, logged once. */
  let cappedAt: number | null = null;
  /**
   * The sync-committee period of the source's finality when this watcher last started a keep-alive. Another keep-alive
   * in the same period starts only once the head is older than the keep-alive age: a guard against a planner that keeps
   * calling for proofs that cannot hand off.
   */
  let keepAlivePeriod: number | null = null;

  const toWaiting = (messages: readonly ListedMessage[], facts: LightClientFacts): WaitingMessage[] =>
    messages.map((message) => ({ messageId: message.messageId, slot: slotAtTime(message.timestamp, facts) }));

  // At most one retry waits: a retry is set only while handling, and a new reading clears the waiting one first.
  function retry(observation: FinalityObservation, attempt: number, seconds: number): void {
    retryTimer = setTimeout(() => {
      retryTimer = null;
      enqueue(observation, attempt);
    }, seconds * 1000);
    retryTimer.unref();
  }

  async function handle(observation: FinalityObservation, attempt: number): Promise<void> {
    if (observation.finalizedSlot <= doneSlot) return;
    let facts: LightClientFacts;
    let listed: readonly ListedMessage[];
    let history: SourceHistory = { kind: "not-needed" };
    const nowSeconds = now() / 1000;
    try {
      [facts, listed] = await Promise.all([input.readFacts(), input.readMessages()]);
      const periods = neededHandoffPeriods(facts, { finalizedSlot: observation.finalizedSlot }, nowSeconds);
      if (periods.length > 0) history = await input.readHistory(periods, facts.slotsPerPeriod);
    } catch (error) {
      logger.warn("watch_read_failed", { direction, finalizedSlot: observation.finalizedSlot, error, retryInSeconds: REFUSED_RETRY_SECONDS });
      retry(observation, attempt, REFUSED_RETRY_SECONDS);
      return;
    }
    known = { facts, at: now(), finalizedSlot: observation.finalizedSlot, history };
    const seen = `${observation.finalizedSlot}/${observation.participants}`;
    if (seen !== lastSeen) {
      lastSeen = seen;
      const signedAt = observation.signatureSlot === null ? null : (facts.genesisTime + observation.signatureSlot * facts.secondsPerSlot) * 1000;
      logger.info("finality_seen", {
        direction,
        chainId: input.sourceChainId,
        finalizedSlot: observation.finalizedSlot,
        signatureSlot: observation.signatureSlot,
        participants: observation.participants,
        source: observation.source,
        latencyMs: signedAt === null ? null : observation.receivedAt - signedAt,
      });
    }
    const pendingProof = pendingProofOf(input.findLatestJob());
    const decision = decideProof({
      finalizedSlot: observation.finalizedSlot,
      participants: observation.participants,
      minParticipants: input.minParticipants,
      facts,
      messages: toWaiting(listed, facts),
      pendingProof,
      history,
      policy: input.policy,
      nowSeconds,
    });
    if (!decision.due) {
      const level = decision.why === "stranded" ? "warn" : decision.why === "insufficient-signatures" ? "info" : "debug";
      logger[level]("proof_not_due", { direction, finalizedSlot: observation.finalizedSlot, why: decision.why, detail: decision.detail });
      return;
    }
    const finalizedPeriod = Math.floor(observation.finalizedSlot / facts.slotsPerPeriod);
    if (decision.why === "keep-alive" && keepAlivePeriod === finalizedPeriod) {
      const headAge = nowSeconds - (facts.genesisTime + facts.headSlot * facts.secondsPerSlot);
      if (headAge <= input.policy.keepAliveSeconds) {
        logger.info("proof_not_due", { direction, finalizedSlot: observation.finalizedSlot, why: "keep-alive-this-period", detail: `a keep-alive already started while the source's finality was in period ${finalizedPeriod}, and the head is younger than the keep-alive age` });
        return;
      }
    }
    logger.info("proof_due", { direction, finalizedSlot: observation.finalizedSlot, why: decision.why, detail: decision.detail, attempt });
    const active = input.findActiveJob();
    if (active !== null) {
      logger.info("proof_due_job_active", { direction, jobId: active.id });
      doneSlot = observation.finalizedSlot;
      return;
    }
    const result = await input.submit({
      pair: input.pairName,
      direction,
      reason: "finality",
      caller: WATCH_CALLER,
      ...(decision.why === "message" ? { messageId: decision.messageIds[0] as Hex } : decision.handoff ? { plannedHandoff: true } : {}),
      since: observation.receivedAt,
    });
    if (!("refused" in result)) {
      doneSlot = observation.finalizedSlot;
      if (decision.why === "keep-alive") keepAlivePeriod = finalizedPeriod;
      return;
    }
    if (result.refused === "nothing-to-prove") {
      const again = attempt < REFUSED_RETRIES;
      logger.warn("proof_due_refused", { direction, refused: result.refused, retryInSeconds: again ? REFUSED_RETRY_SECONDS : null });
      if (again) retry(observation, attempt + 1, REFUSED_RETRY_SECONDS);
      return;
    }
    const again = result.retryAfterSeconds <= input.maxRetrySeconds;
    logger.info("proof_due_refused", { direction, refused: result.refused, retryInSeconds: again ? result.retryAfterSeconds : null });
    if (again) retry(observation, attempt + 1, result.retryAfterSeconds);
  }

  function enqueue(observation: FinalityObservation, attempt: number): void {
    if (stopped) return;
    // A newer reading replaces a scheduled retry of an older one.
    if (attempt === 0 && retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    // A retry never overtakes a newer reading: the newer one cleared its timer above.
    waiting = { observation, attempt };
    if (running !== null) return;
    running = (async () => {
      while (waiting !== null && !stopped) {
        const next = waiting;
        waiting = null;
        try {
          await handle(next.observation, next.attempt);
        } catch (error) {
          logger.error("watch_failed", { direction, error });
        }
      }
      running = null;
    })();
  }

  const seconds = (milliseconds: number) => Math.round(milliseconds) / 1000;

  /** Ends the running session. Only called while one runs. */
  function endSession(reason: WarmupEnd | "timeout", at: number): void {
    const ending = session as ActiveSession;
    input.warmupStore.endSession(ending.id, reason, at * 1000);
    const warmSeconds = Math.round(at - ending.startedAt);
    const fields = { direction, why: ending.target.why, warmSeconds, ready: ending.phase === "warm", dueInSeconds: Math.round(ending.target.at - at) };
    if (reason === "used") logger.info("warmup_used", { ...fields, readyBeforeDueSeconds: ending.phase === "warm" ? Math.round(ending.target.at - ending.readyAt) : null });
    else if (reason !== "timeout") logger.info("warmup_wasted", { ...fields, reason, holds: ending.phase === "warm" ? ending.holds : 0 });
    session = { phase: "idle", timedOutAt: reason === "timeout" ? at : null };
  }

  function scheduleHold(): void {
    if (holdTimer !== null) clearTimeout(holdTimer);
    holdTimer = null;
    if (session.phase !== "warm" || stopped) return;
    const wait = Math.max(0, nextHoldAt(session, input.warmup) * 1000 - now());
    holdTimer = setTimeout(() => {
      holdTimer = null;
      void scan();
    }, wait);
    holdTimer.unref();
  }

  /** Sends one ping for the running session and applies its answer. Only called while a session runs. */
  async function sendPing(ping: () => Promise<number>, kind: "start" | "repeat" | "hold"): Promise<void> {
    const { id, startedAt, target } = session as ActiveSession;
    const sentAt = now() / 1000;
    pingOutstanding = true;
    try {
      const status = await ping();
      const answeredAt = now() / 1000;
      const current = session.phase !== "idle" && session.id === id ? session : null;
      if (status !== 200) {
        if (current !== null) session = { ...current, lastPingAt: answeredAt };
        logger.info("warmup_ping", { direction, why: target.why, kind, status, secondsToDue: Math.round(target.at - answeredAt) });
        return;
      }
      // A hold goes out only while the session is warm. Answered after the session ended, it changes nothing.
      if (kind === "hold") {
        if (current?.phase === "warm") {
          session = { ...current, lastReadyAt: answeredAt, lastPingAt: answeredAt, holds: current.holds + 1 };
          logger.info("warmup_held", { direction, why: target.why, holds: current.holds + 1, secondsToDue: Math.round(target.at - answeredAt), answerSeconds: seconds((answeredAt - sentAt) * 1000) });
        }
        return;
      }
      // The first ready answer of the session: how long the worker took, from the session's first ping.
      const readySeconds = seconds((answeredAt - startedAt) * 1000);
      const cold = readySeconds >= COLD_START_FLOOR_SECONDS;
      if (cold) input.warmupStore.recordObservation({ direction, source: "ping", seconds: readySeconds, at: answeredAt * 1000 });
      if (current !== null) {
        input.warmupStore.markReady(id, answeredAt * 1000);
        session = { phase: "warm", id, target, startedAt, readyAt: answeredAt, lastReadyAt: answeredAt, lastPingAt: answeredAt, holds: 0 };
      }
      logger.info("warmup_ready", { direction, why: target.why, readySeconds, cold, secondsToDue: Math.round(target.at - answeredAt), sessionEnded: current === null });
    } catch (error) {
      const answeredAt = now() / 1000;
      const current = session.phase !== "idle" && session.id === id ? session : null;
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        // The endpoint held the ping longer than we wait: a cold start at least this long. No new session for the gap.
        const waitedSeconds = Math.round(answeredAt - startedAt);
        input.warmupStore.recordObservation({ direction, source: "ping-timeout", seconds: waitedSeconds, at: answeredAt * 1000 });
        logger.info("warmup_ping_timeout", { direction, why: target.why, waitedSeconds, secondsToDue: Math.round(target.at - answeredAt) });
        if (current !== null) endSession("timeout", answeredAt);
      } else {
        if (current !== null) session = { ...current, lastPingAt: answeredAt };
        logger.warn("warmup_ping_failed", { direction, why: target.why, kind, error });
      }
    } finally {
      pingOutstanding = false;
      scheduleHold();
    }
  }

  async function scan(): Promise<void> {
    const ping = input.ping;
    if (ping === null || stopped) return;
    let action: ReturnType<typeof warmupStep>;
    let nowSeconds: number;
    let lead: ReturnType<WarmupStore["lead"]>;
    try {
      if (known === null || now() - known.at >= FACTS_REUSE_MILLISECONDS) {
        const fresh = await input.readFacts();
        known = { finalizedSlot: 0, history: { kind: "not-needed" }, ...known, facts: fresh, at: now() };
      }
      const { facts } = known;
      const messages = toWaiting(await input.readMessages(), facts);
      nowSeconds = now() / 1000;
      lead = input.warmupStore.lead(input.warmup);
      const plan = warmupPlan({ facts, finalizedSlot: known.finalizedSlot, messages, pendingProof: pendingProofOf(input.findLatestJob()), history: known.history, policy: input.policy, nowSeconds, horizonSeconds: lead.seconds });
      const capReached = input.warmupStore.warmSecondsInWindow(nowSeconds * 1000) >= input.warmup.dailyCapSeconds;
      action = warmupStep({ nowSeconds, targets: plan.targets, live: plan.live, session, config: input.warmup, leadSeconds: lead.seconds, jobActive: input.findActiveJob() !== null, pingOutstanding, capReached });
      scanFailing = false;
    } catch (error) {
      if (!scanFailing) logger.warn("watch_scan_failed", { direction, error });
      scanFailing = true;
      return;
    }
    switch (action.kind) {
      case "none":
        return;
      case "end":
        endSession(action.reason, nowSeconds);
        scheduleHold();
        return;
      case "capped":
        if (cappedAt !== action.target.at) logger.warn("warmup_capped", { direction, why: action.target.why, dueInSeconds: Math.round(action.target.at - nowSeconds), dailyCapSeconds: input.warmup.dailyCapSeconds });
        cappedAt = action.target.at;
        return;
      case "start":
        startSession(action.target, nowSeconds, lead);
        return sendPing(ping, "start");
      default:
        return sendPing(ping, action.kind);
    }
  }

  function startSession(target: WarmupTarget, at: number, lead: ReturnType<WarmupStore["lead"]>): void {
    const id = input.warmupStore.openSession({ direction, why: target.why, dueAt: target.at * 1000, leadSeconds: lead.seconds, at: at * 1000 });
    session = { phase: "warming", id, target, startedAt: at, lastPingAt: at };
    logger.info("warmup_scheduled", { direction, why: target.why, dueAt: new Date(target.at * 1000).toISOString(), dueInSeconds: Math.round(target.at - at), leadSeconds: lead.seconds, leadBasis: lead.basis, observations: lead.observations });
  }

  return {
    observe: (observation) => enqueue(observation, 0),
    scan,
    async settled() {
      while (running !== null) await running;
    },
    async stop() {
      stopped = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      if (holdTimer !== null) clearTimeout(holdTimer);
      while (running !== null) await running;
    },
  };
}
