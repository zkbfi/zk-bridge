/**
 * The logic of the history page, apart from React: the filters and their query text, the read through the indexer with
 * the chains behind it, and the words that the page shows.
 */
import {
  compareHistoryEvents,
  createHttpChainReader,
  encodeHistoryCursor,
  fetchJsonResponse,
  DEFAULT_MAXIMUM_BLOCKS,
  historyEventKey,
  messageOnlyFilterNames,
  parseHistoryEvents,
  parseHistoryQuery,
  picksMessagesOnly,
  scanHistory,
  type ChainReader,
  type ExplorerConnection,
  type HistoryCursor,
  type HistoryEvent,
  type HistoryEventKind,
  type HistoryFilters,
  type HistoryPage,
  type HistoryScan,
  type HttpChainReaderInput,
  type JsonFetcher,
  type Pair,
} from "@zk-bridge/shared";

/** The filters of a history page that shows everything. */
export const EMPTY_HISTORY_FILTERS: HistoryFilters = Object.freeze({
  direction: null,
  kind: null,
  statuses: [],
  token: null,
  address: null,
  from: null,
  to: null,
  limit: 50,
  chain: null,
  eventKind: null,
  cursor: null,
});

/** The page size that the indexer uses when the request names none. */
const DEFAULT_LIMIT = 50;

/**
 * Reads the filters from a query string. A query that the indexer would refuse gives the empty filters, so a bad link
 * still opens a page.
 *
 * @param query The text after the question mark.
 */
export const historyFiltersFromQuery = (query: string): HistoryFilters => {
  const parsed = parseHistoryQuery(new URLSearchParams(query));
  return parsed.ok ? parsed.filters : EMPTY_HISTORY_FILTERS;
};

/**
 * Writes the filters as a query string, without the question mark. It writes only what differs from the empty filters.
 * The order is fixed, so equal filters give equal text.
 *
 * @param filters The filters.
 */
export const formatHistoryQuery = (filters: HistoryFilters): string => {
  const params = new URLSearchParams();
  if (filters.chain !== null) params.set("chain", String(filters.chain));
  if (filters.eventKind !== null) params.set("eventKind", filters.eventKind);
  if (filters.direction !== null) params.set("direction", `${filters.direction.sourceChainId}>${filters.direction.destinationChainId}`);
  if (filters.kind !== null) params.set("kind", filters.kind);
  if (filters.statuses.length > 0) params.set("status", filters.statuses.join(","));
  if (filters.token !== null) params.set("token", filters.token);
  if (filters.address !== null) params.set("address", filters.address);
  if (filters.from !== null) params.set("from", String(filters.from));
  if (filters.to !== null) params.set("to", String(filters.to));
  if (filters.limit !== DEFAULT_LIMIT) params.set("limit", String(filters.limit));
  if (filters.cursor !== null) params.set("cursor", encodeHistoryCursor(filters.cursor));
  return params.toString();
};

/** The chain of the pair that is not this one. */
const otherChainOf = (pair: Pair, chainId: number): number => (pair.sides.find((side) => side.chainId !== chainId) as Pair["sides"][number]).chainId;

/** True when an event is on the direction: a send leaves the source, a delivery arrives, a head update sits on the destination. */
const matchesDirection = (pair: Pair, event: HistoryEvent, direction: NonNullable<HistoryFilters["direction"]>): boolean => {
  if (event.kind === "head-update") return event.chainId === direction.destinationChainId;
  const source = event.kind === "sent" ? event.chainId : otherChainOf(pair, event.chainId);
  const destination = event.kind === "sent" ? otherChainOf(pair, event.chainId) : event.chainId;
  return source === direction.sourceChainId && destination === direction.destinationChainId;
};

const keepsEvent = (pair: Pair, filters: HistoryFilters, event: HistoryEvent): boolean => {
  // A head update belongs to no message, so a message filter leaves it out, as the indexer does.
  if (event.kind === "head-update" && picksMessagesOnly(filters)) return false;
  if (filters.chain !== null && event.chainId !== filters.chain) return false;
  if (filters.eventKind !== null && event.kind !== filters.eventKind) return false;
  if (filters.from !== null && event.timestamp < filters.from) return false;
  if (filters.to !== null && event.timestamp > filters.to) return false;
  return filters.direction === null || matchesDirection(pair, event, filters.direction);
};

/** A stand-in event at the position of a cursor, to compare the real events with it. */
const eventAtCursor = (cursor: HistoryCursor): HistoryEvent => {
  const isHead = cursor.kind === "head-update";
  const [chainText, slotText] = cursor.key.split("-") as [string, string];
  return {
    kind: cursor.kind,
    chainId: isHead ? Number(chainText) : 0,
    timestamp: cursor.timestamp,
    transactionHash: `0x${"00".repeat(32)}`,
    messageId: isHead ? null : (cursor.key as HistoryEvent["messageId"]),
    slot: isHead ? BigInt(slotText) : null,
    status: null,
  };
};

