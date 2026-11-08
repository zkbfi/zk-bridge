import { randomUUID } from "node:crypto";
import type { Hex } from "viem";
import type { ProofDirection } from "@zk-bridge/shared";
import { CommandTimeoutError, ProverCommandError, type ProveOutcome, type ProverBinary, type ProveTiming } from "@zk-bridge/shared/prover";
import type { Logger } from "../logger.ts";
import { UNKNOWN_CALLER } from "./caller.ts";
import type { Storage } from "../storage.ts";
import { describeHeld, isStale, pendingFrom, readHeldProofs } from "./held-proofs.ts";
import type { ProofNeed, ProofNeedReader } from "./proof-need.ts";
import { urgentReasons, type WatchUrgentReason } from "../watch/decide.ts";
import {
  CALLER_WINDOW_MILLISECONDS,
  JOB_BUDGET_WINDOW_MILLISECONDS,
  jobBudgetWaitSeconds,
  windowWaitSeconds,
  directionWaitSeconds,
  epochsPerDay,
  gpuBudgetWait,
  type RateLimits,
} from "./rate-limit.ts";
import { DEFAULT_WARMUP } from "../watch/warmup.ts";
import {
  findActiveJob,
  findJobByTarget,
  findLatestJob,
  insertJob,
  lastJobTargetSlot,
  recentJobSeconds,
  jobsWithSlots,
  insertRequest,
  listActiveJobs,
  pruneRequests,
  recentCostlyJobs,
  recentCallersOfAll,
  recentRequestsOfCaller,
  updateJob,
  type RequestReason,
} from "./jobs.ts";

/** One request to prove. `caller` is the key that the rate limits count. */
export type ProofRequest = {
  readonly pair: string;
  readonly direction: ProofDirection;
  readonly reason: RequestReason;
  readonly messageId?: Hex;
  readonly caller: string;
  /**
   * When the event behind the request arrived, in milliseconds since 1970. The watcher sets it to the arrival of the
   * finality it acts on, and `job_started` logs the latency from it. Not stored.
   */
  readonly since?: number;
  /**
   * The watcher's planner found a period handoff due: it read the light client and the beacon chain, and the source
   * finalized past the head's sync-committee period (or handoff steps are needed), so the proof moves the light client
   * into a newer committee period. The indexer's own rule only knows the head's age, which can still look young then.
   * A keep-alive of the age rule does not set it and goes through that rule. Taken only with reason `finality`, which
   * no HTTP request can carry; every other check still applies.
   */
  readonly plannedHandoff?: boolean;
  /**
   * The watcher read the chain and found a situation that needs a proof now (`urgentReasons` in `watch/decide.ts`):
   * `deposits-locked`, the destination bridge waits for an update of this light client to open deposits. The indexer
   * knows nothing of it. Taken only with reason `finality`, which no HTTP request can carry; every other check still
   * applies (the caller limits, one job per direction, the spacing between jobs, the daily budget, a pending proof).
   */
  readonly urgent?: WatchUrgentReason;
  /**
   * The proof the watcher plans: from the head it read to the finalized slot it acts on. The service starts one job per
   * target and direction, ever: a second request for it is refused as `duplicate`, also after a restart or a failure.
   */
  readonly target?: { readonly startSlot: number; readonly newSlot: number };
};

/** The answer of {@link RequestService.submit}. */
export type SubmitResult =
  /** `joined`: a job of the direction was running already, and the request joined it. */
  | { readonly requestId: string; readonly jobId: string; readonly joined?: true }
  /**
   * `why`: `limit` (a caller limit, the retry wait after a failed job, or the daily job backstop), `same-finality` (a
   * job of the direction already proves to the newest finality the backend knows; the next finality comes in about
   * `retryAfterSeconds`), `gpu-budget` (the direction's 24 h GPU budget is spent; `detail` says by how much).
   */
  | { readonly refused: "rate-limited"; readonly retryAfterSeconds: number; readonly why?: "limit" | "same-finality" | "gpu-budget"; readonly detail?: string }
  /**
   * `why`: `no-need`, the chain indexer shows no final message waiting and a fresh head; `proof-pending`, a proof we
   * have from the head waits to land, and the next proof starts from the head it makes.
   */
  | { readonly refused: "nothing-to-prove"; readonly why: "no-need" | "proof-pending" }
  /** A job for the same target ran already. Only a request that names a target gets it. */
  | { readonly refused: "duplicate" }
  | { readonly refused: "cannot-check"; readonly retryAfterSeconds: number };

