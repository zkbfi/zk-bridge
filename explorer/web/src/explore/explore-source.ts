/**
 * The indexer data that Explore reads beyond the data source: light-client updates (the proofs), the gates, the cost of
 * the light clients, the history, the escrow, the undelivered messages and the release events. Every answer is parsed
 * strictly; a value the indexer does not have stays null and shows as "—".
 */
import { getAddress, type Address, type Hex } from "viem";
import { createBrowseClient, secondsPerSlot, type BrowseClient } from "@zk-bridge/shared";

/** A light-client update: one proof posted on a chain. `number` counts from 1 per chain, oldest first. */
export type ProofRow = {
  readonly number: number;
  /** The chain the proof was posted on (it holds the light client). */
  readonly chainId: number;
  readonly slot: bigint;
  readonly headerRoot: Hex;
  readonly executionBlockHash: Hex;
  readonly executionBlockNumber: bigint;
  readonly transactionHash: Hex;
  /** The block of the posting transaction, on `chainId`. */
  readonly blockNumber: bigint;
  readonly timestamp: number;
  readonly gasUsed: bigint;
  readonly effectiveGasPrice: bigint;
  readonly costWei: bigint;
  readonly poster: Address;
};

/** One side's deposit gate. */
export type GateRow = {
  readonly chainId: number;
  readonly gate: Address;
  readonly enforcing: boolean;
  readonly sealed: boolean;
  readonly depositsOpen: boolean;
  readonly confirmations: number;
  readonly lastConfirmedTimestamp: number | null;
};

/** What the light clients cost per chain. */
export type LightClientCost = { readonly chainId: number; readonly updates: number; readonly gasUsed: bigint; readonly costWei: bigint };

/** One history item (any kind of event the indexer records). */
export type HistoryRow = {
  readonly kind: string;
  readonly chainId: number;
  readonly timestamp: number;
  readonly transactionHash: Hex | null;
  readonly messageId: Hex | null;
  readonly slot: bigint | null;
  readonly status: string | null;
};

/** Seconds: average, median and 90th percentile (null with no deliveries). */
export type Spread = { readonly avg: number | null; readonly median: number | null; readonly p90: number | null };

/** One window's timing: sent → delivered, and each step's median and p90 (Sent, Final, Proof ready). */
export type WindowTiming = { readonly count: number; readonly sentToDelivered: Spread; readonly steps: readonly [Spread, Spread, Spread] };

/** One direction's timing over the last 24 hours and 7 days. */
export type DirectionTiming = { readonly last24h: WindowTiming; readonly last7d: WindowTiming };

/** One direction's delivered counts, and its timing when the indexer gives it. */
export type DeliveredCounts = { readonly sourceChainId: number; readonly last24h: number; readonly last7d: number; readonly timing: DirectionTiming | null };

const secondsOrNull = (value: unknown, what: string): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`The indexer's ${what} is not a number.`);
  return value;
};

const spreadOf = (value: unknown, what: string): Spread => {
  const row = record(value, what);
  return { avg: secondsOrNull(row.avg, `${what}.avg`), median: secondsOrNull(row.median, `${what}.median`), p90: secondsOrNull(row.p90, `${what}.p90`) };
};

const windowOf = (value: unknown, what: string): WindowTiming => {
  const row = record(value, what);
  const steps = record(row.steps, `${what}.steps`);
  return {
    count: int(row.count, `${what}.count`),
    sentToDelivered: spreadOf(row.sentToDelivered, `${what}.sentToDelivered`),
    steps: [spreadOf(steps.sent, `${what}.steps.sent`), spreadOf(steps.final, `${what}.steps.final`), spreadOf(steps.ready, `${what}.steps.ready`)],
  };
};

