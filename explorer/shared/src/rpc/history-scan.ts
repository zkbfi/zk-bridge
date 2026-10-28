import type { Hex } from "viem";
import { compareHistoryEvents, type HistoryEvent } from "../history-query.js";
import type { Pair, PairSide } from "../pairs.js";
import type { MessageStatus } from "../status.js";
import type { ChainReader } from "./chain-reader.js";
import { createChainScan } from "./chain-scan.js";
import { mapWithLimit } from "./concurrency.js";
import { logSourcesOf } from "./events.js";

/** The most blocks in one `eth_getLogs` window. */
const BLOCK_SPAN = 10_000n;
/** A window that a node refuses for its size splits in halves, down to this many blocks. */
const MINIMUM_BLOCK_SPAN = 500n;
/** How many block times are read at once. */
const TIMESTAMP_CONCURRENCY = 8;

/** The inputs of {@link scanHistory}. */
export type HistoryScanInput = {
  readonly pair: Pair;
  /** One reader for each chain of the pair. */
  readonly readers: ReadonlyMap<number, ChainReader>;
  /**
   * The lowest block to read on each chain. A chain never reads below the first block of the deployment, so zero
   * means the whole history since the deployment.
   */
  readonly fromBlock: bigint;
  /**
   * The most blocks to read on each chain, counted back from its latest block. The scan stops at the first window
   * that reaches this count. Default {@link DEFAULT_MAXIMUM_BLOCKS}.
   */
  readonly maximumBlocks?: bigint;
  /** When it aborts, the scan stops before its next request and throws the reason of the signal. */
  readonly signal?: AbortSignal;
};

/** The default for {@link HistoryScanInput.maximumBlocks}. */
export const DEFAULT_MAXIMUM_BLOCKS = 200_000n;

/** How far back the scan read on one chain. */
export type ChainCoverage = {
  readonly chainId: number;
  /** The lowest block that the scan read. */
  readonly scannedFromBlock: bigint;
  /** True when the scan reached the start of the history, so nothing older exists to read. */
  readonly reachedStart: boolean;
};

/** The history that the chains give directly. It is always partial: see {@link scanHistory}. */
export type HistoryScan = {
  readonly items: HistoryEvent[];
  readonly partial: true;
  /** How far back each chain was read, so a page can say where its history starts. */
  readonly coverage: readonly ChainCoverage[];
};

const readerOf = (input: HistoryScanInput, side: PairSide): ChainReader => {
  const reader = input.readers.get(side.chainId);
  if (reader === undefined) throw new Error(`No RPC reader is set for chain ${side.chainId}.`);
  return reader;
};

/** Reads the logs of one side from the latest block back, until the start block or the block limit. */
const logsOfSide = async (input: HistoryScanInput, side: PairSide) => {
  const startBlock = BigInt(side.startBlock) > input.fromBlock ? BigInt(side.startBlock) : input.fromBlock;
  const maximumBlocks = input.maximumBlocks ?? DEFAULT_MAXIMUM_BLOCKS;
  const scan = createChainScan({
    reader: readerOf(input, side),
    sources: logSourcesOf(side),
    startBlock,
    blockSpan: BLOCK_SPAN,
    minimumBlockSpan: MINIMUM_BLOCK_SPAN,
    reorgDepth: 0n,
    headMaxAgeMilliseconds: 0,
    now: Date.now,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  await scan.refresh();
  const latest = (await scan.head()).number;
  const blocksRead = (): bigint => latest - (scan.scannedFromBlock() as bigint) + 1n;
  while (blocksRead() < maximumBlocks && (await scan.extendOlder()));
  const coverage: ChainCoverage = { chainId: side.chainId, scannedFromBlock: scan.scannedFromBlock() as bigint, reachedStart: scan.reachedStart() };
  return { scan, logs: scan.logs(), coverage };
};

/**
 * Builds the history from the chains alone, for the time when the indexer cannot answer. It reads the sends, the
 * deliveries and the stored heads of both chains from `fromBlock` to the latest block.
 *
 * The answer is always partial, because the chains give less than the indexer:
 * - A send has a status only when its delivery is in the scanned blocks. Without it the status is null, which means
 *   unknown. The scan does not judge finality or coverage.
 * - It does not read the token or the sender of a message, so a filter on kind, token or address cannot apply.
 * - The blocks below `fromBlock`, below the deployment and beyond `maximumBlocks` are not read. `coverage` says where
 *   each chain stopped.
 *
 * @param input The pair, one reader for each chain, and the first block.
 * @throws When a chain has no reader or a node fails.
 */
export const scanHistory = async (input: HistoryScanInput): Promise<HistoryScan> => {
  const scans = await Promise.all(input.pair.sides.map(async (side) => ({ side, ...(await logsOfSide(input, side)) })));

  const allLogs = scans.flatMap(({ logs }) => logs);
  const outcomes = new Map<Hex, MessageStatus>();
  for (const log of allLogs) {
    if (log.eventName === "AffirmationCompleted") outcomes.set(log.args.messageId as Hex, log.args.status === true ? "delivered" : "failed_call");
  }
  // A failed release is final and wins over the delivery that it followed, whichever log comes first.
  for (const log of allLogs) {
    if (log.eventName === "ReleaseFailed") outcomes.set(log.args.messageId as Hex, "release_failed");
  }

  const eventsOfSide = async ({ side, scan, logs }: (typeof scans)[number]): Promise<HistoryEvent[]> => {
    const wanted = logs.filter((log) => ["UserRequestForAffirmation", "AffirmationCompleted", "HeadUpdated"].includes(log.eventName));
    return mapWithLimit(wanted, TIMESTAMP_CONCURRENCY, async (log): Promise<HistoryEvent> => {
      const timestamp = await scan.blockTimestamp(log.blockNumber);
      const base = { chainId: side.chainId, timestamp, transactionHash: log.transactionHash };
      if (log.eventName === "HeadUpdated") return { ...base, kind: "head-update", messageId: null, slot: log.args.slot as bigint, status: null };
      const messageId = log.args.messageId as Hex;
      const kind = log.eventName === "UserRequestForAffirmation" ? "sent" : "delivered";
      return { ...base, kind, messageId, slot: null, status: outcomes.get(messageId) ?? null };
    });
  };

  const items = (await Promise.all(scans.map(eventsOfSide))).flat().sort(compareHistoryEvents);
  return { items, partial: true, coverage: scans.map(({ coverage }) => coverage) };
};
