import { ENDPOINT_KEYS, redactConnectionText, type ResolvedConnection } from "./connection-settings.js";
import {
  createFallbackController,
  describeFailure,
  judgeIndexerFreshness,
  type FallbackController,
  type ProbeResult,
  type SourceStatus,
} from "./fallback.js";
import type { Pair } from "./pairs.js";
import { createHttpChainReader, type ChainReader, type HttpChainReaderInput } from "./rpc/chain-reader.js";
import { createRpcExplorerApi, type RpcExplorerApi, type RpcExplorerApiOptions } from "./rpc/explorer-api.js";

/** One JSON answer with its status. A status that is not 2xx is not an error at this level. */
export type JsonResponse = { readonly status: number; readonly body: unknown };

/** Fetches a URL and parses the JSON of the answer. A test passes a fake. */
export type JsonFetcher = (url: string, signal?: AbortSignal) => Promise<JsonResponse>;

const FETCH_TIMEOUT_MILLISECONDS = 10_000;

/**
 * The fetcher that uses `fetch`, with a time limit. An answer that is not JSON has the body null. A signal from the
 * caller cancels the request as well.
 */
export const fetchJsonResponse: JsonFetcher = async (url, signal) => {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MILLISECONDS);
  const response = await fetch(url, { signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]) });
  const body: unknown = await response.json().catch(() => null);
  return { status: response.status, body };
};

/** The indexer or the RPC source gave an answer that is not a success. */
export class ConnectionAnswerError extends Error {
  override readonly name = "ConnectionAnswerError";
}

/** The inputs of {@link createExplorerConnection}. */
export type ExplorerConnectionInput = {
  /** The pair, with the addresses and the start blocks that the RPC source needs. */
  readonly pair: Pair;
  /** The URLs in force, from {@link resolveConnection}. */
  readonly resolved: ResolvedConnection;
  /** Replaces `fetch` for the indexer. */
  readonly fetchJson?: JsonFetcher;
  /** Replaces the viem client of a chain. */
  readonly createReader?: (input: HttpChainReaderInput) => ChainReader;
  /** The most seconds the indexer may lag behind the chain head before the RPC source takes over. Default 300. */
  readonly maximumIndexerLagSeconds?: number;
  /** Options of the RPC source: block span, windows per request and the like. */
  readonly rpc?: Partial<RpcExplorerApiOptions>;
  readonly freshnessIntervalMilliseconds?: number;
  readonly recoveryIntervalMilliseconds?: number;
  /** The clock in milliseconds. Default `Date.now`. */
  readonly now?: () => number;
};

/** The data path of a dashboard: the indexer with the RPC source behind it. */
export interface ExplorerConnection {
  readonly resolved: ResolvedConnection;
  /**
   * The base URL that a data source puts before `/api/...`. It is the indexer URL, or a placeholder when none is set.
   * The connection strips it from a URL to get the path for the RPC source.
   */
  readonly baseUrl: string;
  /** Reads a JSON answer from the indexer, or from the RPC source when the indexer cannot answer. */
  getJson(url: string): Promise<unknown>;
  /** The same read, but a 404 answer comes back as a value, because "unknown message" is an answer. */
  request(url: string): Promise<JsonResponse>;
  /** Runs any read with the same fallback rule, for a read that does not fit `getJson`. */
  run: FallbackController["run"];
  readonly rpc: RpcExplorerApi;
  status(): SourceStatus;
  subscribe(listener: (status: SourceStatus) => void): () => void;
  /** Checks the indexer now, and switches the source when the check says so. */
  checkNow(): Promise<void>;
  /** Removes every secret that the connection holds from a text. */
  redact(text: string): string;
}

/** The URL that stands in for the indexer when none is set. No request goes to it. */
const NO_INDEXER_BASE = "http://indexer.not-set.invalid";

/**
 * Builds the data path from the URLs in force. The indexer answers while it is reachable, correct and close to the chain
 * head. Otherwise the RPC source answers from the chains, and the connection says why. The connection checks the
 * indexer again from time to time, and goes back to it when it is healthy.
 *
 * @param input The pair, the URLs and the options.
 */