/** Parses `/api/delivered`: counts per direction, with its timing (absent from an older indexer: null). */
export const parseDelivered = (body: unknown): readonly DeliveredCounts[] => {
  const answer = record(body, "delivered answer");
  const timing = new Map<number, DirectionTiming>();
  if (answer.timing !== undefined) {
    for (const item of array(answer.timing, "timing")) {
      const row = record(item, "timing direction");
      timing.set(int(row.sourceChainId, "timing.sourceChainId"), { last24h: windowOf(row.last24h, "timing.last24h"), last7d: windowOf(row.last7d, "timing.last7d") });
    }
  }
  const rows = array(answer.directions, "delivered directions").map((item) => {
    const row = record(item, "delivered direction");
    const sourceChainId = int(row.sourceChainId, "sourceChainId");
    return { sourceChainId, last24h: int(row.last24h, "last24h"), last7d: int(row.last7d, "last7d"), timing: timing.get(sourceChainId) ?? null };
  });
  // A direction with timing but no deliveries listed (none in 7 days) still has its (empty) timing.
  for (const [sourceChainId, direction] of timing) if (!rows.some((row) => row.sourceChainId === sourceChainId)) rows.push({ sourceChainId, last24h: 0, last7d: 0, timing: direction });
  return rows;
};

/** A tracked beacon chain's clock, from a light client's stored head: the time of slot 0. */
export type BeaconClock = { readonly trackedChainId: number; readonly genesisTime: number; readonly secondsPerSlot: number };

/**
 * Parses `/api/heads` into the tracked chains' clocks: the stored head's slot and its slot time give the genesis
 * (slot time − slot × seconds per slot). A head without a slot time gives none.
 */
export const parseBeaconClocks = (body: unknown): readonly BeaconClock[] =>
  array(record(body, "heads answer").heads, "heads").flatMap((item) => {
    const row = record(item, "head");
    const slot = intOrNull(row.storedHeadSlot, "storedHeadSlot");
    const slotTime = intOrNull(row.storedHeadSlotTimestamp, "storedHeadSlotTimestamp");
    if (slot === null || slotTime === null) return [];
    const trackedChainId = int(row.trackedChainId, "trackedChainId");
    const seconds = secondsPerSlot(trackedChainId);
    return [{ trackedChainId, genesisTime: slotTime - slot * seconds, secondsPerSlot: seconds }];
  });

/** What Explore reads from the indexer. */
export interface ExploreSource {
  proofs(): Promise<readonly ProofRow[]>;
  gates(): Promise<readonly GateRow[]>;
  lightClientCosts(): Promise<readonly LightClientCost[]>;
  history(limit: number): Promise<readonly HistoryRow[]>;
  /** The count of escrow entries, undelivered messages and release events (Explore's browse counts). */
  counts(): Promise<{ readonly escrowed: number; readonly undelivered: number; readonly releases: number }>;
  /** Per direction (by source chain), the messages delivered in the last 24 hours and 7 days (`GET /api/delivered`). */
  delivered(): Promise<readonly DeliveredCounts[]>;
  /** The tracked beacon chains' clocks, from the light clients' stored heads (`GET /api/heads`). */
  beaconClocks(): Promise<readonly BeaconClock[]>;
  /** The all-time counts and the paged, filtered, sorted lists (`GET /api/counts`, `GET /api/browse/*`). */
  readonly browse: BrowseClient;
}

type Json = Record<string, unknown>;
const record = (value: unknown, what: string): Json => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`The indexer's ${what} is not an object.`);
  return value as Json;
};
const array = (value: unknown, what: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new Error(`The indexer's ${what} is not a list.`);
  return value;
};
const int = (value: unknown, what: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`The indexer's ${what} is not a whole number.`);
  return value;
};
const big = (value: unknown, what: string): bigint => {
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  throw new Error(`The indexer's ${what} is not a whole number.`);
};
const hex = (value: unknown, what: string): Hex => {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value)) throw new Error(`The indexer's ${what} is not hex.`);
  return value.toLowerCase() as Hex;
};
const address = (value: unknown, what: string): Address => getAddress(hex(value, what));
const intOrNull = (value: unknown, what: string): number | null => (value === null || value === undefined ? null : int(value, what));

/** Parses `/api/head-updates`; numbers the proofs per chain, oldest first. */
export const parseProofs = (body: unknown): readonly ProofRow[] => {
  const rows = array(record(body, "head updates").items, "head updates").map((item) => {
    const row = record(item, "head update");
    return {
      chainId: int(row.chainId, "chainId"),
      slot: big(row.slot, "slot"),
      headerRoot: hex(row.headerRoot, "headerRoot"),
      executionBlockHash: hex(row.executionBlockHash, "executionBlockHash"),
      executionBlockNumber: big(row.executionBlockNumber, "executionBlockNumber"),
      transactionHash: hex(row.transactionHash, "transactionHash"),
      blockNumber: big(row.blockNumber, "blockNumber"),
      timestamp: int(row.timestamp, "timestamp"),
      gasUsed: big(row.gasUsed, "gasUsed"),
      effectiveGasPrice: big(row.effectiveGasPrice, "effectiveGasPrice"),
      costWei: big(row.costWei, "costWei"),
      poster: address(row.poster, "poster"),
    };
  });
  const oldestFirst = [...rows].sort((a, b) => a.timestamp - b.timestamp);
  const counters = new Map<number, number>();
  return oldestFirst
    .map((row) => {
      const number = (counters.get(row.chainId) ?? 0) + 1;
      counters.set(row.chainId, number);
      return { ...row, number };
    })
    .reverse();
};

