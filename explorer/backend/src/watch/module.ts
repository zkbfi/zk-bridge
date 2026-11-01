/**
 * Prove on finality. The requests module starts this next to its request service: per watched direction one finality
 * feed of the source beacon node and one watcher that starts the job through the same service, so the same gates,
 * caps and one-job rule apply as to a request from outside.
 */
import { createPublicClient, http, type Hex } from "viem";
import { z } from "zod";
import { PROOF_DIRECTIONS, secondsPerSlot, type Pair, type PairSide, type ProofDirection } from "@zk-bridge/shared";
import { BackendConfigError, type BackendConfig } from "../config.ts";
import { DEFAULT_POLICY, type LightClientFacts } from "../keepalive/plan.ts";
import { fetchJsonGet, readHistory, readLightClient, type JsonGet } from "../keepalive/sources.ts";
import type { BackendModuleContext } from "../module.ts";
import { findActiveJob, findLatestJob } from "../requests/jobs.ts";
import type { RequestService } from "../requests/service.ts";
import { MIN_PARTICIPANTS } from "./decide.ts";
import { createFinalityFeed } from "./feed.ts";
import { createDirectionWatcher, type ListedMessage } from "./watcher.ts";
import { createWarmupStore } from "./warmup-store.ts";

/** How long one beacon or indexer read of the watcher may take, in milliseconds. Short: the watcher races the clock. */
export const WATCH_READ_TIMEOUT_MILLISECONDS = 10_000;

/** The event stream fails when the node sends no headers within this many milliseconds (some proxies hold them). */
export const SSE_OPEN_TIMEOUT_MILLISECONDS = 10_000;

/** The first and the longest wait before the event stream is tried again. */
export const SSE_RETRY_MILLISECONDS = { initial: 5_000, max: 300_000 } as const;

/** How many sent messages of a direction the watcher reads from the indexer. */
export const MESSAGE_LIMIT = 100;

/** A refusal of the request service with a longer wait than this is left to the next finality. */
export const MAX_RETRY_SECONDS = 600;

/** The two sides of a direction: the source chain and the chain of the light client. */
function sidesOf(pair: Pair, direction: ProofDirection): { source: PairSide; destination: PairSide } {
  const [first, second] = pair.sides;
  return direction === "first-to-second" ? { source: first, destination: second } : { source: second, destination: first };
}

/**
 * The directions to watch, or an empty list when the watch is off. Default: on when the indexer and the beacon
 * endpoint of every watched source chain are configured.
 *
 * @throws BackendConfigError when `watch.enabled` is true and the indexer or a beacon endpoint is missing.
 */
export function watchedDirections(config: BackendConfig, pair: Pair): readonly ProofDirection[] {
  const directions = config.watch.directions ?? PROOF_DIRECTIONS;
  if (config.watch.enabled === false) return [];
  const missing = [
    ...(config.indexerUrl === undefined ? ["indexerUrl"] : []),
    ...directions.filter((direction) => sidesOf(pair, direction).source.beaconUrl === null).map((direction) => `beaconUrls.${sidesOf(pair, direction).source.chainId}`),
  ];
  if (missing.length === 0) return directions;
  if (config.watch.enabled === true) throw new BackendConfigError(`watch.enabled needs ${missing.join(" and ")}`);
  return [];
}

const feedSchema = z.object({
  items: z.array(
    z.object({
      messageId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      sent: z.object({ timestamp: z.number().int() }).passthrough().nullable(),
    }).passthrough(),
  ),
});

/** Reads the sent and waiting messages of a direction from the indexer. */
function messageReader(input: { indexerUrl: string; source: PairSide; destination: PairSide; get: JsonGet }): () => Promise<readonly ListedMessage[]> {
  const base = input.indexerUrl.replace(/\/+$/, "");
  const query = new URLSearchParams({ direction: `${input.source.chainId}>${input.destination.chainId}`, status: "sent,waiting_for_finality", limit: String(MESSAGE_LIMIT) });
  return async () => {
    const answer = await input.get(`${base}/api/feed?${query}`);
    if (answer.status !== 200) throw new Error(`the chain indexer answered ${answer.status} for the feed`);
    const parsed = feedSchema.safeParse(answer.body);
    if (!parsed.success) throw new Error("the chain indexer sent the feed in an unknown shape");
    return parsed.data.items.flatMap((item) => (item.sent === null ? [] : [{ messageId: item.messageId as Hex, timestamp: item.sent.timestamp }]));
  };
}

