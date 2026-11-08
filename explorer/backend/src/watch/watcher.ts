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
import { pendingFrom, type HeldProof } from "../requests/held-proofs.ts";
import type { Job } from "../requests/jobs.ts";
import type { ProofRequest, SubmitResult } from "../requests/service.ts";
import { usdText, type BatchRule, type Economics } from "./batch.ts";
import { decideProof, slotAtTime, warmupPlan, type PendingProof, type WaitingMessage } from "./decide.ts";
import type { DestinationToken } from "./economics.ts";
import type { DecisionOutcome, WatchDecision } from "./decisions.ts";
import type { FinalityObservation } from "./feed.ts";
import { COLD_START_FLOOR_SECONDS, IDLE, nextHoldAt, predictionOf, warmupStep, type WarmupConfig, type WarmupEnd, type WarmupSession, type WarmupTarget } from "./warmup.ts";
import type { WarmupStore } from "./warmup-store.ts";

/** The caller key of the watcher's requests. The rate limits count it like any caller. */
export const WATCH_CALLER = "watch";

/** How long to wait before asking again after the indexer said there is nothing to prove (it may lag a block). */
export const REFUSED_RETRY_SECONDS = 15;

/** How often a refusal of the indexer is retried for one finalized header. */
export const REFUSED_RETRIES = 3;

/** How long a light-client reading serves the warm-up planner, in milliseconds. */
export const FACTS_REUSE_MILLISECONDS = 60_000;

/** How long one valuation of the waiting messages serves, in milliseconds, while the same messages wait. */
export const ECONOMICS_REUSE_MILLISECONDS = 60_000;

/**
 * A message of the direction, as the indexer lists it: its identifier, the time of its source block, and the token the
 * destination releases (to value its fee).
 */
export type ListedMessage = { readonly messageId: Hex; readonly timestamp: number; readonly destinationToken?: DestinationToken | null };

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
  /** The proofs of the direction the backend has: on the board, stored by the webhook, or made by the newest job. */
  readonly readHeldProofs: () => readonly HeldProof[];
  /** A proof we have that waited to land longer than this no longer holds a new proof back. */
  readonly pendingStaleSeconds: number;
  /** When a message proof is due (`watch.minIntervalSeconds` and its overrides). */
  readonly batchRule: BatchRule;
  /**
   * When the direction's newest proof job started (milliseconds since 1970), whatever asked for it, or null. Read from
   * the jobs table on each decision, so the minimum interval survives a restart.
   */
  readonly readLastProofAt: () => number | null;
  /** Seconds until the request service admits a new job of the direction (0: now). */
  readonly readAdmitAfterSeconds: () => number;
  /** Values the waiting messages. Only asked when the rule waits. */
  readonly readEconomics: (messages: readonly ListedMessage[]) => Promise<Economics>;
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
  /** Told of each decision and, for a due one, of what came of it. `GET /directions/:direction/pipeline` shows the latest. */
  readonly onDecision?: (decision: WatchDecision) => void;
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