/**
 * Cuts a page out of events that the chains gave. It applies the filters that the chains can apply (chain, event kind,
 * direction and time) and leaves head updates out under a message filter, as the indexer does. It skips what the cursor
 * has passed and sets the next cursor as the indexer does.
 *
 * @param pair The pair.
 * @param events Every event, newest first.
 * @param filters The filters, with the page size and the cursor.
 */
export const pageOfScannedEvents = (pair: Pair, events: readonly HistoryEvent[], filters: HistoryFilters): HistoryPage => {
  const marker = filters.cursor === null ? null : eventAtCursor(filters.cursor);
  const kept = events.filter((event) => keepsEvent(pair, filters, event) && (marker === null || compareHistoryEvents(event, marker) > 0));
  const items = kept.slice(0, filters.limit);
  const last = items[items.length - 1] as HistoryEvent;
  const nextCursor = kept.length > filters.limit ? encodeHistoryCursor({ timestamp: last.timestamp, kind: last.kind, key: historyEventKey(last) }) : null;
  return { items, nextCursor, partial: true };
};

/** The parts of the page that a read needs from outside. A test passes fakes. */
export type HistoryDependencies = {
  readonly fetchJson: JsonFetcher;
  readonly createReader: (input: HttpChainReaderInput) => ChainReader;
  /** The pair with the contract addresses, or null when the page has none. */
  readonly loadPair: () => Promise<Pair | null>;
  /**
   * Gives the scan of the chains for a key, and keeps it, so a new page or a new filter does not read the chains again.
   * The default reads on every call.
   */
  readonly scanOf: (request: ScanRequest) => Promise<HistoryScan>;
};

/** A request for the scan of the chains. */
export type ScanRequest = {
  /** What the scan depends on: the pair, the endpoints and the block limit. Never the filters or the page. */
  readonly key: string;
  /** Reads the chains. It stops when the signal aborts. */
  readonly load: (signal: AbortSignal | undefined) => Promise<HistoryScan>;
  readonly signal: AbortSignal | undefined;
};

/**
 * How long a scan that nobody wants waits before it stops. A new filter ends the old read just before the new read
 * starts, and the new read must find the scan still running.
 */
const SCAN_GRACE_MILLISECONDS = 100;

const abortUnlessJoined = (entry: { readonly controller: AbortController; wanted: number }, reason: unknown): void => {
  setTimeout(() => {
    if (entry.wanted === 0) entry.controller.abort(reason);
  }, SCAN_GRACE_MILLISECONDS);
};

/**
 * Makes a scan source that shares one running scan between the reads that want it. A scan runs under its own signal,
 * not under the signal of the read that started it, so a read that leaves (a new filter, a new page) does not kill a
 * scan that another read waits for. The scan aborts when no read has wanted it for a short while. A read that leaves
 * stops waiting at once.
 *
 * @param keep Gives the scan for a key and keeps its result. It must run `load` once for a key that is already running.
 */
export const shareScans = (keep: (key: string, load: () => Promise<HistoryScan>) => Promise<HistoryScan>): HistoryDependencies["scanOf"] => {
  const running = new Map<string, { readonly controller: AbortController; readonly scan: Promise<HistoryScan>; wanted: number }>();
  return (request) => {
    let entry = running.get(request.key);
    if (entry === undefined) {
      const controller = new AbortController();
      const scan = keep(request.key, () => request.load(controller.signal));
      entry = { controller, scan, wanted: 0 };
      const started = entry;
      const forget = (): void => {
        if (running.get(request.key) === started) running.delete(request.key);
      };
      scan.then(forget, forget);
      running.set(request.key, entry);
    }
    const joined = entry;
    joined.wanted += 1;
    return new Promise<HistoryScan>((resolve, reject) => {
      let settled = false;
      const leave = (): void => {
        if (settled) return;
        settled = true;
        joined.wanted -= 1;
        if (joined.wanted === 0) abortUnlessJoined(joined, request.signal?.reason);
        reject(request.signal?.reason);
      };
      if (request.signal?.aborted === true) return leave();
      request.signal?.addEventListener("abort", leave, { once: true });
      const finish = (settle: () => void): void => {
        settled = true;
        request.signal?.removeEventListener("abort", leave);
        settle();
      };
      joined.scan.then(
        (scan) => (settled ? undefined : finish(() => resolve(scan))),
        (error: unknown) => (settled ? undefined : finish(() => reject(error))),
      );
    });
  };
};

/** A scan source that keeps nothing: every call reads the chains. */
export const unkeptScan = (request: ScanRequest): Promise<HistoryScan> => request.load(request.signal);

/** The part of a live connection that the read uses. */
export type HistoryConnection = Pick<ExplorerConnection, "baseUrl" | "run" | "resolved">;

/** What a read of the history gives. */
export type HistoryReading = {
  readonly page: HistoryPage;
  /** Which source answered. */
  readonly source: "indexer" | "rpc";
  /** The filters that are on and that this source did not apply. */
  readonly unappliedFilters: readonly string[];
  /** The chains that the scan did not read to the start of their history, with the lowest block each read. */
  readonly readBack: readonly { readonly chainId: number; readonly block: bigint }[];
};

