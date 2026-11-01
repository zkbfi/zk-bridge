import { randomUUID } from "node:crypto";
import type { Hex } from "viem";
import type { ProofDirection } from "@zk-bridge/shared";
import { CommandTimeoutError, ProverCommandError, type ProverBinary } from "@zk-bridge/shared/prover";
import type { Logger } from "../logger.ts";
import { UNKNOWN_CALLER } from "./caller.ts";
import type { Storage } from "../storage.ts";
import type { ProofNeed, ProofNeedReader } from "./proof-need.ts";
import {
  CALLER_WINDOW_MILLISECONDS,
  JOB_BUDGET_WINDOW_MILLISECONDS,
  jobBudgetWaitSeconds,
  windowWaitSeconds,
  directionWaitSeconds,
  type RateLimits,
} from "./rate-limit.ts";
import {
  findActiveJob,
  findLatestJob,
  insertJob,
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
};

/** The answer of {@link RequestService.submit}. */
export type SubmitResult =
  | { readonly requestId: string; readonly jobId: string }
  | { readonly refused: "rate-limited"; readonly retryAfterSeconds: number }
  | { readonly refused: "nothing-to-prove" }
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
  /** Deletes the request rows older than the retention window. Returns how many rows went. */
  prune(): number;
  /** Resolves when no job runs in the background. A test awaits it. */
  settled(): Promise<void>;
}

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

  async function runJob(jobId: string, direction: ProofDirection): Promise<void> {
    // A job that is no longer queued (or proving without a proof after a restart) must not start the prover.
    const claimed = updateJob(storage, jobId, { status: "proving" }, now(), ["queued", "proving"]);
    if (!claimed) return;
    try {
      const outcome = await input.proverForJob(jobId).prove({ direction });
      if (outcome.kind === "up-to-date") {
        updateJob(storage, jobId, { status: "on-chain" }, now(), ["proving"]);
        return;
      }
      // The prover already handed the proof to the webhook. The webhook module moves the job on from here.
      const { startHeadSlot, newHeadSlot } = outcome.proofPackage;
      updateJob(storage, jobId, { status: "proving", startSlot: String(startHeadSlot), newSlot: String(newHeadSlot) }, now(), ["proving"]);
    } catch (error) {
      logger.warn("job_failed", { jobId, direction, error });
      updateJob(storage, jobId, { status: "failed", error: describeFailure(error) }, now(), ["proving"]);
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
  function admit(request: ProofRequest, current: number): Decision | null {
    const since = current - CALLER_WINDOW_MILLISECONDS;
    const callerLimit = request.caller === UNKNOWN_CALLER ? limits.requestsPerUnknownCallerPerMinute : limits.requestsPerCallerPerMinute;
    const ofCaller = recentRequestsOfCaller(storage, request.caller, since);
    // The global limit counts callers, not requests (K-2): a caller already counted in this minute adds nobody, and only
    // its own limit applies. So a few addresses, each at its own limit, cannot lock every other caller out.
    const callerWait = Math.max(
      windowWaitSeconds({ recent: ofCaller, now: current, limit: callerLimit }),
      ofCaller.count > 0 ? 0 : windowWaitSeconds({ recent: recentCallersOfAll(storage, since), now: current, limit: limits.globalRequestsPerMinute }),
    );
    if (callerWait > 0) return { result: { refused: "rate-limited", retryAfterSeconds: callerWait }, startedJobId: null };
    const active = findActiveJob(storage, request.direction);
    if (active !== null) {
      const requestId = randomUUID();
      insertRequest(storage, { ...stored(request), id: requestId, jobId: active.id, now: current });
      return { result: { requestId, jobId: active.id }, startedJobId: null };
    }
    const directionWait = directionWaitSeconds({ latest: findLatestJob(storage, request.direction), now: current, limits });
    if (directionWait > 0) return { result: { refused: "rate-limited", retryAfterSeconds: directionWait }, startedJobId: null };
    // A backstop behind the indexer check: it bounds what remote proofs cost even when the indexer reports wrong facts.
    const budgetWait = jobBudgetWaitSeconds({
      recent: recentCostlyJobs(storage, request.direction, current - JOB_BUDGET_WINDOW_MILLISECONDS),
      now: current,
      limit: limits.jobsPerDirectionPerDay,
    });
    if (budgetWait > 0) return { result: { refused: "rate-limited", retryAfterSeconds: budgetWait }, startedJobId: null };
    return null;
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
      const first = storage.transaction(() => admit(request, asked));
      if (first !== null) return first.result;
      let need: ProofNeed;
      try {
        need = await proofNeed(request.direction, asked, request.reason === "finality");
      } catch (error) {
        logger.warn("proof_need_unknown", { direction: request.direction, error });
        return { refused: "cannot-check", retryAfterSeconds: CANNOT_CHECK_RETRY_SECONDS };
      }
      if (!need.needed && request.reason === "finality" && request.plannedHandoff === true) need = { needed: true, why: "keep-alive" };
      if (!need.needed) return { refused: "nothing-to-prove" };
      // Another request may have made a job while the indexer answered, so every check runs again with the insert.
      const current = now();
      const { result, startedJobId } = storage.transaction((): Decision => {
        const decided = admit(request, current);
        if (decided !== null) return decided;
        const job = insertJob(storage, { id: randomUUID(), direction: request.direction, now: current });
        const requestId = randomUUID();
        insertRequest(storage, { ...stored(request), id: requestId, jobId: job.id, now: current });
        return { result: { requestId, jobId: job.id }, startedJobId: job.id };
      });
      if (startedJobId !== null) {
        const latency = request.since === undefined ? {} : { latencyMs: current - request.since };
        logger.info("job_started", { jobId: startedJobId, direction: request.direction, why: need.why, reason: request.reason, ...latency });
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
    prune() {
      return pruneRequests(storage, now() - limits.requestRetentionHours * 3_600_000);
    },
    async settled() {
      while (running.size > 0) await Promise.all([...running]);
    },
  };
}
