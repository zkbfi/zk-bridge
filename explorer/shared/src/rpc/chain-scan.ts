import type { AbiEvent, Address } from "viem";
import type { ChainBlock, ChainLog, ChainReader } from "./chain-reader.js";

/** A contract and the events to read from it. */
export type LogSource = { readonly address: Address; readonly events: readonly AbiEvent[] };

/** The inputs of {@link createChainScan}. */
export type ChainScanInput = {
  readonly reader: ChainReader;
  readonly sources: readonly LogSource[];
  /** The first block to read: the block before the deployment. A scan never goes below it. */
  readonly startBlock: bigint;
  /** The most blocks in one `eth_getLogs` window. */
  readonly blockSpan: bigint;
  /** A window that fails for its size splits in halves, and no half is shorter than this many blocks. */
  readonly minimumBlockSpan: bigint;
  /** How many blocks behind the head the next forward scan starts again, to follow a reorganization. */
  readonly reorgDepth: bigint;
  /** How long the latest block stays fresh, in milliseconds. */
  readonly headMaxAgeMilliseconds: number;
  /** The clock in milliseconds. */
  readonly now: () => number;
  /** When it aborts, the scan stops before its next request and throws the reason of the signal. */
  readonly signal?: AbortSignal;
};

/** The log history of one chain, read in bounded windows, newest first. */
export interface ChainScan {
  /** The latest block. A block no older than the freshness limit is reused. */
  head(): Promise<ChainBlock>;
  /** Reads the first window on the first call. Later it reads the blocks since the last call. */
  refresh(): Promise<void>;
  /** Reads one window of older blocks. False when the scan is already at the start block. */
  extendOlder(): Promise<boolean>;
  /** True when the scan covers the history down to the start block. */
  reachedStart(): boolean;
  /** The lowest block that the scan covers, or null before the first window. */
  scannedFromBlock(): bigint | null;
  /** The timestamp of the lowest block that the scan covers, or null when the scan reached the start block. */
  oldestTimestamp(): Promise<bigint | null>;
  /** Every log read so far, oldest first, ordered by block and log index. */
  logs(): readonly ChainLog[];
  /** The timestamp of a block. The answer is kept. */
  blockTimestamp(blockNumber: bigint): Promise<bigint>;
}

/** The error of a provider that refuses a window for its size. A smaller window can succeed. */
const SIZE_ERROR = /range|limit|too many|exceed|more than|response size|query returned|too large|10000/i;

const byPosition = (left: ChainLog, right: ChainLog): number =>
  left.blockNumber === right.blockNumber ? left.logIndex - right.logIndex : left.blockNumber < right.blockNumber ? -1 : 1;

const keyOf = (log: ChainLog): string => `${log.transactionHash}:${log.logIndex}`;

/**
 * Creates the scan of one chain. It reads `eth_getLogs` in windows of at most `blockSpan` blocks. It starts at the
 * latest block and goes back one window per call of `extendOlder`, so a caller reads only as much history as it needs.
 * A provider that refuses a window for its size gets two half windows.
 *
 * @param input The reader, the contracts and the limits.
 */
export const createChainScan = (input: ChainScanInput): ChainScan => {
  let latest: { readonly block: ChainBlock; readonly readAt: number } | null = null;
  let scannedFrom: bigint | null = null;
  let scannedTo: bigint | null = null;
  let collected: readonly ChainLog[] = [];
  const timestamps = new Map<bigint, Promise<bigint>>();

  const fetchRange = async (from: bigint, to: bigint): Promise<ChainLog[]> => {
    input.signal?.throwIfAborted();
    try {
      const parts = await Promise.all(
        input.sources.map((source) => input.reader.getLogs({ address: source.address, events: source.events, fromBlock: from, toBlock: to })),
      );
      return parts.flat();
    } catch (error) {
      const width = to - from + 1n;
      const message = error instanceof Error ? error.message : String(error);
      if (width / 2n < input.minimumBlockSpan || !SIZE_ERROR.test(message)) throw error;
      const middle = from + width / 2n - 1n;
      const lower = await fetchRange(from, middle);
      return [...lower, ...(await fetchRange(middle + 1n, to))];
    }
  };

  const merge = (existing: readonly ChainLog[], added: readonly ChainLog[]): readonly ChainLog[] => {
    const seen = new Map(existing.map((log) => [keyOf(log), log]));
    for (const log of added) seen.set(keyOf(log), log);
    return [...seen.values()].sort(byPosition);
  };

  const head = async (): Promise<ChainBlock> => {
    if (latest !== null && input.now() - latest.readAt < input.headMaxAgeMilliseconds) return latest.block;
    const block = await input.reader.getBlock({ tag: "latest" });
    latest = { block, readAt: input.now() };
    return block;
  };

  const reachedStart = (): boolean => scannedFrom !== null && scannedFrom <= input.startBlock;

  const extendOlder = async (): Promise<boolean> => {
    input.signal?.throwIfAborted();
    if (scannedFrom === null || reachedStart()) return false;
    const to = scannedFrom - 1n;
    const lowest = to - input.blockSpan + 1n;
    const from = lowest > input.startBlock ? lowest : input.startBlock;
    collected = merge(collected, await fetchRange(from, to));
    scannedFrom = from;
    return true;
  };

  const blockTimestamp = (blockNumber: bigint): Promise<bigint> => {
    const known = timestamps.get(blockNumber);
    if (known !== undefined) return known;
    const read = input.reader
      .getBlock({ blockNumber })
      .then((block) => block.timestamp)
      .catch((error: unknown) => {
        timestamps.delete(blockNumber);
        throw error;
      });
    timestamps.set(blockNumber, read);
    return read;
  };

  return {
    head,
    async refresh() {
      input.signal?.throwIfAborted();
      const tip = await head();
      if (scannedTo === null || scannedFrom === null) {
        scannedTo = tip.number;
        scannedFrom = tip.number + 1n;
        await extendOlder();
        return;
      }
      if (tip.number <= scannedTo) return;
      const rewound = scannedTo - input.reorgDepth + 1n;
      const from = rewound > scannedFrom ? rewound : scannedFrom;
      const added = await fetchRange(from, tip.number);
      collected = merge(
        collected.filter((log) => log.blockNumber < from),
        added,
      );
      scannedTo = tip.number;
    },
    extendOlder,
    reachedStart,
    scannedFromBlock: () => scannedFrom,
    async oldestTimestamp() {
      if (scannedFrom === null || reachedStart()) return null;
      return blockTimestamp(scannedFrom);
    },
    logs: () => collected,
    blockTimestamp,
  };
};