/** How long an answer of the chain indexer serves the next requests of its direction, in milliseconds. */
export const PROOF_NEED_REUSE_MILLISECONDS = 15_000;

/** The seconds a caller waits after the chain indexer could not answer. */
export const CANNOT_CHECK_RETRY_SECONDS = 30;

/** The request service. */
export interface RequestService {
  /**
   * Records a request. A request for a direction that has an active job joins that job. Any other request starts a new
   * job, and runs it in the background, only when the chain indexer shows that the direction needs a proof. The job is
   * made in one synchronous transaction that runs every check again, so two requests never both create a job.
   */
  submit(request: ProofRequest): Promise<SubmitResult>;
  /**
   * Fails the proving jobs that outlived the prover limit, then runs the jobs that a restart left behind and that have
   * no proof yet. A job whose proof already arrived waits for the webhook or for the timeout.
   */
  recover(): void;
  /**
   * Seconds until a new job of the direction is admitted: the retry wait after a failed job, or the wait for the daily
   * job backstop. 0 when one may start now. The caller limits, the finality rule and the GPU budget are not counted. The watcher
   * asks it so that the warm-up never wakes the prover for a proof the service would refuse.
   */
  admitAfterSeconds(direction: ProofDirection): number;
  /** Deletes the request rows older than the retention window. Returns how many rows went. */
  prune(): number;
  /** Resolves when no job runs in the background. A test awaits it. */
  settled(): Promise<void>;
}

/**
 * The newest finality of a direction the backend knows (the watcher's latest decision): its finalized slot, the light
 * client head it read, and when the next finality is expected (milliseconds since 1970).
 */
export type KnownFinality = { readonly finalizedSlot: number; readonly headSlot: number; readonly nextAt: number };

/** Input of {@link createRequestService}. */
export interface RequestServiceInput {
  readonly storage: Storage;
  /**
   * The prover for one job. It must hand its proof to the webhook of that job (`/webhook/jobs/<id>`), so each job has
   * its own wrapper. Every wrapper proves from the on-chain head: the request names a direction and nothing else.
   */
  readonly proverForJob: (jobId: string) => ProverBinary;
  /** Whether a direction needs a proof, from the chain indexer. A request alone never starts a paid proving run. */
  readonly readProofNeed: ProofNeedReader;
  /** Milliseconds since 1970. */
  readonly now: () => number;
  readonly limits: RateLimits;
  /** A proving job older than this many milliseconds counts as lost. Use the prover limit. */
  readonly proverTimeoutMilliseconds: number;
  readonly logger: Logger;
  /**
   * Told of each proof the prover made, with its `prove_timing` fields (null from an older prover). The warm-up learns
   * from it how long a cold worker takes. `startedAt`: when the job started proving, in milliseconds since 1970.
   */
  /**
   * The newest finality of a direction, or null when none is known (no watcher, or none seen since the start). A request
   * without a target proves to it, and starts a job only when no job of the direction proves to it or further. Unknown:
   * the request starts a job without a target, and the daily backstop bounds it. Default: unknown.
   */
  readonly finality?: (direction: ProofDirection) => KnownFinality | null;
  /** The daily job backstop of a direction when `limits.jobsPerDirectionPerDay` is not set. Default: 225 (12 s slots). */
  readonly jobsPerDayOf?: (direction: ProofDirection) => number;
  /** The price of a GPU hour in USD, for the GPU budget. Default: `watch.warmup.gpuUsdPerHour`'s default (2.25). */
  readonly readUsdPerHour?: () => Promise<number>;
  readonly onProved?: (event: { readonly jobId: string; readonly direction: ProofDirection; readonly startedAt: number; readonly timing: ProveTiming | null }) => void;
}

/** A reason for a failed job that is safe to show: it holds no path, no endpoint and no prover output. */
function describeFailure(error: unknown): string {
  if (error instanceof ProverCommandError) return `the prover stopped with exit code ${error.exitCode}`;
  if (error instanceof CommandTimeoutError) return "the prover ran longer than its limit";
  return "the prover could not make a proof";
}

/** The stored fields of a request. */
function stored(request: ProofRequest) {
  return { pair: request.pair, direction: request.direction, reason: request.reason, caller: request.caller, messageId: request.messageId ?? null };
}

