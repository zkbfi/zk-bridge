import type { Address, Hex } from "viem";
import { tokenKey } from "../api-views.js";
import { sideOf, type Pair, type PairSide } from "../pairs.js";
import { nativeTokenBehind, readTokenMetadata } from "../token-facts.js";
import { assemble, collectNeeds, type Assembled, type CurrentHead, type TokenReading } from "./assemble.js";
import type { ChainBlock, ChainLog, ChainReader, ChainReceipt } from "./chain-reader.js";
import { createChainScan, type ChainScan } from "./chain-scan.js";
import { createSerialQueue, mapWithLimit } from "./concurrency.js";
import { logSourcesOf } from "./events.js";
import { readExecutionBlockNumber, readStoredHead } from "./live-reads.js";

/** The RPC URL of a chain is not set, so the RPC source cannot read it. */
export class ConnectionNotSetError extends Error {
  override readonly name = "ConnectionNotSetError";
}

/** The options of the RPC data source. */
export type RpcExplorerOptions = {
  readonly pair: Pair;
  /** The reader of each chain by chain identifier. A chain with no reader makes a call fail with {@link ConnectionNotSetError}. */
  readonly readers: Readonly<Record<number, ChainReader | undefined>>;
  /** The most blocks in one `eth_getLogs` window. Default 2000. */
  readonly blockSpan?: number;
  /** A window that a provider refuses for its size splits down to this many blocks. Default 50. */
  readonly minimumBlockSpan?: number;
  /** How many older windows one request may read. Default 6. */
  readonly maxWindowsPerRequest?: number;
  /** Blocks that a forward scan reads again, to follow a reorganization. Default 24. */
  readonly reorgDepth?: number;
  /** How long the latest block stays fresh, in milliseconds. Default 4000. */
  readonly headMaxAgeMilliseconds?: number;
  /** Calls in flight at once for the small reads. Default 6. */
  readonly concurrency?: number;
  /** The clock in milliseconds. Default `Date.now`. */
  readonly now?: () => number;
};

/** The chains of one pair, read at one moment. */
export type Snapshot = {
  readonly assembled: Assembled;
  readonly logs: ReadonlyMap<number, readonly ChainLog[]>;
  /** The latest block of each chain. */
  readonly tips: ReadonlyMap<number, ChainBlock>;
  /** The head that the light client of each chain stores now. */
  readonly heads: ReadonlyMap<number, CurrentHead | null>;
  /** The lowest block that each scan covers. */
  readonly scannedFromBlock: ReadonlyMap<number, bigint>;
  /** True per chain when its scan covers the history down to the start block. */
  readonly reachedStart: ReadonlyMap<number, boolean>;
  /** The timestamp of the lowest scanned block per chain, or null when the scan reached the start block. */
  readonly oldestTimestamp: ReadonlyMap<number, bigint | null>;
  /**
   * The send time from which every message is fully known: a message sent before it may have a delivery that lies
   * before the scan of the destination chain. Null when both scans reached the start block.
   */
  readonly horizon: bigint | null;
  /** True when both scans reached the start block, so the history is complete. */
  readonly complete: boolean;
};

/** The state of the RPC data source: the scans, the caches of chain reads, and the snapshot built from them. */
export interface RpcExplorer {
  readonly pair: Pair;
  readonly maxWindowsPerRequest: number;
  readonly concurrency: number;
  /** The reader of a chain. @throws ConnectionNotSetError when the chain has none. */
  readerOf(chainId: number): ChainReader;
  /** Runs a task after the earlier tasks finish. Every request goes through it, so scans never overlap. */
  exclusive<value>(task: () => Promise<value>): Promise<value>;
  /** Reads the first window of each chain, or the new blocks since the last call. */
  prepare(): Promise<void>;
  /** Reads one older window on the chain whose history is the shortest. False when both reached the start block. */
  extendOlder(): Promise<boolean>;
  snapshot(): Promise<Snapshot>;
  /** The timestamp of a block. */
  blockTimestamp(chainId: number, blockNumber: bigint): Promise<bigint>;
  /** A transaction receipt. The answer is kept. */
  receipt(chainId: number, hash: Hex): Promise<ChainReceipt>;
  /** The latest block of a chain. */
  tip(chainId: number): Promise<ChainBlock>;
}

