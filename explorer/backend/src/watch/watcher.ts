/**
 * The watcher of one proof direction. On each new finalized header of the source chain it decides whether a proof is
 * due ({@link decideProof}) and starts the job through the request service, which applies every gate of a request. On
 * a timer it pings the remote prover shortly before a proof is expected, so a worker is warm when the job starts.
 */
import type { Hex } from "viem";
import type { ProofDirection } from "@zk-bridge/shared";
import { neededHandoffPeriods, type LightClientFacts, type Policy, type SourceHistory } from "../keepalive/plan.ts";
import type { Logger } from "../logger.ts";
import type { Job } from "../requests/jobs.ts";
import type { ProofRequest, SubmitResult } from "../requests/service.ts";
import { decideProof, NO_WARMUP, slotAtTime, warmupStep, warmupTargets, type PendingProof, type WaitingMessage, type WarmupConfig, type WarmupState } from "./decide.ts";
import type { FinalityObservation } from "./feed.ts";

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
  /** Reads the messages and pings the remote prover when a proof is near. */
  scan(): Promise<void>;
  /** Resolves when no reading is being handled. */
  settled(): Promise<void>;
  /** Cancels the retry timer and waits for the running work. */
  stop(): Promise<void>;
}

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
  let warm: WarmupState = NO_WARMUP;
  let scanFailing = false;

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
      ...(decision.why === "message" ? { messageId: decision.messageIds[0] as Hex } : { plannedKeepAlive: true }),
      since: observation.receivedAt,
    });
    if (!("refused" in result)) {
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

  return {
    observe: (observation) => enqueue(observation, 0),
    async scan() {
      if (input.ping === null || stopped) return;
      try {
        if (known === null || now() - known.at >= FACTS_REUSE_MILLISECONDS) {
          const fresh = await input.readFacts();
          known = { finalizedSlot: 0, history: { kind: "not-needed" }, ...known, facts: fresh, at: now() };
        }
        const { facts } = known;
        const messages = toWaiting(await input.readMessages(), facts);
        const nowSeconds = now() / 1000;
        const targets = warmupTargets({ facts, finalizedSlot: known.finalizedSlot, messages, pendingProof: pendingProofOf(input.findLatestJob()), history: known.history, policy: input.policy, nowSeconds });
        const step = warmupStep({ nowSeconds, targets, state: warm, config: input.warmup, jobActive: input.findActiveJob() !== null });
        scanFailing = false;
        if (!step.ping) return;
        warm = step.state;
        let status: number | null = null;
        try {
          status = await input.ping();
        } catch (error) {
          logger.warn("warmup_ping_failed", { direction, error });
        }
        logger.info("warmup_ping", { direction, why: step.target.why, session: step.newSession ? "new" : "repeat", secondsToStart: Math.round(step.target.at - nowSeconds), status });
      } catch (error) {
        if (!scanFailing) logger.warn("watch_scan_failed", { direction, error });
        scanFailing = true;
      }
    },
    async settled() {
      while (running !== null) await running;
    },
    async stop() {
      stopped = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      while (running !== null) await running;
    },
  };
}