const readFromIndexer = async (connection: HistoryConnection, filters: HistoryFilters, fetchJson: JsonFetcher, signal: AbortSignal | undefined): Promise<HistoryReading> => {
  const path = "/api/history";
  signal?.throwIfAborted();
  const response = await fetchJson(`${connection.baseUrl}${path}?${formatHistoryQuery(filters)}`, signal);
  signal?.throwIfAborted();
  if (response.status !== 200) throw new Error(`The indexer answered ${response.status} for ${path}.`);
  const page = parseHistoryEvents(response.body);
  if (page === null) throw new Error(`The indexer gave an answer for ${path} that is not a page of the history.`);
  return { page, source: "indexer", unappliedFilters: [], readBack: [] };
};

/** What a read of the history needs besides the connection. */
type ReadOptions = { readonly maximumBlocks: bigint; readonly signal: AbortSignal | undefined };

const readFromChains = async (connection: HistoryConnection, filters: HistoryFilters, dependencies: HistoryDependencies, options: ReadOptions): Promise<HistoryReading> => {
  const pair = await dependencies.loadPair();
  if (pair === null) throw new Error("The page has no deployment file, so it cannot read the chains.");
  const urls = new Map<number, string>();
  for (const side of pair.sides) {
    const url = connection.resolved.rpcUrls[side.chainId]?.value;
    if (url === undefined) throw new Error(`No endpoint is set for ${side.name}.`);
    urls.set(side.chainId, url);
  }
  const key = [pair.name, ...pair.sides.map((side) => `${side.chainId}@${urls.get(side.chainId)}`), options.maximumBlocks].join("|");
  const scanned = await dependencies.scanOf({
    key,
    signal: options.signal,
    load: (signal) => {
      const readers = new Map<number, ChainReader>(pair.sides.map((side) => [side.chainId, dependencies.createReader({ chainId: side.chainId, name: side.name, url: urls.get(side.chainId) as string })]));
      return scanHistory({ pair, readers, fromBlock: 0n, maximumBlocks: options.maximumBlocks, ...(signal === undefined ? {} : { signal }) });
    },
  });
  return {
    page: pageOfScannedEvents(pair, scanned.items, filters),
    source: "rpc",
    unappliedFilters: messageOnlyFilterNames(filters),
    readBack: scanned.coverage.filter((entry) => !entry.reachedStart).map((entry) => ({ chainId: entry.chainId, block: entry.scannedFromBlock })),
  };
};

/**
 * The dependencies of a live page.
 *
 * @param loadPair Reads the pair with its contract addresses.
 */
export const defaultHistoryDependencies = (loadPair: HistoryDependencies["loadPair"]): HistoryDependencies => ({
  fetchJson: fetchJsonResponse,
  createReader: createHttpChainReader,
  loadPair,
  scanOf: unkeptScan,
});

/**
 * Reads one page of the history. The indexer answers while the connection trusts it. Otherwise the chains answer, and
 * the page is marked partial.
 *
 * @param input The connection, the filters, the dependencies, the block limit and the signal.
 */
export const readHistory = (input: {
  readonly connection: HistoryConnection;
  readonly filters: HistoryFilters;
  readonly dependencies: HistoryDependencies;
  /** The most blocks to read on each chain when the chains answer. Default: the default of the scan. */
  readonly maximumBlocks?: bigint;
  /** Stops the read when it aborts, for example when the reader leaves the page. */
  readonly signal?: AbortSignal;
}): Promise<HistoryReading> => {
  const options: ReadOptions = { maximumBlocks: input.maximumBlocks ?? DEFAULT_MAXIMUM_BLOCKS, signal: input.signal };
  return input.connection.run({
    viaIndexer: () => readFromIndexer(input.connection, input.filters, input.dependencies.fetchJson, input.signal),
    viaRpc: () => readFromChains(input.connection, input.filters, input.dependencies, options),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
};

/** The words for each kind of event. */
export const EVENT_KIND_LABELS: Readonly<Record<HistoryEventKind, string>> = {
  sent: "Sent",
  delivered: "Delivered",
  "head-update": "Head update",
};

/**
 * The seconds at the start or the end of a day in UTC.
 *
 * @param text A date such as `2026-10-28`.
 * @param edge Whether to give the first or the last second of the day.
 * @returns The seconds, or null when the text is not a date.
 */
export const secondsOfDate = (text: string, edge: "start" | "end"): bigint | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const start = Date.parse(`${text}T00:00:00Z`);
  if (Number.isNaN(start)) return null;
  return BigInt(Math.floor(start / 1000) + (edge === "start" ? 0 : 86_399));
};

/**
 * The date, in UTC, of a time in seconds.
 *
 * @param seconds The time, or null for no time.
 * @returns The date such as `2026-10-28`, or an empty text for no time.
 */
export const dateOfSeconds = (seconds: bigint | null): string => (seconds === null ? "" : new Date(Number(seconds) * 1000).toISOString().slice(0, 10));