const DEFAULT_BLOCK_SPAN = 2000;
const DEFAULT_MINIMUM_SPAN = 50;
const DEFAULT_WINDOWS = 6;
const DEFAULT_REORG_DEPTH = 24;
const DEFAULT_HEAD_AGE = 4000;
const DEFAULT_CONCURRENCY = 6;
/** A token that gave no decimals is read again after this long. */
const UNREAD_TOKEN_RETRY_MILLISECONDS = 60_000;

/**
 * Creates the state of the RPC data source.
 *
 * @param options The pair, the readers of its chains and the limits.
 */
export const createRpcExplorer = (options: RpcExplorerOptions): RpcExplorer => {
  const { pair } = options;
  const now = options.now ?? Date.now;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const exclusive = createSerialQueue();
  const scans = new Map<number, ChainScan>();
  const readings = new Map<string, { readonly reading: TokenReading; readonly readAt: number }>();
  const executionBlocks = new Map<string, bigint>();
  const receipts = new Map<string, Promise<ChainReceipt>>();
  let cached: { readonly snapshot: Snapshot; readonly builtAt: number } | null = null;

  const readerOf = (chainId: number): ChainReader => {
    const reader = options.readers[chainId];
    if (reader === undefined) throw new ConnectionNotSetError(`No RPC URL is set for ${sideOf(pair, chainId).name}.`);
    return reader;
  };

  const scanOf = (side: PairSide): ChainScan => {
    const existing = scans.get(side.chainId);
    if (existing !== undefined) return existing;
    const created = createChainScan({
      reader: readerOf(side.chainId),
      sources: logSourcesOf(side),
      startBlock: BigInt(side.startBlock),
      blockSpan: BigInt(options.blockSpan ?? DEFAULT_BLOCK_SPAN),
      minimumBlockSpan: BigInt(options.minimumBlockSpan ?? DEFAULT_MINIMUM_SPAN),
      reorgDepth: BigInt(options.reorgDepth ?? DEFAULT_REORG_DEPTH),
      headMaxAgeMilliseconds: options.headMaxAgeMilliseconds ?? DEFAULT_HEAD_AGE,
      now,
    });
    scans.set(side.chainId, created);
    return created;
  };

  const readToken = async (chainId: number, address: Address): Promise<TokenReading> => {
    const key = tokenKey(chainId, address);
    const known = readings.get(key);
    if (known !== undefined && (known.reading.decimals !== null || now() - known.readAt < UNREAD_TOKEN_RETRY_MILLISECONDS)) return known.reading;
    const reader = readerOf(chainId);
    const [metadata, nativeBehind] = await Promise.all([
      readTokenMetadata(reader, address),
      nativeTokenBehind(reader, sideOf(pair, chainId).contracts.mediator, address),
    ]);
    const reading = { ...metadata, nativeBehind };
    readings.set(key, { reading, readAt: now() });
    return reading;
  };

  const readExecutionBlock = async (chainId: number, hash: Hex): Promise<bigint> => {
    const key = `${chainId}:${hash}`;
    const known = executionBlocks.get(key);
    if (known !== undefined) return known;
    const number = await readExecutionBlockNumber(readerOf(chainId), sideOf(pair, chainId), hash);
    executionBlocks.set(key, number);
    return number;
  };

  const oldestOf = async (side: PairSide): Promise<bigint | null> => scanOf(side).oldestTimestamp();

  const buildSnapshot = async (): Promise<Snapshot> => {
    const logs = new Map(pair.sides.map((side) => [side.chainId, scanOf(side).logs()] as const));
    const needs = collectNeeds(pair, logs);
    const timestamps = new Map<string, bigint>();
    await mapWithLimit(needs.timestampBlocks, concurrency, async ({ chainId, blockNumber }) => {
      timestamps.set(`${chainId}:${blockNumber}`, await scanOf(sideOf(pair, chainId)).blockTimestamp(blockNumber));
    });
    await mapWithLimit(needs.tokens, concurrency, ({ chainId, address }) => readToken(chainId, address));
    await mapWithLimit(needs.headHashes, concurrency, ({ chainId, hash }) => readExecutionBlock(chainId, hash));
    const tips = new Map<number, ChainBlock>();
    for (const side of pair.sides) tips.set(side.chainId, await scanOf(side).head());
    const heads = new Map<number, CurrentHead | null>();
    for (const side of pair.sides) {
      const stored = await readStoredHead(readerOf(side.chainId), side);
      const update = [...(logs.get(side.chainId) as readonly ChainLog[])].reverse().find((log) => log.eventName === "HeadUpdated" && log.args.slot === stored?.slot);
      heads.set(
        side.chainId,
        stored === null ? null : { ...stored, updatedTimestamp: update === undefined ? null : (timestamps.get(`${side.chainId}:${update.blockNumber}`) as bigint) },
      );
    }
    const assembled = assemble({
      pair,
      logs,
      timestampOf: (chainId, blockNumber) => timestamps.get(`${chainId}:${blockNumber}`) as bigint,
      latestTimestamp: (chainId) => (tips.get(chainId) as ChainBlock).timestamp,
      readingOf: (chainId, address) => (readings.get(tokenKey(chainId, address)) as { reading: TokenReading }).reading,
      executionBlockOf: (chainId, hash) => executionBlocks.get(`${chainId}:${hash}`) as bigint,
      currentHead: (chainId) => heads.get(chainId) ?? null,
    });
    const oldest = new Map<number, bigint | null>();
    for (const side of pair.sides) oldest.set(side.chainId, await oldestOf(side));
    const known = [...oldest.values()].filter((value): value is bigint => value !== null);
    return {
      assembled,
      logs,
      tips,
      heads,
      scannedFromBlock: new Map(pair.sides.map((side) => [side.chainId, scanOf(side).scannedFromBlock() as bigint] as const)),
      reachedStart: new Map(pair.sides.map((side) => [side.chainId, scanOf(side).reachedStart()] as const)),
      oldestTimestamp: oldest,
      horizon: known.length === 0 ? null : known.reduce((latest, value) => (value > latest ? value : latest)),
      complete: known.length === 0,
    };
  };

  return {
    pair,
    maxWindowsPerRequest: options.maxWindowsPerRequest ?? DEFAULT_WINDOWS,
    concurrency,
    readerOf,
    exclusive,
    async prepare() {
      const logCount = (): number => pair.sides.reduce((total, side) => total + scanOf(side).logs().length, 0);
      const before = logCount();
      await Promise.all(pair.sides.map((side) => scanOf(side).refresh()));
      if (logCount() !== before) cached = null;
    },
    async extendOlder() {
      const candidates = await Promise.all(pair.sides.map(async (side) => ({ side, oldest: await oldestOf(side) })));
      const open = candidates.filter((candidate): candidate is { side: PairSide; oldest: bigint } => candidate.oldest !== null);
      if (open.length === 0) return false;
      const newest = open.reduce((latest, candidate) => (candidate.oldest > latest.oldest ? candidate : latest));
      cached = null;
      return scanOf(newest.side).extendOlder();
    },
    async snapshot() {
      if (cached !== null && now() - cached.builtAt < (options.headMaxAgeMilliseconds ?? DEFAULT_HEAD_AGE)) return cached.snapshot;
      const snapshot = await buildSnapshot();
      cached = { snapshot, builtAt: now() };
      return snapshot;
    },
    blockTimestamp: (chainId, blockNumber) => scanOf(sideOf(pair, chainId)).blockTimestamp(blockNumber),
    receipt(chainId, hash) {
      const key = `${chainId}:${hash}`;
      const known = receipts.get(key);
      if (known !== undefined) return known;
      const read = readerOf(chainId)
        .getTransactionReceipt(hash)
        .catch((error: unknown) => {
          receipts.delete(key);
          throw error;
        });
      receipts.set(key, read);
      return read;
    },
    tip: (chainId) => scanOf(sideOf(pair, chainId)).head(),
  };
};
