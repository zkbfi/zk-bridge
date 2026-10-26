import { getAbiItem, toEventSelector, type Address, type Hex } from "viem";
import { messageBridgeAbi } from "../abis/index.js";
import {
  amountOf,
  auditItemView,
  feeAccruedView,
  feeBalanceView,
  feedItemView,
  gateView,
  headUpdateView,
  headView,
  inFlightView,
  indexTokens,
  lastHeadUpdateView,
  numberOf,
  tokenListItemView,
  tokenView,
  volumeView,
  type FeeBalanceRow,
  type GateStateRow,
  type HeadUpdateRow,
  type TransferRow,
} from "../api-views.js";
import { auditToken } from "../audit.js";
import { buildDeliveryCostReport } from "../delivery-cost.js";
import { parseDeliveryCostSettings, type DeliveryCostSettings } from "../delivery-cost-settings.js";
import { encodeCursor, parseFeedQuery, type FeedFilters } from "../feed-query.js";
import type { MessageRow } from "../message-merge.js";
import { describePair, otherSide, sideOf, type Pair, type PairSide } from "../pairs.js";
import { IN_FLIGHT_STATUSES } from "../status.js";
import type { ChainBlock, ChainLog } from "./chain-reader.js";
import { mapWithLimit } from "./concurrency.js";
import { createRpcExplorer, type RpcExplorer, type RpcExplorerOptions, type Snapshot } from "./explorer-state.js";
import {
  readAccruedFees,
  readBridgedCopy,
  readExecutionBlockNumber,
  readFeeTerms,
  readFinalizedSlot,
  readGate,
  readMediatorBalances,
} from "./live-reads.js";

/** A figure of an answer that the RPC source may give only in part. */
export const RPC_PARTIAL_FIGURES = [
  "feed",
  "tokens",
  "inFlight",
  "volume24h",
  "feesAccrued",
  "collectedFees",
  "audit",
  "lightClientUpdates",
  "gateConfirmation",
] as const;

/** The name of a partial figure. */
export type PartialFigure = (typeof RPC_PARTIAL_FIGURES)[number];

/**
 * The block that every answer of the RPC source carries. An answer from the indexer has no such block, which means
 * that it covers the whole history.
 */
export type RpcCoverage = {
  readonly source: "rpc";
  /** True when the scan reached the first block of the deployment on both chains. */
  readonly complete: boolean;
  /** Unix seconds. Messages sent before this time are not listed. Zero when the history is complete. */
  readonly coveredFrom: number;
  /** The lowest block read on each chain, by chain identifier. */
  readonly scannedFromBlock: Readonly<Record<string, number>>;
  /** The figures of this answer that are lower bounds or may miss older history. */
  readonly partial: readonly PartialFigure[];
};

/** One answer of the RPC source. */
export type ApiAnswer =
  | { readonly status: 200; readonly body: unknown }
  | { readonly status: 400 | 404; readonly body: { readonly error: string } };

/** The path is not served by the RPC source. */
export class RpcUnsupportedError extends Error {
  override readonly name = "RpcUnsupportedError";
}

/** The options of {@link createRpcExplorerApi}. */
export type RpcExplorerApiOptions = RpcExplorerOptions & {
  /** Replaces the error text of every failure, to remove secrets. */
  readonly redact?: (text: string) => string;
  /** The settings of the delivery cost report. Default: the defaults of the indexer. */
  readonly deliveryCost?: DeliveryCostSettings;
  /** The clock in unix seconds, for the 24 hour window. Default: the system clock. */
  readonly nowSeconds?: () => number;
};