/** What a test replaces. */
export type WatchDependencies = {
  /** The fetch of the beacon reads, the event stream and the indexer. Default: the global one, read at call time. */
  readonly fetchFunction?: () => typeof fetch;
  /** Reads the light client on the destination side. Default: viem over the side's RPC endpoint. */
  readonly readLightClient?: (side: PairSide) => Promise<LightClientFacts>;
};

/**
 * Starts a feed and a watcher per watched direction. Resolves with the function that stops them all.
 *
 * @throws BackendConfigError as {@link watchedDirections}.
 */
export async function startWatch(input: { context: BackendModuleContext; service: RequestService; dependencies?: WatchDependencies }): Promise<() => Promise<void>> {
  const { context, service } = input;
  const { config, pair, logger } = context;
  const directions = watchedDirections(config, pair);
  if (directions.length === 0) {
    logger.info("watch_off", { reason: config.watch.enabled === false ? "watch.enabled is false" : "indexerUrl or a beacon endpoint is not set" });
    return async () => {};
  }
  const fetchFunction = input.dependencies?.fetchFunction ?? (() => globalThis.fetch);
  const get: JsonGet = (url) => fetchJsonGet(fetchFunction(), WATCH_READ_TIMEOUT_MILLISECONDS)(url);
  const readFacts = input.dependencies?.readLightClient ?? ((side: PairSide) => readLightClient(createPublicClient({ transport: http(side.rpcUrl) }), side.contracts.lightClient));
  const ping = config.watch.warmup.enabled ? (context.pingProver ?? null) : null;
  const { leadSeconds: ignoredLead, ...warmup } = config.watch.warmup;
  if (ignoredLead !== undefined) logger.warn("config_ignored", { key: "watch.warmup.leadSeconds", detail: "the lead time is learned now; set defaultLeadSeconds, minLeadSeconds and maxLeadSeconds instead" });
  const warmupStore = createWarmupStore(context.storage);
  // A session open from before this start ran in a process that is gone: end it so the daily cap stops counting it.
  const closed = warmupStore.closeOpenSessions(context.now());
  if (closed > 0) logger.info("warmup_sessions_closed", { count: closed });
  const stoppers: Array<() => Promise<void>> = [];
  for (const direction of directions) {
    const { source, destination } = sidesOf(pair, direction);
    const beaconUrl = source.beaconUrl as string;
    const watcher = createDirectionWatcher({
      pairName: config.pair,
      direction,
      sourceChainId: source.chainId,
      readFacts: () => readFacts(destination),
      readMessages: messageReader({ indexerUrl: config.indexerUrl as string, source, destination, get }),
      readHistory: (periods, slotsPerPeriod) => readHistory(get, beaconUrl, periods, slotsPerPeriod),
      findActiveJob: () => findActiveJob(context.storage, direction),
      findLatestJob: () => findLatestJob(context.storage, direction),
      submit: (request) => service.submit(request),
      ping,
      policy: { ...DEFAULT_POLICY, keepAliveSeconds: config.limits.keepAliveSeconds },
      minParticipants: MIN_PARTICIPANTS,
      warmup,
      warmupStore,
      maxRetrySeconds: MAX_RETRY_SECONDS,
      logger,
      now: context.now,
    });
    const slotMilliseconds = secondsPerSlot(source.chainId) * 1000;
    const feed = createFinalityFeed({
      chainId: source.chainId,
      beaconUrl,
      minParticipants: MIN_PARTICIPANTS,
      sse: config.watch.sse,
      pollMilliseconds: (config.watch.pollSeconds ?? secondsPerSlot(source.chainId)) * 1000,
      sseOpenTimeoutMilliseconds: SSE_OPEN_TIMEOUT_MILLISECONDS,
      // A node sends a head event every slot: three silent slots mean the stream is gone.
      sseIdleMilliseconds: 3 * slotMilliseconds + 5_000,
      sseRetryMilliseconds: SSE_RETRY_MILLISECONDS,
      get,
      fetchFunction,
      logger,
      now: context.now,
      onObservation: (observation) => watcher.observe(observation),
    });
    feed.start();
    const scanTimer = setInterval(() => void watcher.scan(), config.watch.scanSeconds * 1000);
    scanTimer.unref();
    stoppers.push(async () => {
      clearInterval(scanTimer);
      await feed.stop();
      await watcher.stop();
    });
  }
  logger.info("watch_started", { directions, sse: config.watch.sse, warmup: ping !== null, lead: warmupStore.lead(warmup) });
  return async () => {
    await Promise.all(stoppers.map((stop) => stop()));
  };
}