/** Parses `/api/gate`. */
export const parseGates = (body: unknown): readonly GateRow[] =>
  array(record(body, "gate answer").sides, "gate sides").map((item) => {
    const row = record(item, "gate side");
    return {
      chainId: int(row.chainId, "chainId"),
      gate: address(row.gate, "gate"),
      enforcing: row.enforcing === true,
      sealed: row.sealed === true,
      depositsOpen: row.depositsOpen === true,
      confirmations: int(row.confirmations ?? 0, "confirmations"),
      lastConfirmedTimestamp: intOrNull(row.lastConfirmedTimestamp, "lastConfirmedTimestamp"),
    };
  });

/** Parses `/api/light-client-costs`. */
export const parseLightClientCosts = (body: unknown): readonly LightClientCost[] =>
  array(record(body, "light-client costs").perChain, "perChain").map((item) => {
    const row = record(item, "light-client cost");
    return { chainId: int(row.chainId, "chainId"), updates: int(row.updates, "updates"), gasUsed: big(row.gasUsed, "gasUsed"), costWei: big(row.costWei, "costWei") };
  });

/** Parses `/api/history`. */
export const parseHistory = (body: unknown): readonly HistoryRow[] =>
  array(record(body, "history").items, "history").map((item) => {
    const row = record(item, "history item");
    return {
      kind: typeof row.kind === "string" ? row.kind : "unknown",
      chainId: int(row.chainId, "chainId"),
      timestamp: int(row.timestamp, "timestamp"),
      transactionHash: row.transactionHash === null || row.transactionHash === undefined ? null : hex(row.transactionHash, "transactionHash"),
      messageId: row.messageId === null || row.messageId === undefined ? null : hex(row.messageId, "messageId"),
      slot: row.slot === null || row.slot === undefined ? null : big(row.slot, "slot"),
      status: typeof row.status === "string" ? row.status : null,
    };
  });

/** Gets JSON from the indexer. A test passes a fake. */
export type ExploreRequester = (url: string) => Promise<unknown>;

const fetchJson: ExploreRequester = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`The indexer answered ${response.status} for ${new URL(url).pathname}.`);
  return response.json();
};

/**
 * The source over an indexer.
 *
 * @param baseUrl The indexer's base URL now (the user may change it in Settings), or null when none is set.
 * @param request Replaces `fetch`.
 */
export const createIndexerExploreSource = (baseUrl: () => string | null, request: ExploreRequester = fetchJson): ExploreSource => {
  const get = async (path: string): Promise<unknown> => {
    const base = baseUrl();
    if (base === null) throw new Error("No indexer is set; set one in Settings.");
    return request(`${base.replace(/\/$/, "")}${path}`);
  };
  return {
    browse: createBrowseClient(baseUrl, request),
    proofs: async () => parseProofs(await get("/api/head-updates?limit=200")),
    gates: async () => parseGates(await get("/api/gate")),
    lightClientCosts: async () => parseLightClientCosts(await get("/api/light-client-costs")),
    history: async (limit) => parseHistory(await get(`/api/history?limit=${limit}`)),
    delivered: async () => parseDelivered(await get("/api/delivered")),
    beaconClocks: async () => parseBeaconClocks(await get("/api/heads")),
    counts: async () => {
      const [escrow, undelivered, releases] = await Promise.all([get("/api/escrow"), get("/api/undelivered"), get("/api/release-events")]);
      return {
        escrowed: array(record(escrow, "escrow").escrow, "escrow").length,
        undelivered: array(record(undelivered, "undelivered").items, "undelivered").length,
        releases: array(record(releases, "release events").events, "release events").length,
      };
    },
  };
};
