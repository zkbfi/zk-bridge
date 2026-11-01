/**
 * The read routes of the pipeline: `GET /progress/:messageId`, `GET /directions/:direction/pipeline` and
 * `GET /benchmarks`. They answer from the backend database, the watcher's latest decision and the chain indexer, and
 * never name an endpoint, a key or a path. Each caller may read {@link READS_PER_CALLER_PER_MINUTE} times a minute.
 */
import type { Context, Hono } from "hono";
import { PROOF_DIRECTIONS, secondsPerSlot, type Pair, type PairSide, type ProofDirection } from "@zk-bridge/shared";
import type { BackendModuleContext } from "../module.ts";
import { findActiveJob, findLatestJob, getJob, listJobsSince, type PlannedJob } from "../requests/jobs.ts";
import { getTiming, listTimings, recentTimings, statOf } from "../requests/timings.ts";
import type { Storage } from "../storage.ts";
import { decisionBoardOf } from "../watch/decisions.ts";
import { buildBenchmarks, parseWindow, WINDOW_LIMITS, type Benchmarks } from "./benchmarks.ts";
import { createIndexerReads, type IndexedHead, type IndexerReads } from "./indexer.ts";
import { buildPipeline, knownProofs } from "./pipeline.ts";
import { buildProgress, clockFromHead, type Estimates } from "./progress.ts";

/** How many reads of these routes one caller may make in a minute. */
export const READS_PER_CALLER_PER_MINUTE = 60;

/** How many recent proofs the estimates of a running job read. */
export const ESTIMATE_SAMPLE = 20;

/** How long one computed set of benchmarks serves the estimates, in milliseconds. */
export const ESTIMATE_REUSE_MILLISECONDS = 60_000;

/** The callers known in one minute, with the times of their reads. */
export function createReadLimiter(input: { perMinute: number; now: () => number }) {
  const reads = new Map<string, number[]>();
  return {
    /** Seconds to wait, or 0 when the read may go on (and is counted). */
    take(caller: string): number {
      const now = input.now();
      const since = now - 60_000;
      // The map holds only callers of the last minute: a flood of addresses cannot grow it for ever.
      if (reads.size > 10_000) for (const [key, times] of reads) if ((times.at(-1) as number) <= since) reads.delete(key);
      const recent = (reads.get(caller) ?? []).filter((time) => time > since);
      if (recent.length >= input.perMinute) {
        reads.set(caller, recent);
        return Math.max(1, Math.ceil(((recent[0] as number) + 60_000 - now) / 1000));
      }
      recent.push(now);
      reads.set(caller, recent);
      return 0;
    },
  };
}

/** The two sides of a direction. */
function sidesOf(pair: Pair, direction: ProofDirection): { source: PairSide; destination: PairSide } {
  const [first, second] = pair.sides;
  return direction === "first-to-second" ? { source: first, destination: second } : { source: second, destination: first };
}

/** The light client of a direction among the heads, or null. */
function headOf(heads: readonly IndexedHead[] | null, pair: Pair, direction: ProofDirection): IndexedHead | null {
  const { source, destination } = sidesOf(pair, direction);
  return heads?.find((head) => head.chainId === destination.chainId && head.trackedChainId === source.chainId) ?? null;
}

/** Whether a warm-up of the direction had a ready worker when the job was made, and kept it till then. */
export function workerWarmAt(storage: Storage, direction: ProofDirection, at: number): boolean {
  return storage.database.prepare("SELECT 1 FROM warmup_sessions WHERE direction = ? AND ready_at IS NOT NULL AND ready_at <= ? AND (ended_at IS NULL OR ended_at >= ?) LIMIT 1").get(direction, at, at) !== undefined;
}

/** What the routes need beyond the context. A test passes its own indexer reads. */
export type ProgressOptions = { readonly indexer?: IndexerReads | null; readonly callerOf: (request: Context) => string };