/** A time as ISO text, for the log. */
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

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
  let known: { facts: LightClientFacts; at: number; finalizedSlot: number; participants: number | null; history: SourceHistory } | null = null;
  let session: WarmupSession = IDLE;
  let scanFailing = false;
  /** Whether a warm-up ping waits for its answer: never more than one per direction. */
  let pingOutstanding = false;
  /** Wakes the scan when a warm worker needs its next ping, which may come before the next scan. */
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  /** The target whose start the daily cap refused, logged once. */
  let cappedAt: number | null = null;
  /** The prediction whose second early start was skipped, logged once. */
  let skippedPrediction: string | null = null;
  /**
   * The sync-committee period of the source's finality when this watcher last started a keep-alive. Another keep-alive
   * in the same period starts only once the head is older than the keep-alive age: a guard against a planner that keeps
   * calling for proofs that cannot hand off.
   */
  let keepAlivePeriod: number | null = null;
  /** Wakes the watcher when a batch that waits is due, when no new finality may come before it. */
  let batchTimer: ReturnType<typeof setTimeout> | null = null;
  let valued: { key: string; at: number; economics: Economics } | null = null;
  const waits = input.batchRule.minIntervalSeconds > 0;

  /** The pending proof we have from the head, or null. */
  const pendingAt = (headSlot: number): PendingProof | null => pendingFrom(input.readHeldProofs(), headSlot);

  /** The value of the waiting messages, read at most once a minute while they stay the same. A failed read is unknown. */
  async function economicsOf(messages: readonly ListedMessage[]): Promise<Economics> {
    const key = messages.map((message) => message.messageId).sort().join(",");
    if (valued !== null && valued.key === key && now() - valued.at < ECONOMICS_REUSE_MILLISECONDS) return valued.economics;
    let economics: Economics;
    try {
      economics = await input.readEconomics(messages);
    } catch (error) {
      logger.warn("watch_economics_failed", { direction, error });
      economics = { kind: "unknown", why: "the prices could not be read" };
    }
    valued = { key, at: now(), economics };
    return economics;
  }

  /** The batch of a decision, when the rule waits and a message the head does not cover is listed. */
  async function batchOf(listed: readonly ListedMessage[], facts: LightClientFacts) {
    const uncovered = listed.filter((message) => slotAtTime(message.timestamp, facts) > facts.headSlot);
    if (!waits || uncovered.length === 0) return undefined;
    const lastProofAt = input.readLastProofAt();
    return { rule: input.batchRule, economics: await economicsOf(uncovered), lastProofAt: lastProofAt === null ? null : lastProofAt / 1000 };
  }

  function wakeAt(seconds: number, observation: FinalityObservation): void {
    if (batchTimer !== null) clearTimeout(batchTimer);
    batchTimer = setTimeout(() => {
      batchTimer = null;
      enqueue(observation, 0);
    }, Math.max(0, seconds * 1000 - now()));
    batchTimer.unref();
  }

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
    known = { facts, at: now(), finalizedSlot: observation.finalizedSlot, participants: observation.participants, history };
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
    const pendingProof = pendingAt(facts.headSlot);
    const batch = await batchOf(listed, facts);
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
      pendingStaleSeconds: input.pendingStaleSeconds,
      ...(batch === undefined ? {} : { batch }),
    });
    const base: WatchDecision = {
      at: now(),
      finalizedSlot: observation.finalizedSlot,
      headSlot: facts.headSlot,
      genesisTime: facts.genesisTime,
      secondsPerSlot: facts.secondsPerSlot,
      due: decision.due,
      why: decision.why,
      detail: decision.detail,
    };
    const note = (extra: Partial<WatchDecision>): void => input.onDecision?.({ ...base, ...extra });
    const noteOutcome = (outcome: DecisionOutcome): void => note({ ...dueFacts, outcome });
    let dueFacts: Partial<WatchDecision> = {};
    if (!decision.due) {
      const level = decision.why === "stranded" ? "warn" : decision.why === "insufficient-signatures" || decision.why === "min-interval" || decision.why === "proof-pending" ? "info" : "debug";
      const plan = decision.plan;
      // A batch waits only for the interval since a proof: its last proof is known (with none, the batch is due).
      const batchFields = plan === undefined ? {} : { messages: plan.ready, feesUsd: plan.feesUsd === null ? null : usdText(plan.feesUsd), costUsd: plan.costUsd === null ? null : usdText(plan.costUsd), startAt: iso(plan.startAt), startWhy: plan.startWhy, lastProofAt: iso(plan.lastProofAt as number), dueAt: iso(plan.dueAt) };
      logger[level]("proof_not_due", { direction, finalizedSlot: observation.finalizedSlot, why: decision.why, detail: decision.detail, ...batchFields });
      note(
        plan === undefined
          ? {}
          : {
              batch: {
                messages: plan.ready,
                feesUsd: batchFields.feesUsd as string | null,
                costUsd: batchFields.costUsd as string | null,
                unknownWhy: plan.unknownWhy,
                oldestFinalAt: plan.oldestFinalAt * 1000,
                startAt: plan.startAt * 1000,
                startWhy: plan.startWhy,
                dueAt: plan.dueAt * 1000,
                lastProofAt: (plan.lastProofAt as number) * 1000,
              },
            },
      );
      if (plan !== undefined) wakeAt(plan.dueAt, observation);
      return;
    }
    if (decision.stalePending !== undefined) {
      const stale = decision.stalePending;
      logger.warn("proof_pending_stale", { direction, startSlot: stale.startSlot, newSlot: stale.newSlot, where: stale.where, waitedSeconds: Math.round(nowSeconds - (stale.since as number) / 1000) });
    }
    const finalizedPeriod = Math.floor(observation.finalizedSlot / facts.slotsPerPeriod);
    if (decision.why === "keep-alive" && keepAlivePeriod === finalizedPeriod) {
      const headAge = nowSeconds - (facts.genesisTime + facts.headSlot * facts.secondsPerSlot);
      if (headAge <= input.policy.keepAliveSeconds) {
        logger.info("proof_not_due", { direction, finalizedSlot: observation.finalizedSlot, why: "keep-alive-this-period", detail: `a keep-alive already started while the source's finality was in period ${finalizedPeriod}, and the head is younger than the keep-alive age` });
        noteOutcome("keep-alive-this-period");
        return;
      }
    }
    // A field a decision leaves out (no batch wait, no riders) is left out of the line.
    const extra =
      decision.why === "message"
        ? { trigger: decision.trigger, batch: decision.batch, waitedSeconds: decision.waitedSeconds, feesUsd: decision.feesUsd, costUsd: decision.costUsd }
        : { riders: decision.riders };
    logger.info("proof_due", { direction, finalizedSlot: observation.finalizedSlot, why: decision.why, detail: decision.detail, attempt, ...extra });
    if (decision.why === "message" && decision.trigger !== undefined) {
      dueFacts = { trigger: decision.trigger, batchSize: decision.batch, waitedSeconds: decision.waitedSeconds, feesUsd: decision.feesUsd, costUsd: decision.costUsd };
    }
    const active = input.findActiveJob();
    if (active !== null) {
      noteOutcome("job-active");
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
      // The proof this finality calls for: from the head to this slot. The service never starts it twice.
      target: { startSlot: facts.headSlot, newSlot: observation.finalizedSlot },
    });
    noteOutcome("refused" in result ? result.refused : "job-started");
    if (!("refused" in result)) {
      doneSlot = observation.finalizedSlot;
      if (decision.why === "keep-alive") keepAlivePeriod = finalizedPeriod;
      return;
    }
    if (result.refused === "duplicate") {
      logger.info("proof_due_refused", { direction, refused: result.refused, retryInSeconds: null });
      doneSlot = observation.finalizedSlot;
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
    input.warmupStore.endSession(ending.id, reason, at * 1000, input.warmup.idleTimeoutSeconds);
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
        known = { finalizedSlot: 0, participants: null, history: { kind: "not-needed" }, ...known, facts: fresh, at: now() };
      }
      const { facts } = known;
      const listed = await input.readMessages();
      const messages = toWaiting(listed, facts);
      const batch = await batchOf(listed, facts);
      nowSeconds = now() / 1000;
      lead = input.warmupStore.lead(input.warmup);
      // The same decision as the real proof, asked for the moments ahead: see warmupPlan.
      const plan = warmupPlan({
        facts,
        finalizedSlot: known.finalizedSlot,
        participants: known.finalizedSlot === 0 ? undefined : known.participants,
        minParticipants: input.minParticipants,
        messages,
        pendingProof: pendingAt(facts.headSlot),
        history: known.history,
        policy: input.policy,
        nowSeconds,
        pendingStaleSeconds: input.pendingStaleSeconds,
        horizonSeconds: lead.seconds,
        admitAtSeconds: nowSeconds + (input.readAdmitAfterSeconds()),
        doneSlot,
        keepAlivePeriod,
        ...(batch === undefined ? {} : { batch }),
      });
      const capReached = input.warmupStore.warmSecondsInWindow(nowSeconds * 1000) >= input.warmup.dailyCapSeconds;
      action = warmupStep({ nowSeconds, targets: plan.targets, live: plan.live, session, config: input.warmup, leadSeconds: lead.seconds, jobActive: input.findActiveJob() !== null, pingOutstanding, capReached, predictionStarted: (target) => input.warmupStore.predictionStarted(direction, predictionOf(target)) });
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
      case "skipped": {
        const prediction = predictionOf(action.target);
        if (skippedPrediction !== prediction) {
          const predictedSlot = slotAtTime(action.target.at, (known as NonNullable<typeof known>).facts);
          logger.info("early_start_skipped", { direction, reason: "already-started-for-this-prediction", why: action.target.why, keys: action.target.keys, predictedSlot, dueAt: iso(action.target.at) });
        }
        skippedPrediction = prediction;
        return;
      }
      case "start":
        startSession(action.target, nowSeconds, lead);
        return sendPing(ping, "start");
      default:
        return sendPing(ping, action.kind);
    }
  }

  function startSession(target: WarmupTarget, at: number, lead: ReturnType<WarmupStore["lead"]>): void {
    const id = input.warmupStore.openSession({ direction, why: target.why, dueAt: target.at * 1000, leadSeconds: lead.seconds, at: at * 1000, prediction: predictionOf(target) });
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
      if (batchTimer !== null) clearTimeout(batchTimer);
      while (running !== null) await running;
    },
  };
}