/** The RPC data source as an HTTP API in the shape of the indexer API. */
export type RpcExplorerApi = {
  /**
   * Answers one request as the indexer would.
   *
   * @param pathAndQuery For example `/api/feed?limit=50`.
   * @throws RpcUnsupportedError for a path that the RPC source does not serve.
   * @throws Error with a redacted message when a chain does not answer.
   */
  get(pathAndQuery: string): Promise<ApiAnswer>;
  /**
   * The identifier of the message that a transaction sent or delivered, from the receipt on either chain.
   *
   * @returns The identifier, or null when neither chain knows the transaction or it holds no bridge message.
   */
  findMessageByTransaction(transactionHash: Hex): Promise<Hex | null>;
};

const SECONDS_PER_DAY = 86_400;

/** Orders two values: negative when `left` is smaller, positive when it is larger, zero when they are equal. */
const compare = <value extends bigint | string>(left: value, right: value): number => Number(left > right) - Number(left < right);
const USER_REQUEST_SELECTOR = toEventSelector(getAbiItem({ abi: messageBridgeAbi, name: "UserRequestForAffirmation" }));
const AFFIRMATION_SELECTOR = toEventSelector(getAbiItem({ abi: messageBridgeAbi, name: "AffirmationCompleted" }));
const LOOKUP_WINDOW_CAP = 80;
const HEAD_UPDATES_DEFAULT_LIMIT = 50;
const HEAD_UPDATES_MAX_LIMIT = 500;
const MAX_MESSAGE_ID = `0x${"f".repeat(64)}` as const;

/**
 * Creates the RPC data source. It reads the chains directly and answers in the JSON of the indexer API, so the
 * dashboards use it with no change when the indexer is not available.
 *
 * @param options The pair, the readers of its chains, the limits and the clock.
 */
