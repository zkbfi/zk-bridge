/**
 * The read routes of the pipeline: `GET /progress/:messageId`, `GET /directions/:direction/pipeline` and
 * `GET /benchmarks`, `GET /billing` and `GET /warmup/summary` (the old name of `/billing`). They answer from the backend database, the watcher's latest decision and the chain indexer, and
 * never name an endpoint, a key or a path. Each caller may read {@link READS_PER_CALLER_PER_MINUTE} times a minute.
 */
import type { Context, Hono } from "hono";
import { PROOF_DIRECTIONS, deliveryRangeOfStat, epochSeconds, provingPartsOf, saneProvingParts, secondsPerSlot, type Pair, type PairSide, type ProofDirection } from "@zk-bridge/shared";
import { figuresOf, publicFiguresOf } from "../billing.ts";
import { accountTimeline, billedThroughOf, breakdownOfSpans, daySpan, hourSpans, sumBreakdowns } from "../billing-breakdown.ts";
import { createIdleHistory } from "../idle-history.ts";
import type { BackendModuleContext } from "../module.ts";
import { findActiveJob, findLatestJob, getJob, listJobsSince, type PlannedJob } from "../requests/jobs.ts";
import { getTiming, listTimings, provedJobsSince, recentTimings, statOf } from "../requests/timings.ts";
import type { Storage } from "../storage.ts";
import { decisionBoardOf } from "../watch/decisions.ts";
import { createWarmupStore } from "../watch/warmup-store.ts";
import { buildBenchmarks, parseWindow, WINDOW_LIMITS, type Benchmarks } from "./benchmarks.ts";
import { createIndexerReads, type IndexedHead, type IndexerReads } from "./indexer.ts";
import { buildPipeline, knownProofs, pipelineRuleOf } from "./pipeline.ts";
import { batchRuleFor } from "../watch/batch.ts";
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

  /** The batch rule of a direction, as the watcher resolves it, and whether the pair has a PulseChain mainnet side to price on. */
  const ruleOf = (direction: ProofDirection) =>
    pipelineRuleOf(
      batchRuleFor(context.config.watch, context.config.pair, direction, epochSeconds(sidesOf(pair, direction).source.chainId)),
      pair.sides.some((side) => side.chainId === 369),
    );

  let estimateCache: { at: number; value: Promise<Benchmarks> } | null = null;

  /**
   * Medians for the `eta` of a stage: the prover's run from the newest proofs, the steps after it and the delivery from
   * a day of benchmarks. The proving steps go through the dapp's own rules (`provingPartsOf`, `saneProvingParts`,
   * `deliveryRangeOfStat` in `@zkb/core`): too few runs, or a sum past the sanity limit, gives no `eta`.
   */
  async function estimates(): Promise<Estimates> {
    const recent = recentTimings(storage, ESTIMATE_SAMPLE);
    if (estimateCache === null || now() - estimateCache.at >= ESTIMATE_REUSE_MILLISECONDS) estimateCache = { at: now(), value: benchmarks("24h", 86_400) };
    const day = await estimateCache.value;
    const total = statOf(recent.map((timing) => timing.totalMs));
    const proving = saneProvingParts(provingPartsOf({ total, webhookToBoard: day.steps.webhookToBoard, proofToOnChain: day.steps.proofToOnChain }));
    const delivery = deliveryRangeOfStat(day.steps.coveredToDelivered);
    return {
      workerWaitMs: statOf(recent.filter((timing) => (timing.notReadyCount ?? 0) > 0).map((timing) => timing.waitWorkerMs)).medianMs,
      totalMs: proving === null ? null : total.medianMs,
      webhookToBoardMs: proving === null ? null : day.steps.webhookToBoard.medianMs,
      proofToOnChainMs: proving === null ? null : day.steps.proofToOnChain.medianMs,
      coveredToDeliveredMs: delivery === null ? null : day.steps.coveredToDelivered.medianMs,
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
        rule: ruleOf(direction),
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

  /**
   * Reads and prices the window of a billing request: the figures from RunPod, the rate and the worker sessions
   * started before a proof, per UTC day. Null with the answer to send when `days` is not 1 to 30 or the caller is limited.
   */
  async function billingWindow(request: Context) {
    const text = request.req.query("days") ?? "7";
    const days = /^\d+$/.test(text) ? Number(text) : 0;
    if (days < 1 || days > 30) return { refused: request.json({ error: "days is a whole number from 1 to 30" }, 400) };
    const refused = limited(request);
    if (refused !== null) return { refused };
    const { idleTimeoutSeconds, gpuUsdPerHour, dailyCapSeconds } = context.config.watch.warmup;
    const at = now();
    const snapshot = context.billing === undefined ? { spend: null, balance: null } : await context.billing.read();
    const figures = figuresOf(snapshot, at);
    // The rate that RunPod billed; the configured price only when RunPod's billing cannot be read.
    const rateSource = figures.effectiveUsdPerHour === null ? ("assumed" as const) : ("runpod" as const);
    const usdPerHour = figures.effectiveUsdPerHour ?? gpuUsdPerHour;
    const warmups = createWarmupStore(storage);
    const sessionDays = warmups.summary(at - days * 86_400_000, { idleTimeoutSeconds, gpuUsdPerHour: usdPerHour });
    // The records of the window plus a day before it, so that a tail or a session that crosses midnight is whole.
    const recordsFrom = at - (days + 1) * 86_400_000;
    const idleHistory = createIdleHistory(storage);
    const timeline = accountTimeline({ sessions: warmups.endedSessions(recordsFrom), jobs: provedJobsSince(storage, recordsFrom), idleSecondsAt: (at) => idleHistory.secondsAt(at, idleTimeoutSeconds) });
    // The account (balance, spend limit, spend now, days left) only for a direct local request, such as the status
    // service on 127.0.0.1. Caddy adds X-Forwarded-For to every request it passes on, so a request from the internet
    // never sees them; the backend listens on 127.0.0.1 only.
    const local = request.req.header("x-forwarded-for") === undefined;
    const shown = figures;
    return { days, at, snapshot, figures, shown, local, rateSource, usdPerHour, sessionDays, timeline, assumptions: { idleTimeoutSeconds, endpointIdleTimeoutSeconds: context.endpointIdleTimeoutSeconds?.() ?? null, gpuUsdPerHour, gpuUsdPerHourIsFallback: true, dailyCapSeconds } };
  }

  const money = (value: number) => Math.round(value * 10_000) / 10_000;

  /**
   * GPU billing in general: what RunPod billed per UTC day and in total, the last 24 hours, the rate and where it comes
   * from, and (only for a direct local request) the account. `earlyStarts` is the part of it that workers started before
   * a proof account for: sessions, used and unused, the billed seconds of the unused ones priced at the rate, and the
   * seconds a worker sat ready before the due time (`waitingSeconds`). `breakdown`, on each day, in the total and in
   * `last24h`, says where the billed seconds went, each period at its own RunPod rate and only up to `billedThrough` (rules in `billing-breakdown.ts`). `days`: 1 to 30, default 7.
   */
  app.get("/billing", async (request) => {
    const window = await billingWindow(request);
    if ("refused" in window) return window.refused;
    const { days, at, snapshot, shown, local, rateSource, usdPerHour, sessionDays, timeline, assumptions } = window;
    const earlyOf = new Map(sessionDays.map((day) => [day.day, day]));
    const early = (day: (typeof sessionDays)[number] | undefined) => ({
      sessions: day?.sessions ?? 0,
      used: day?.used ?? 0,
      unused: day?.wasted ?? 0,
      unusedSeconds: day?.wastedSeconds ?? 0,
      unusedUsd: day?.wastedCostUsd ?? 0,
      waitingSeconds: day?.idleBeforeDueSeconds ?? 0,
    });
    const first = new Date(at - days * 86_400_000).toISOString().slice(0, 10);
    const billedOf = new Map((snapshot.spend?.days ?? []).filter((day) => day.start >= first).map((day) => [day.start, day]));
    const billedThrough = billedThroughOf(snapshot.spend, at);
    const dayKeys = [...new Set([...billedOf.keys(), ...earlyOf.keys()])].sort().reverse();
    const byDay = dayKeys.map((day) => {
      const billed = billedOf.get(day);
      const dayStart = Date.parse(`${day}T00:00:00Z`);
      return {
        day,
        breakdown: breakdownOfSpans(timeline, [daySpan({ dayStart, row: billed, hours: snapshot.spend?.hours ?? [], billedThrough, fallbackUsdPerHour: usdPerHour })], billedThrough),
        billedUsd: billed === undefined ? null : money(billed.amountUsd),
        billedSeconds: billed === undefined ? null : Math.round(billed.billedSeconds * 100) / 100,
        effectiveUsdPerHour: billed !== undefined && billed.billedSeconds > 0 ? money(billed.amountUsd / (billed.billedSeconds / 3600)) : null,
        earlyStarts: early(earlyOf.get(day)),
      };
    });
    const sum = (pick: (day: (typeof byDay)[number]) => number) => money(byDay.reduce((total, day) => total + pick(day), 0));
    const billedDays = byDay.filter((day) => day.billedUsd !== null);
    const billedUsd = billedDays.length === 0 ? null : sum((day) => day.billedUsd ?? 0);
    const billedSeconds = billedDays.length === 0 ? null : sum((day) => day.billedSeconds ?? 0);
    const breakdownTotal = sumBreakdowns(byDay.map((day) => day.breakdown));
    const earlyTotal = {
      sessions: sum((day) => day.earlyStarts.sessions),
      used: sum((day) => day.earlyStarts.used),
      unused: sum((day) => day.earlyStarts.unused),
      unusedSeconds: sum((day) => day.earlyStarts.unusedSeconds),
      unusedUsd: sum((day) => day.earlyStarts.unusedUsd),
      waitingSeconds: sum((day) => day.earlyStarts.waitingSeconds),
    };
    const last24h = breakdownOfSpans(timeline, hourSpans({ at, hours: snapshot.spend?.hours ?? [], billedThrough, fallbackUsdPerHour: usdPerHour }), billedThrough);
    return request.json({
      days,
      /** Where the price of a GPU hour comes from: "runpod" (measured from RunPod's billing) or "assumed" (the configured price, a fallback). */
      rateSource,
      usdPerHour,
      assumptions,
      /** Whether RunPod's billing could be read, and how many seconds ago. */
      available: shown.available,
      ageSeconds: shown.ageSeconds,
      last24h: { billedUsd: shown.last24hUsd, billedSeconds: shown.last24hBilledSeconds, breakdown: last24h },
      effectiveUsdPerHour: shown.effectiveUsdPerHour,
      averageDailyUsd7d: shown.averageDailyUsd7d,
      // Left out, not nulled, for a request that came through Caddy.
      ...(local ? { account: { balanceUsd: shown.balanceUsd, balanceAgeSeconds: shown.balanceAgeSeconds, spendNowUsdPerHour: shown.currentSpendPerHr, spendLimitUsd: shown.spendLimit, daysLeft: shown.balanceDaysLeft } } : {}),
      total: {
        billedUsd,
        billedSeconds,
        effectiveUsdPerHour: billedUsd === null || billedSeconds === null || billedSeconds === 0 ? null : money(billedUsd / (billedSeconds / 3600)),
        earlyStarts: earlyTotal,
        breakdown: breakdownTotal,
      },
      byDay,
    });
  });

  /** @deprecated The old name of `/billing`, kept with its old body: warm-up sessions with RunPod billing beside them. */
  app.get("/warmup/summary", async (request) => {
    const window = await billingWindow(request);
    if ("refused" in window) return window.refused;
    const { days, snapshot, shown, local, rateSource, usdPerHour, sessionDays: warmupDays, assumptions } = window;
    const billedOf = new Map((snapshot.spend?.days ?? []).map((day) => [day.start, day]));
    const byDay = warmupDays.map((day) => {
      const billed = billedOf.get(day.day);
      return {
        ...day,
        billedUsd: billed === undefined ? null : Math.round(billed.amountUsd * 10_000) / 10_000,
        runpodBilledSeconds: billed === undefined ? null : Math.round(billed.billedSeconds * 100) / 100,
        effectiveUsdPerHour: billed !== undefined && billed.billedSeconds > 0 ? Math.round((billed.amountUsd / (billed.billedSeconds / 3600)) * 10_000) / 10_000 : null,
      };
    });
    const sum = (pick: (day: (typeof byDay)[number]) => number) => Math.round(byDay.reduce((total, day) => total + pick(day), 0) * 10_000) / 10_000;
    const billedDays = byDay.filter((day) => day.billedUsd !== null);
    return request.json({
      days,
      /** Where the price of a GPU hour comes from: "runpod" (measured from RunPod's billing) or "assumed" (the configured price, a fallback). */
      rateSource,
      usdPerHour,
      assumptions,
      // The account fields are left out, not nulled, for a request that came through Caddy.
      billing: local ? shown : publicFiguresOf(shown),
      total: {
        sessions: sum((day) => day.sessions),
        used: sum((day) => day.used),
        wasted: sum((day) => day.wasted),
        billedSeconds: sum((day) => day.billedSeconds),
        wastedSeconds: sum((day) => day.wastedSeconds),
        idleBeforeDueSeconds: sum((day) => day.idleBeforeDueSeconds),
        estimatedCostUsd: sum((day) => day.estimatedCostUsd),
        wastedCostUsd: sum((day) => day.wastedCostUsd),
        billedUsd: billedDays.length === 0 ? null : sum((day) => day.billedUsd as number),
        runpodBilledSeconds: billedDays.length === 0 ? null : sum((day) => day.runpodBilledSeconds as number),
      },
      byDay,
    });
  });
}