/** Adds the three read routes. */
export function registerProgressRoutes(app: Hono, context: BackendModuleContext, options: ProgressOptions): void {
  const { storage, pair, now } = context;
  const indexer = options.indexer !== undefined ? options.indexer : context.config.indexerUrl === undefined ? null : createIndexerReads({ baseUrl: context.config.indexerUrl, now });
  const limiter = createReadLimiter({ perMinute: READS_PER_CALLER_PER_MINUTE, now });
  const board = decisionBoardOf(context);

  /** Answers 429 when the caller read too often, else null. */
  const limited = (request: Context) => {
    const wait = limiter.take(options.callerOf(request));
    if (wait === 0) return null;
    request.header("Retry-After", String(wait));
    return request.json({ error: "rate-limited", retryAfterSeconds: wait }, 429);
  };

  /** The benchmarks of a window; the chain indexer's part is left empty when it cannot be read. */
  async function benchmarks(window: string, windowSeconds: number): Promise<Benchmarks> {
    const at = now();
    let fromIndexer: Parameters<typeof buildBenchmarks>[0]["indexer"] = null;
    if (indexer !== null) {
      try {
        const entries = await Promise.all(
          PROOF_DIRECTIONS.map(async (direction) => {
            const { source, destination } = sidesOf(pair, direction);
            const [headUpdates, delivered] = await Promise.all([indexer.headUpdates(destination.chainId), indexer.delivered(source.chainId, destination.chainId)]);
            return [direction, { headUpdates, delivered }] as const;
          }),
        );
        fromIndexer = Object.fromEntries(entries) as NonNullable<typeof fromIndexer>;
      } catch (error) {
        context.logger.warn("benchmarks_indexer_unreadable", { error });
      }
    }
    return buildBenchmarks({ window, windowSeconds, now: at, timings: listTimings(storage, at - windowSeconds * 1000), jobOf: (jobId) => getJob(storage, jobId), indexer: fromIndexer });
  }

  let estimateCache: { at: number; value: Promise<Benchmarks> } | null = null;

  /** Medians for the `eta` of a stage: the prover's from the newest proofs, the on-chain ones from a day of benchmarks. */
  async function estimates(): Promise<Estimates> {
    const recent = recentTimings(storage, ESTIMATE_SAMPLE);
    if (estimateCache === null || now() - estimateCache.at >= ESTIMATE_REUSE_MILLISECONDS) estimateCache = { at: now(), value: benchmarks("24h", 86_400) };
    const day = await estimateCache.value;
    return {
      workerWaitMs: statOf(recent.filter((timing) => (timing.notReadyCount ?? 0) > 0).map((timing) => timing.waitWorkerMs)).medianMs,
      totalMs: statOf(recent.map((timing) => timing.totalMs)).medianMs,
      grindMs: statOf(recent.map((timing) => timing.grindMs)).medianMs,
      proofToOnChainMs: day.steps.proofToOnChain.medianMs,
      coveredToDeliveredMs: day.steps.coveredToDelivered.medianMs,
    };
  }

  app.get("/progress/:messageId", async (request) => {
    const messageId = request.req.param("messageId");
    if (!/^0x[0-9a-fA-F]{64}$/.test(messageId)) return request.json({ error: "a message identifier is 32 bytes of 0x hex" }, 400);
    const refused = limited(request);
    if (refused !== null) return refused;
    if (indexer === null) return request.json({ error: "the chain indexer is not configured" }, 503);
    let message: Awaited<ReturnType<IndexerReads["message"]>>;
    try {
      message = await indexer.message(messageId.toLowerCase());
    } catch (error) {
      context.logger.warn("progress_indexer_unreadable", { error });
      return request.json({ error: "the chain indexer cannot be read" }, 503);
    }
    if (message === null || message.sent === null) return request.json({ error: "unknown message" }, 404);
    const direction = PROOF_DIRECTIONS.find((candidate) => {
      const { source, destination } = sidesOf(pair, candidate);
      return message.direction.sourceChainId === source.chainId && message.direction.destinationChainId === destination.chainId;
    });
    if (direction === undefined) return request.json({ error: "the message is not of this pair" }, 404);
    const heads = await indexer.heads().catch(() => null);
    const head = headOf(heads, pair, direction);
    const decision = board.latest(direction);
    const clock = decision ?? clockFromHead(head, secondsPerSlot(sidesOf(pair, direction).source.chainId));
    const progress = buildProgress({
      messageId: message.messageId,
      direction,
      message: message as Parameters<typeof buildProgress>[0]["message"],
      head,
      clock: clock === null ? null : { genesisTime: clock.genesisTime, secondsPerSlot: clock.secondsPerSlot },
      decision,
      jobs: listJobsSince(storage, direction, message.sent.timestamp * 1000),
      timingOf: (jobId) => getTiming(storage, jobId),
      held: knownProofs(storage, direction),
      workerWarmFor: (job: PlannedJob) => workerWarmAt(storage, direction, job.createdAt),
      estimates: await estimates(),
      now: now(),
    });
    return request.json(progress);
  });

  app.get("/directions/:direction/pipeline", async (request) => {
    const direction = request.req.param("direction") as ProofDirection;
    if (!PROOF_DIRECTIONS.includes(direction)) return request.json({ error: "unknown direction" }, 404);
    const refused = limited(request);
    if (refused !== null) return refused;
    const heads = indexer === null ? null : await indexer.heads().catch(() => null);
    const active = findActiveJob(storage, direction);
    return request.json(
      buildPipeline({
        direction,
        activeJob: active,
        latestJob: findLatestJob(storage, direction),
        proofs: knownProofs(storage, direction),
        head: headOf(heads, pair, direction),
        decision: board.latest(direction),
        workerWarm: active !== null && workerWarmAt(storage, direction, active.createdAt),
        estimates: await estimates(),
        now: now(),
      }),
    );
  });

  app.get("/benchmarks", async (request) => {
    const window = request.req.query("window") ?? WINDOW_LIMITS.fallback;
    const seconds = parseWindow(window);
    if (seconds === null) return request.json({ error: "window is a number and m, h or d, from 1h to 30d, such as 24h" }, 400);
    const refused = limited(request);
    if (refused !== null) return refused;
    return request.json(await benchmarks(window, seconds));
  });
}