export const createExplorerConnection = (input: ExplorerConnectionInput): ExplorerConnection => {
  const { pair, resolved } = input;
  const now = input.now ?? Date.now;
  const fetchJson = input.fetchJson ?? fetchJsonResponse;
  const createReader = input.createReader ?? createHttpChainReader;
  const base = resolved.indexerUrl?.value ?? null;
  // The backend, the msgboard indexer, the archive and the msgboard node can also hold a key in the URL.
  const endpointUrls = [...ENDPOINT_KEYS.flatMap((key) => resolved[key]?.value ?? []), ...Object.values(resolved.msgboardUrls ?? {}).flatMap((setting) => (setting === null ? [] : [setting.value]))];
  const urls = [...(base === null ? [] : [base]), ...Object.values(resolved.rpcUrls).flatMap((setting) => (setting === null ? [] : [setting.value])), ...endpointUrls];
  const redact = (text: string): string => redactConnectionText(text, urls);

  const readers: Record<number, ChainReader | undefined> = Object.fromEntries(
    pair.sides.map((side) => {
      const url = resolved.rpcUrls[side.chainId]?.value;
      return [side.chainId, url === undefined ? undefined : createReader({ chainId: side.chainId, name: side.name, url })];
    }),
  );
  const rpc = createRpcExplorerApi({ pair, readers, redact, now, ...input.rpc });

  /** The time of the newest block of each chain. Without a working RPC URL for every chain, the wall clock stands in. */
  const chainTimes = async (): Promise<number[]> => {
    const wallClock = pair.sides.map(() => Math.floor(now() / 1000));
    const live = pair.sides.map((side) => readers[side.chainId]);
    if (live.some((reader) => reader === undefined)) return wallClock;
    try {
      return await Promise.all(live.map(async (reader) => Number((await (reader as ChainReader).getBlock({ tag: "latest" })).timestamp)));
    } catch {
      return wallClock;
    }
  };

  const probe = async (): Promise<ProbeResult> => {
    const response = await fetchJson(`${base}/api/heads`);
    if (response.status !== 200) return { ok: false, reason: { code: "error", message: `indexer answered ${response.status}` } };
    const heads = ((response.body as { heads?: unknown } | null)?.heads ?? []) as readonly { chainId?: unknown; ownChainTipTimestamp?: unknown }[];
    const tipOf = (chainId: number): number | null => {
      const timestamp = heads.find((head) => head.chainId === chainId)?.ownChainTipTimestamp;
      return typeof timestamp === "number" ? timestamp : null;
    };
    return judgeIndexerFreshness({
      indexerTips: pair.sides.map((side) => tipOf(side.chainId)),
      chainTips: await chainTimes(),
      maximumLagSeconds: input.maximumIndexerLagSeconds ?? 300,
    });
  };

  const controller = createFallbackController({
    indexerConfigured: base !== null,
    probe,
    describeError: (error) => {
      const reason = describeFailure(error);
      return { code: reason.code, message: redact(reason.message) };
    },
    now,
    ...(input.freshnessIntervalMilliseconds === undefined ? {} : { freshnessIntervalMilliseconds: input.freshnessIntervalMilliseconds }),
    ...(input.recoveryIntervalMilliseconds === undefined ? {} : { recoveryIntervalMilliseconds: input.recoveryIntervalMilliseconds }),
  });

  const pathOf = (url: string): string => {
    if (base !== null && url.startsWith(base)) return url.slice(base.length);
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  };

  const request = (url: string): Promise<JsonResponse> =>
    controller.run({
      viaIndexer: async () => {
        const response = await fetchJson(url);
        if (response.status >= 200 && response.status < 300) return response;
        if (response.status === 404) return response;
        throw new ConnectionAnswerError(`The indexer answered ${response.status} for ${pathOf(url).split("?")[0]}.`);
      },
      viaRpc: async () => {
        const answer = await rpc.get(pathOf(url));
        return { status: answer.status, body: answer.body };
      },
    });

  return {
    resolved,
    baseUrl: base ?? NO_INDEXER_BASE,
    async getJson(url) {
      const response = await request(url);
      if (response.status === 200) return response.body;
      const detail = (response.body as { error?: unknown } | null)?.error;
      throw new ConnectionAnswerError(`The answer for ${pathOf(url).split("?")[0]} is ${response.status}${typeof detail === "string" ? `: ${redact(detail)}` : ""}.`);
    },
    request,
    run: (operations) => controller.run(operations),
    rpc,
    status: () => controller.status(),
    subscribe: (listener) => controller.subscribe(listener),
    checkNow: () => controller.checkNow(),
    redact,
  };
};