export const createRpcExplorerApi = (options: RpcExplorerApiOptions): RpcExplorerApi => {
  const explorer = createRpcExplorer(options);
  const { pair } = options;
  const redact = options.redact ?? ((text: string) => text);
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const deliveryCost = options.deliveryCost ?? parseDeliveryCostSettings({}, pair.sides.map((side) => side.chainId));
  const lookupHints = new Map<Hex, { readonly chainId: number; readonly blockNumber: bigint }>();

  const coverageOf = (snapshot: Snapshot, partial: readonly PartialFigure[]): RpcCoverage => ({
    source: "rpc",
    complete: snapshot.complete,
    coveredFrom: snapshot.horizon === null ? 0 : Number(snapshot.horizon),
    scannedFromBlock: Object.fromEntries(pair.sides.map((side) => [String(side.chainId), Number(snapshot.scannedFromBlock.get(side.chainId))])),
    partial,
  });
  const partialUnlessComplete = (snapshot: Snapshot, figures: readonly PartialFigure[]): readonly PartialFigure[] => (snapshot.complete ? [] : figures);

  const withSnapshot = <value>(use: (snapshot: Snapshot) => Promise<value>): Promise<value> =>
    explorer.exclusive(async () => {
      await explorer.prepare();
      return use(await explorer.snapshot());
    });

  /** The logs of one chain with these event names, oldest first. */
  const logsOf = (snapshot: Snapshot, side: PairSide, ...names: readonly string[]): readonly ChainLog[] =>
    (snapshot.logs.get(side.chainId) as readonly ChainLog[]).filter((log) => names.includes(log.eventName));

  /** The logs of both chains with these event names, each with the chain that holds it. */
  const entriesOf = (snapshot: Snapshot, ...names: readonly string[]) =>
    pair.sides.flatMap((side) => logsOf(snapshot, side, ...names).map((log) => ({ side, log })));

  /** Reads older windows while `needsMore` says so, up to the budget. Returns the last snapshot. */
  const deepen = async (needsMore: (snapshot: Snapshot) => boolean, budget: number): Promise<Snapshot> => {
    let snapshot = await explorer.snapshot();
    for (let windows = 0; windows < budget && !snapshot.complete && needsMore(snapshot); windows += 1) {
      await explorer.extendOlder();
      snapshot = await explorer.snapshot();
    }
    return snapshot;
  };

  const readHeadUpdate = async (chainId: number, log: { args: Readonly<Record<string, unknown>>; blockNumber: bigint; transactionHash: Hex }): Promise<HeadUpdateRow> => {
    const [receipt, timestamp, executionBlockNumber] = await Promise.all([
      explorer.receipt(chainId, log.transactionHash),
      explorer.blockTimestamp(chainId, log.blockNumber),
      readExecutionBlockNumber(explorer.readerOf(chainId), sideOf(pair, chainId), log.args.executionBlockHash as Hex),
    ]);
    return {
      chainId,
      slot: log.args.slot as bigint,
      headerRoot: log.args.headerRoot as Hex,
      executionBlockHash: log.args.executionBlockHash as Hex,
      executionBlockNumber,
      transactionHash: log.transactionHash,
      blockNumber: log.blockNumber,
      timestamp,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.effectiveGasPrice,
      costWei: receipt.gasUsed * receipt.effectiveGasPrice,
      poster: receipt.from,
    };
  };

  const headUpdatesOf = async (snapshot: Snapshot, chainId: number | null, limit: number, before: bigint | null): Promise<HeadUpdateRow[]> => {
    const entries = entriesOf(snapshot, "HeadUpdated").filter(
      ({ side, log }) => (chainId === null || side.chainId === chainId) && (before === null || (log.args.slot as bigint) < before),
    );
    const stamped = await mapWithLimit(entries, explorer.concurrency, async (entry) => ({ entry, timestamp: await explorer.blockTimestamp(entry.side.chainId, entry.log.blockNumber) }));
    const newest = stamped
      .sort((left, right) => compare(right.timestamp, left.timestamp) || compare(right.entry.log.args.slot as bigint, left.entry.log.args.slot as bigint))
      .slice(0, limit);
    return mapWithLimit(newest, explorer.concurrency, ({ entry }) => readHeadUpdate(entry.side.chainId, entry.log));
  };

  const headViews = (snapshot: Snapshot) =>
    Promise.all(
      pair.sides.map(async (side) => {
        const tracked = otherSide(pair, side.chainId);
        const head = snapshot.heads.get(side.chainId) ?? null;
        const updates = logsOf(snapshot, side, "HeadUpdated");
        const headBlockTimestamp = head === null ? null : await explorer.blockTimestamp(tracked.chainId, head.executionBlockNumber).then(Number, () => null);
        const finalizedSlot = await readFinalizedSlot(explorer.readerOf(side.chainId), explorer.readerOf(tracked.chainId), side);
        const tipRow = (chainId: number) => {
          const tip = snapshot.tips.get(chainId) as ChainBlock;
          return { chainId, blockNumber: tip.number, timestamp: tip.timestamp, baseFeePerGas: tip.baseFeePerGas };
        };
        return headView({
          side,
          tracked,
          head:
            head === null
              ? undefined
              : { chainId: side.chainId, slot: head.slot, headerRoot: (updates.at(-1)?.args.headerRoot as Hex | undefined) ?? (`0x${"00".repeat(32)}` as Hex), executionBlockNumber: head.executionBlockNumber, updatedTimestamp: head.updatedTimestamp, updateCount: updates.length },
          finalizedSlot,
          headBlockTimestamp,
          trackedTip: tipRow(tracked.chainId),
          ownTip: tipRow(side.chainId),
        });
      }),
    );

  /** The gate views, and whether any confirmation time had to be derived from the epoch. */
  const gateViews = async (snapshot: Snapshot) => {
    let derived = false;
    const views = await Promise.all(
      pair.sides.map(async (side) => {
        const reading = await readGate(explorer.readerOf(side.chainId), side);
        const confirmations = logsOf(snapshot, side, "ForkConfirmed");
        const lastConfirmed = confirmations.at(-1);
        const sealedLog = logsOf(snapshot, side, "GateSealedByFork").at(-1);
        const confirmedTimestamp =
          lastConfirmed === undefined ? null : await explorer.blockTimestamp(side.chainId, lastConfirmed.blockNumber);
        if (lastConfirmed === undefined && reading.confirmedEpoch !== null) derived = true;
        const gate: GateStateRow = {
          chainId: side.chainId,
          sealed: reading.sealed,
          sealedVersion: (sealedLog?.args.version as Hex | undefined) ?? null,
          sealedSlot: (sealedLog?.args.slot as bigint | undefined) ?? null,
          enforcing: reading.enforcing,
          lastConfirmedEpoch: reading.confirmedEpoch,
          lastConfirmedVersion: (lastConfirmed?.args.version as Hex | undefined) ?? null,
          lastConfirmedTimestamp: confirmedTimestamp ?? reading.confirmedEpochStart,
          confirmations: confirmations.length,
        };
        return gateView({
          side,
          live: { enforcing: reading.enforcing, sealed: reading.sealed },
          gate,
          bridge: { chainId: side.chainId, depositsOpen: reading.depositsOpen, openedRemoteSlot: null, openedBlockNumber: null, openedTimestamp: null },
        });
      }),
    );
    return { views, derived };
  };

  /** Rows that join a message to its transfer, sorted newest first. Only messages that the scan knows fully. */
  const joinedRows = (snapshot: Snapshot) =>
    [...snapshot.assembled.messages.values()]
      .filter((row) => row.sentTimestamp !== null && (snapshot.horizon === null || row.sentTimestamp >= snapshot.horizon))
      .map((message) => ({ message, transfer: snapshot.assembled.transfers.get(message.messageId) ?? null }));

  const matches = (filters: FeedFilters, entry: { message: MessageRow; transfer: TransferRow | null }): boolean => {
    const { message, transfer } = entry;
    const sent = message.sentTimestamp as bigint;
    const { direction, kind, statuses, token, address, from, to, cursor } = filters;
    if (direction !== null && (message.sourceChainId !== direction.sourceChainId || message.destinationChainId !== direction.destinationChainId)) return false;
    if (kind !== null && message.kind !== kind) return false;
    if (statuses.length > 0 && !statuses.includes(message.status as never)) return false;
    if (token !== null && transfer?.sourceToken !== token && transfer?.destinationToken !== token) return false;
    if (address !== null) {
      const accounts = [message.sender, message.executor, transfer?.sender, transfer?.recipient, transfer?.fallbackRecipient, transfer?.paidTo];
      if (!accounts.includes(address)) return false;
    }
    if (from !== null && sent < from) return false;
    if (to !== null && sent > to) return false;
    if (cursor !== null && !(sent < cursor.sentTimestamp || (sent === cursor.sentTimestamp && message.messageId < cursor.messageId))) return false;
    return true;
  };

  /** Newest send first, and the larger identifier first among sends at the same second, as the indexer sorts. */
  const newestFirst = (left: { message: MessageRow }, right: { message: MessageRow }): number =>
    compare(right.message.sentTimestamp as bigint, left.message.sentTimestamp as bigint) || compare(right.message.messageId, left.message.messageId);

  /** Adds the account that sent the delivery transaction, from its receipt. A receipt that cannot be read leaves null. */
  const withExecutor = async (message: MessageRow): Promise<MessageRow> => {
    if (message.deliveredTransactionHash === null) return message;
    try {
      const receipt = await explorer.receipt(message.destinationChainId, message.deliveredTransactionHash);
      return { ...message, executedBy: receipt.from };
    } catch {
      return message;
    }
  };

  const feed = async (filters: FeedFilters): Promise<unknown> =>
    withSnapshot(async () => {
      const reachedFrom = (snapshot: Snapshot): boolean => filters.from !== null && snapshot.horizon !== null && snapshot.horizon <= filters.from;
      const snapshot = await deepen(
        (current) => !reachedFrom(current) && joinedRows(current).filter((entry) => matches(filters, entry)).length <= filters.limit,
        explorer.maxWindowsPerRequest,
      );
      const found = joinedRows(snapshot).filter((entry) => matches(filters, entry)).sort(newestFirst);
      const page = found.slice(0, filters.limit);
      const index = indexTokens([...snapshot.assembled.tokens.values()]);
      const items = await mapWithLimit(page, explorer.concurrency, async (entry) => feedItemView(await withExecutor(entry.message), entry.transfer, index));
      const last = page.at(-1);
      const more = !snapshot.complete && !reachedFrom(snapshot);
      const boundary = { sentTimestamp: snapshot.horizon ?? 0n, messageId: MAX_MESSAGE_ID };
      const nextCursor = found.length > filters.limit || more ? encodeCursor(last === undefined ? boundary : { sentTimestamp: last.message.sentTimestamp as bigint, messageId: last.message.messageId }) : null;
      return { items, nextCursor, coverage: coverageOf(snapshot, partialUnlessComplete(snapshot, ["feed"])) };
    });

  const messageDetail = async (messageId: Hex): Promise<ApiAnswer> =>
    withSnapshot(async () => {
      const hint = lookupHints.get(messageId);
      const hintTimestamp = hint === undefined ? null : await explorer.blockTimestamp(hint.chainId, hint.blockNumber);
      const known = (snapshot: Snapshot): boolean => {
        const row = snapshot.assembled.messages.get(messageId);
        return row !== undefined && row.sentTimestamp !== null && (snapshot.horizon === null || row.sentTimestamp >= snapshot.horizon);
      };
      const snapshot = await deepen(
        (current) => !known(current) && (hintTimestamp === null || current.horizon === null || current.horizon > hintTimestamp),
        hint === undefined ? explorer.maxWindowsPerRequest : LOOKUP_WINDOW_CAP,
      );
      const row = snapshot.assembled.messages.get(messageId);
      if (row === undefined || !known(snapshot)) {
        return { status: 404, body: { error: snapshot.complete ? "unknown message" : "unknown message in the scanned history; the RPC source reads only recent history" } };
      }
      const index = indexTokens([...snapshot.assembled.tokens.values()]);
      const detail = feedItemView(await withExecutor(row), snapshot.assembled.transfers.get(messageId) ?? null, index);
      return { status: 200, body: { ...detail, data: row.data, coverage: coverageOf(snapshot, partialUnlessComplete(snapshot, ["feed"])) } };
    });

  /** The fee readings of every token that the scan names, and the totals of the collected fees in the scan. */
  const feeRows = async (snapshot: Snapshot): Promise<FeeBalanceRow[]> => {
    const collected = new Map<string, bigint>();
    for (const { side, log } of entriesOf(snapshot, "FeesCollected")) {
      const key = `${side.chainId}:${log.args.token as string}`;
      collected.set(key, (collected.get(key) ?? 0n) + (log.args.amount as bigint));
    }
    const withFees = feeTokenKeys(snapshot);
    const candidates = [...snapshot.assembled.tokens.values()].filter((token) => !token.isBridgedCopy || withFees.has(`${token.chainId}:${token.address}`));
    return mapWithLimit(candidates, explorer.concurrency, async (token) => {
      const accruedFees = await readAccruedFees(explorer.readerOf(token.chainId), sideOf(pair, token.chainId), token.address);
      const collectedTotal = collected.get(`${token.chainId}:${token.address}`) ?? 0n;
      return { chainId: token.chainId, token: token.address, charged: collectedTotal + accruedFees, collected: collectedTotal, accrued: accruedFees };
    });
  };

  const feeTokenKeys = (snapshot: Snapshot): ReadonlySet<string> =>
    new Set(entriesOf(snapshot, "FeeCharged", "FeesCollected").map(({ side, log }) => `${side.chainId}:${log.args.token as string}`));

  const summary = async (nowOverride: number | null): Promise<unknown> =>
    withSnapshot(async (snapshot) => {
      const now = nowOverride ?? nowSeconds();
      const index = indexTokens([...snapshot.assembled.tokens.values()]);
      const inFlightGroups = new Map<string, { direction: string; status: string; count: number }>();
      for (const { message } of joinedRows(snapshot)) {
        if (!(IN_FLIGHT_STATUSES as readonly string[]).includes(message.status)) continue;
        const key = `${message.direction}|${message.status}`;
        const group = inFlightGroups.get(key) ?? { direction: message.direction, status: message.status, count: 0 };
        inFlightGroups.set(key, { ...group, count: group.count + 1 });
      }
      const volumes = new Map<string, { chainId: number; token: Hex | null; total: bigint; count: number }>();
      for (const transfer of snapshot.assembled.transfers.values()) {
        if (transfer.sentTimestamp === null || transfer.sentTimestamp < BigInt(now - SECONDS_PER_DAY)) continue;
        const key = `${transfer.sourceChainId}|${transfer.sourceToken ?? ""}`;
        const group = volumes.get(key) ?? { chainId: transfer.sourceChainId, token: transfer.sourceToken, total: 0n, count: 0 };
        volumes.set(key, { ...group, total: group.total + (transfer.value as bigint), count: group.count + 1 });
      }
      const [heads, gates, fees, lastUpdates] = await Promise.all([
        headViews(snapshot),
        gateViews(snapshot),
        feeRows(snapshot),
        Promise.all(pair.sides.map(async (side) => lastHeadUpdateView(side.chainId, (await headUpdatesOf(snapshot, side.chainId, 1, null))[0]))),
      ]);
      const volumeComplete = pair.sides.every((side) => {
        const oldest = snapshot.oldestTimestamp.get(side.chainId);
        return oldest === null || (oldest !== undefined && oldest <= BigInt(now - SECONDS_PER_DAY));
      });
      const partial: PartialFigure[] = [
        ...partialUnlessComplete(snapshot, ["inFlight", "feesAccrued", "lightClientUpdates"]),
        ...(volumeComplete ? [] : (["volume24h"] as const)),
        ...(gates.derived ? (["gateConfirmation"] as const) : []),
      ];
      return {
        pair: pair.name,
        now,
        heads,
        gates: gates.views,
        inFlight: inFlightView([...inFlightGroups.values()], IN_FLIGHT_STATUSES),
        volume24h: [...volumes.values()].map((group) => volumeView({ ...group, total: group.total.toString() }, index)),
        feesAccrued: fees.filter((row) => row.accrued > 0n).map((row) => feeAccruedView(row, index)),
        lastHeadUpdates: lastUpdates,
        coverage: coverageOf(snapshot, partial),
      };
    });

  const audit = async (): Promise<unknown> =>
    withSnapshot(async (snapshot) => {
      const index = indexTokens([...snapshot.assembled.tokens.values()]);
      const natives = [...snapshot.assembled.tokens.values()].filter((token) => !token.isBridgedCopy);
      const rows = joinedRows(snapshot);
      const unpaid = rows.filter(({ message, transfer }) => transfer !== null && !["delivered", "fallback_used"].includes(message.status)).map(({ transfer }) => transfer as TransferRow);
      const pending = (input: { nativeSide: boolean; chainId: number; token: Address }): bigint =>
        unpaid
          .filter((transfer) =>
            input.nativeSide
              ? transfer.sourceIsNative === true && transfer.sourceChainId === input.chainId && transfer.sourceToken === input.token
              : transfer.sourceIsNative === false && transfer.destinationChainId === input.chainId && transfer.destinationToken === input.token,
          )
          .reduce((total, transfer) => total + (transfer.value as bigint), 0n);
      const tokens = await mapWithLimit(natives, explorer.concurrency, async (token) => {
        const home = sideOf(pair, token.chainId);
        const other = otherSide(pair, token.chainId);
        const [balances, copy] = await Promise.all([
          readMediatorBalances(explorer.readerOf(home.chainId), home, token.address),
          readBridgedCopy(explorer.readerOf(other.chainId), other, token.address),
        ]);
        const result = auditToken({
          homeChainId: home.chainId,
          token: token.address,
          escrow: balances.escrow,
          accruedFees: balances.accruedFees,
          bridgedSupply: copy?.supply ?? 0n,
          pendingForward: pending({ nativeSide: true, chainId: home.chainId, token: token.address }),
          pendingBackward: pending({ nativeSide: false, chainId: home.chainId, token: token.address }),
        });
        return auditItemView({ audit: result, homeChainId: home.chainId, copy: copy === null ? null : { chainId: other.chainId, token: copy.token } }, index);
      });
      return {
        generatedNote: "the escrow and the supply are read at different blocks; recheck a mismatch once",
        tokens,
        coverage: coverageOf(snapshot, partialUnlessComplete(snapshot, ["audit", "collectedFees"])),
      };
    });

  const fees = async (limit: number): Promise<unknown> =>
    withSnapshot(async (snapshot) => {
      const index = indexTokens([...snapshot.assembled.tokens.values()]);
      const balances = await feeRows(snapshot);
      const terms = await Promise.all(
        pair.sides.map(async (side) => {
          const reading = await readFeeTerms(explorer.readerOf(side.chainId), side);
          return { chainId: side.chainId, rate: amountOf(reading.rate), rateScale: "the rate is in the units that TokenMediator.FEE_DENOMINATOR defines", recipient: reading.recipient };
        }),
      );
      const feeLogs = entriesOf(snapshot, "FeeCharged", "FeesCollected")
        .sort((left, right) => compare(right.log.blockNumber, left.log.blockNumber))
        .slice(0, limit);
      const events = await mapWithLimit(feeLogs, explorer.concurrency, async ({ side, log }) => {
        const collectedEvent = log.eventName === "FeesCollected";
        return {
          chainId: side.chainId,
          kind: collectedEvent ? "collected" : (log.args.direction as number) === 0 ? "charged_outgoing" : "charged_incoming",
          token: tokenView(side.chainId, log.args.token as string, index),
          amount: amountOf((collectedEvent ? log.args.amount : log.args.fee) as bigint),
          recipient: collectedEvent ? (log.args.feeRecipient as string) : null,
          rate: null,
          transactionHash: log.transactionHash,
          blockNumber: numberOf(log.blockNumber),
          timestamp: numberOf(await explorer.blockTimestamp(side.chainId, log.blockNumber)),
        };
      });
      return { balances: balances.map((row) => feeBalanceView(row, index)), terms, events, coverage: coverageOf(snapshot, partialUnlessComplete(snapshot, ["collectedFees"])) };
    });

  const deliveryCostAnswer = async (chainId: number): Promise<unknown> =>
    explorer.exclusive(async () => {
      const tip = await explorer.tip(chainId);
      return buildDeliveryCostReport({
        chainId,
        samples: { token_callback: [], token: [], message: [] },
        baseFee: { blockNumber: tip.number, timestamp: tip.timestamp, baseFeePerGas: tip.baseFeePerGas },
        settings: deliveryCost,
      });
    });

  const get = async (pathAndQuery: string): Promise<ApiAnswer> => {
    const url = new URL(pathAndQuery, "http://rpc.invalid");
    const { pathname, searchParams } = url;
    const answer = (body: unknown): ApiAnswer => ({ status: 200, body });
    const bad = (error: string): ApiAnswer => ({ status: 400, body: { error } });
    if (pathname === "/api/pair") return answer(describePair(pair));
    if (pathname === "/api/heads") return answer({ heads: await withSnapshot(headViews) });
    if (pathname === "/api/summary") {
      const text = searchParams.get("now");
      const parsed = Number(text);
      return answer(await summary(text !== null && Number.isInteger(parsed) && parsed > 0 ? parsed : null));
    }
    if (pathname === "/api/feed") {
      const parsed = parseFeedQuery(searchParams);
      return parsed.ok ? answer(await feed(parsed.filters)) : bad(parsed.problem);
    }
    const detail = /^\/api\/messages\/(.+)$/.exec(pathname);
    if (detail !== null) {
      const messageId = (detail[1] as string).toLowerCase();
      return /^0x[0-9a-f]{64}$/.test(messageId) ? messageDetail(messageId as Hex) : bad("invalid message identifier");
    }
    if (pathname === "/api/tokens") {
      return answer(
        await withSnapshot(async (snapshot) => {
          const index = indexTokens([...snapshot.assembled.tokens.values()]);
          return { tokens: [...snapshot.assembled.tokens.values()].map((row) => tokenListItemView(row, index)), coverage: coverageOf(snapshot, partialUnlessComplete(snapshot, ["tokens"])) };
        }),
      );
    }
    if (pathname === "/api/audit") return answer(await audit());
    if (pathname === "/api/fees") return answer(await fees(limitOf(searchParams.get("limit"), 50)));
    if (pathname === "/api/head-updates") {
      const chainText = searchParams.get("chainId");
      const beforeText = searchParams.get("before");
      return answer(
        await withSnapshot(async (snapshot) => {
          const items = await headUpdatesOf(snapshot, chainText === null ? null : Number(chainText), limitOf(searchParams.get("limit"), HEAD_UPDATES_DEFAULT_LIMIT, HEAD_UPDATES_MAX_LIMIT), beforeText === null ? null : BigInt(beforeText));
          return { items: items.map(headUpdateView), coverage: coverageOf(snapshot, partialUnlessComplete(snapshot, ["lightClientUpdates"])) };
        }),
      );
    }
    if (pathname === "/api/delivery-cost") {
      const text = searchParams.get("chainId");
      const chainId = text !== null && /^\d+$/.test(text) ? Number(text) : null;
      if (chainId === null) return bad("chainId is required and must be a whole number");
      if (!pair.sides.some((side) => side.chainId === chainId)) return bad(`unknown chainId ${chainId}`);
      return answer(await deliveryCostAnswer(chainId));
    }
    throw new RpcUnsupportedError(`${pathname} is not available from the RPC source.`);
  };

  const messageIdOf = async (side: PairSide, hash: Hex): Promise<Hex | null> => {
    let receipt;
    try {
      receipt = await explorer.receipt(side.chainId, hash);
    } catch (error) {
      if ((error as Error).name === "TransactionReceiptNotFoundError") return null;
      throw error;
    }
    const bridgeLogs = receipt.logs.filter((log) => log.address === side.contracts.bridge);
    const messageIds = bridgeLogs.flatMap((log) => {
      if (log.topics[0] === USER_REQUEST_SELECTOR) return [log.topics[1] as Hex];
      return log.topics[0] === AFFIRMATION_SELECTOR ? [log.topics[3] as Hex] : [];
    });
    const messageId = messageIds[0]?.toLowerCase() as Hex | undefined;
    if (messageId === undefined) return null;
    lookupHints.set(messageId, { chainId: side.chainId, blockNumber: receipt.blockNumber });
    return messageId;
  };

  const failSafely = async <value>(run: () => Promise<value>): Promise<value> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof RpcUnsupportedError) throw error;
      const failure = new Error(redact(error instanceof Error ? error.message : String(error)));
      failure.name = error instanceof Error ? error.name : "Error";
      throw failure;
    }
  };

  return {
    get: (pathAndQuery) => failSafely(() => get(pathAndQuery)),
    findMessageByTransaction: (hash) =>
      failSafely(async () => {
        for (const side of pair.sides) {
          const found = await explorer.exclusive(() => messageIdOf(side, hash));
          if (found !== null) return found;
        }
        return null;
      }),
  };
};

const limitOf = (text: string | null, fallback: number, maximum = 500): number => {
  const value = Number(text ?? fallback);
  return Number.isInteger(value) && value >= 1 && value <= maximum ? value : fallback;
};