/** Builds the request service over the storage. */
export function createRequestService(input: RequestServiceInput): RequestService {
  const { storage, now, limits, logger } = input;
  const running = new Set<Promise<void>>();
  const jobsPerDay = (direction: ProofDirection) => limits.jobsPerDirectionPerDay ?? input.jobsPerDayOf?.(direction) ?? epochsPerDay(12);
  const readUsdPerHour = input.readUsdPerHour ?? (async () => DEFAULT_WARMUP.gpuUsdPerHour);

  async function runJob(jobId: string, direction: ProofDirection): Promise<void> {
    // A job that is no longer queued (or proving without a proof after a restart) must not start the prover.
    const claimed = updateJob(storage, jobId, { status: "proving" }, now(), ["queued", "proving"]);
    if (!claimed) return;
    const startedAt = now();
    let outcome: ProveOutcome;
    try {
      outcome = await input.proverForJob(jobId).prove({ direction });
      if (outcome.kind === "up-to-date") {
        updateJob(storage, jobId, { status: "on-chain" }, now(), ["proving"]);
        return;
      }
      // The prover already handed the proof to the webhook. The webhook module moves the job on from here.
      const { startHeadSlot, newHeadSlot } = outcome.proofPackage;
      updateJob(storage, jobId, { status: "proving", startSlot: String(startHeadSlot), newSlot: String(newHeadSlot) }, now(), ["proving"]);
      // The first proof of these slots stays; the webhook keeps only one of them for the board.
      const earlier = jobsWithSlots(storage, direction, String(startHeadSlot), String(newHeadSlot), jobId);
      if (earlier.length > 0) logger.warn("proof_duplicate", { jobId, direction, startSlot: startHeadSlot, newSlot: newHeadSlot, firstJobId: earlier[0] });
    } catch (error) {
      logger.warn("job_failed", { jobId, direction, error });
      updateJob(storage, jobId, { status: "failed", error: describeFailure(error) }, now(), ["proving"]);
      return;
    }
    // Outside the job's own handling: a failure here never fails the job.
    try {
      input.onProved?.({ jobId, direction, startedAt, timing: outcome.timing ?? null });
    } catch (error) {
      logger.warn("job_proved_note_failed", { jobId, direction, error });
    }
  }

  function start(jobId: string, direction: ProofDirection): void {
    const task = runJob(jobId, direction).finally(() => running.delete(task));
    running.add(task);
  }

  // A job is lost when nothing touched it for the prover limit. The publisher touches a job on each attempt to post its
  // proof (touchProvingJob), so a job whose paid proof waits for a slow board is not lost while the posts go on.
  function failLostJobs(): void {
    const current = now();
    for (const job of listActiveJobs(storage)) {
      const deadline = job.updatedAt + input.proverTimeoutMilliseconds;
      if (job.status !== "proving" || current <= deadline) continue;
      // The job failed at its deadline, so the retry wait counts from there and not from the late check.
      updateJob(storage, job.id, { status: "failed", error: "the prover ran longer than its limit" }, deadline, ["proving"]);
    }
  }

  type Decision = { result: SubmitResult; startedJobId: string | null };

  /**
   * The checks that need no indexer, run inside a transaction: the caller and global limits, joining an active job,
   * the wait of the direction and its daily budget. Null means that a new job may start if the chains need a proof.
   */
  function admit(request: ProofRequest, current: number, finality: KnownFinality | null): Decision | null {
    const since = current - CALLER_WINDOW_MILLISECONDS;
    const callerLimit = request.caller === UNKNOWN_CALLER ? limits.requestsPerUnknownCallerPerMinute : limits.requestsPerCallerPerMinute;
    const ofCaller = recentRequestsOfCaller(storage, request.caller, since);
    // The global limit counts callers, not requests (K-2): a caller already counted in this minute adds nobody, and only
    // its own limit applies. So a few addresses, each at its own limit, cannot lock every other caller out.
    const callerWait = Math.max(
      windowWaitSeconds({ recent: ofCaller, now: current, limit: callerLimit }),
      ofCaller.count > 0 ? 0 : windowWaitSeconds({ recent: recentCallersOfAll(storage, since), now: current, limit: limits.globalRequestsPerMinute }),
    );
    if (callerWait > 0) return { result: { refused: "rate-limited", retryAfterSeconds: callerWait, why: "limit" }, startedJobId: null };
    const active = findActiveJob(storage, request.direction);
    if (active !== null) {
      const requestId = randomUUID();
      insertRequest(storage, { ...stored(request), id: requestId, jobId: active.id, now: current });
      return { result: { requestId, jobId: active.id, joined: true }, startedJobId: null };
    }
    if (request.target !== undefined && findJobByTarget(storage, request.direction, request.target) !== null) return { result: { refused: "duplicate" }, startedJobId: null };
    // One job per new finality: a job that proves to this finality or a newer one exists already.
    const lastTarget = lastJobTargetSlot(storage, request.direction);
    const asked = request.target?.newSlot ?? finality?.finalizedSlot ?? null;
    if (asked !== null && lastTarget !== null && asked <= lastTarget) {
      if (request.target !== undefined) return { result: { refused: "duplicate" }, startedJobId: null };
      const next = Math.max(1, Math.ceil(((finality as KnownFinality).nextAt - current) / 1000));
      return { result: { refused: "rate-limited", retryAfterSeconds: next, why: "same-finality", detail: `a job already proves to the newest finality (slot ${lastTarget}); the next finality is expected in about ${next} s` }, startedJobId: null };
    }
    const directionWait = directionWaitSeconds({ latest: findLatestJob(storage, request.direction), now: current, limits });
    if (directionWait > 0) return { result: { refused: "rate-limited", retryAfterSeconds: directionWait, why: "limit" }, startedJobId: null };
    // A backstop behind the indexer check: it bounds what remote proofs cost even when the indexer reports wrong facts.
    const budgetWait = jobBudgetWaitSeconds({
      recent: recentCostlyJobs(storage, request.direction, current - JOB_BUDGET_WINDOW_MILLISECONDS),
      now: current,
      limit: jobsPerDay(request.direction),
    });
    if (budgetWait > 0) return { result: { refused: "rate-limited", retryAfterSeconds: budgetWait, why: "limit" }, startedJobId: null };
    return null;
  }

  /**
   * The GPU budget of the direction: refused while the spend of its jobs in the last 24 hours reaches it. A liveness
   * proof (a planned handoff, or a keep-alive of the age rule) goes past it, logged.
   */
  async function overBudget(request: ProofRequest, need: Extract<ProofNeed, { needed: true }>, current: number): Promise<SubmitResult | null> {
    const usdPerHour = await readUsdPerHour();
    const budgetUsd = limits.gpuBudgetUsdPerDirectionPerDay;
    const spent = gpuBudgetWait({ jobs: recentJobSeconds(storage, request.direction, current - JOB_BUDGET_WINDOW_MILLISECONDS), usdPerHour, budgetUsd, now: current });
    if (spent === null) return null;
    const detail = `the 24 h GPU budget of $${budgetUsd.toFixed(2)} for ${request.direction} is spent: $${spent.spentUsd.toFixed(2)}`;
    const fields = { direction: request.direction, reason: request.reason, budgetUsd, spentUsd: Math.round(spent.spentUsd * 10_000) / 10_000, usdPerHour, detail };
    if (need.why === "keep-alive") {
      logger.warn("gpu_budget_bypassed", { ...fields, why: "liveness: the proof keeps the light client alive" });
      return null;
    }
    logger.warn("gpu_budget_spent", { ...fields, retryAfterSeconds: spent.retryAfterSeconds });
    return { refused: "rate-limited", retryAfterSeconds: spent.retryAfterSeconds, why: "gpu-budget", detail };
  }

  // One read of the chain indexer serves every request of its direction for PROOF_NEED_REUSE_MILLISECONDS, and the
  // requests that arrive during a read share it. A burst of requests never becomes a burst of indexer queries.
  const needs = new Map<ProofDirection, { readonly at: number; readonly answer: Promise<ProofNeed> }>();

  // The watcher's request reads afresh: it acts on a finality that arrived just now, and an answer from before it may
  // predate the message it proves.
  function proofNeed(direction: ProofDirection, current: number, fresh: boolean): Promise<ProofNeed> {
    const known = needs.get(direction);
    if (!fresh && known !== undefined && current - known.at < PROOF_NEED_REUSE_MILLISECONDS) return known.answer;
    const entry = { at: current, answer: input.readProofNeed(direction, current) };
    needs.set(direction, entry);
    // A failed read is not kept: the next request asks again. At worst this drops a newer answer, and costs one read.
    entry.answer.catch(() => needs.delete(direction));
    return entry.answer;
  }

  return {
    async submit(request) {
      failLostJobs();
      const asked = now();
      // A watcher request names its finality in its target; any other request proves to the newest one known.
      const finality = request.target === undefined ? (input.finality?.(request.direction) ?? null) : null;
      const first = storage.transaction(() => admit(request, asked, finality));
      if (first !== null) return first.result;
      let need: ProofNeed;
      try {
        need = await proofNeed(request.direction, asked, request.reason === "finality");
      } catch (error) {
        logger.warn("proof_need_unknown", { direction: request.direction, error });
        return { refused: "cannot-check", retryAfterSeconds: CANNOT_CHECK_RETRY_SECONDS };
      }
      if (!need.needed && request.reason === "finality" && request.plannedHandoff === true) need = { needed: true, why: "keep-alive" };
      if (!need.needed && request.reason === "finality" && request.urgent !== undefined) need = { needed: true, why: request.urgent };
      if (!need.needed) return { refused: "nothing-to-prove", why: "no-need" };
      // Never prove again what a proof we have can still land: it starts at the head, and the next proof starts from
      // the head it makes. Only a proof that waited past its time lets a new one start from the same head.
      const headSlot = request.target?.startSlot ?? need.headSlot ?? null;
      const pending = headSlot === null ? null : pendingFrom(readHeldProofs(storage, request.direction), headSlot);
      if (pending !== null) {
        const fields = { direction: request.direction, startSlot: pending.startSlot, newSlot: pending.newSlot, where: pending.where, reason: request.reason };
        if (!isStale(pending, asked, limits.pendingProofStaleSeconds)) {
          logger.info("proof_pending", { ...fields, detail: `${describeHeld(pending)} waits to land` });
          return { refused: "nothing-to-prove", why: "proof-pending" };
        }
        logger.warn("proof_pending_stale", { ...fields, waitedSeconds: Math.round((asked - pending.since) / 1000) });
      }
      const refusedForBudget = await overBudget(request, need, asked);
      if (refusedForBudget !== null) return refusedForBudget;
      // Another request may have made a job while the indexer answered, so every check runs again with the insert.
      const current = now();
      // A request without a target proves to the newest finality known: that is the job's planned target.
      const target = request.target ?? (finality === null ? undefined : { startSlot: finality.headSlot, newSlot: finality.finalizedSlot });
      const { result, startedJobId } = storage.transaction((): Decision => {
        const decided = admit(request, current, finality);
        if (decided !== null) return decided;
        const job = insertJob(storage, { id: randomUUID(), direction: request.direction, now: current, ...(target === undefined ? {} : { target }) });
        const requestId = randomUUID();
        insertRequest(storage, { ...stored(request), id: requestId, jobId: job.id, now: current });
        return { result: { requestId, jobId: job.id }, startedJobId: job.id };
      });
      if (startedJobId !== null) {
        const latency = request.since === undefined ? {} : { latencyMs: current - request.since };
        // The reasons that started it before the watcher's minimum interval: a user's request never waits for it.
        const urgent = [...(request.urgent === undefined ? [] : [request.urgent]), ...urgentReasons({ nowSeconds: current / 1000, requested: request.reason !== "finality" })];
        logger.info("job_started", { jobId: startedJobId, direction: request.direction, why: need.why, reason: request.reason, ...latency, ...(urgent.length === 0 ? {} : { urgent }) });
        start(startedJobId, request.direction);
      }
      return result;
    },
    recover() {
      failLostJobs();
      for (const job of listActiveJobs(storage)) {
        if (job.startSlot === null) start(job.id, job.direction);
      }
    },
    admitAfterSeconds(direction) {
      const current = now();
      const directionWait = directionWaitSeconds({ latest: findLatestJob(storage, direction), now: current, limits });
      const budgetWait = jobBudgetWaitSeconds({ recent: recentCostlyJobs(storage, direction, current - JOB_BUDGET_WINDOW_MILLISECONDS), now: current, limit: jobsPerDay(direction) });
      return Math.max(directionWait, budgetWait);
    },
    prune() {
      return pruneRequests(storage, now() - limits.requestRetentionHours * 3_600_000);
    },
    async settled() {
      while (running.size > 0) await Promise.all([...running]);
    },
  };
}
