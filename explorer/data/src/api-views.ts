import type { Hex } from "viem";
import type { AuditResult } from "./audit.js";
import type { MessageRow } from "./message-merge.js";
import type { PairSide } from "./pairs.js";

/**
 * The shapes of the explorer HTTP API. The indexer builds its answers with these functions from database rows. The RPC
 * data source builds the same rows in memory from chain logs and view calls, and calls the same functions. So both
 * sources give one JSON shape by construction, and a client cannot tell them apart.
 *
 * Conversion rules: block numbers, timestamps, slots and chain identifiers are JSON numbers (they stay far below
 * 2^53). Every token amount is a decimal string of base units, because it can pass 2^53.
 */

/** A bigint that is a block number, a timestamp or a slot, as a JSON number. */
export const numberOf = (value: bigint | null | undefined): number | null =>
  value === null || value === undefined ? null : Number(value);

/** A bigint amount as a decimal string. */
export const amountOf = (value: bigint | null | undefined): string | null =>
  value === null || value === undefined ? null : value.toString();

/** A token seen by the bridge, native or bridged copy. The indexer stores it as a row of its `tokens` table. */
export type TokenRow = {
  readonly chainId: number;
  readonly address: Hex;
  readonly name: string | null;
  readonly symbol: string | null;
  readonly decimals: number;
  /** False when the token metadata could not be read from the chain. `decimals` is then 18 by assumption. */
  readonly metadataRead: boolean;
  readonly isBridgedCopy: boolean;
  /** The chain where the native token lives. For a native token, its own chain. */
  readonly homeChainId: number;
  readonly homeToken: Hex;
  readonly registeredTransactionHash: Hex | null;
  readonly registeredBlockNumber: bigint | null;
  readonly registeredTimestamp: bigint | null;
};

/** The token view of a message of kind `token`. */
export type TransferRow = {
  readonly messageId: Hex;
  readonly sourceChainId: number;
  readonly destinationChainId: number;
  readonly sourceToken: Hex | null;
  readonly destinationToken: Hex | null;
  readonly sender: Hex | null;
  readonly recipient: Hex | null;
  /** The amount that was locked or burned, Base units of the source token. */
  readonly value: bigint | null;
  /** The amount that the delivery paid, from `TokensBridged`. Null until a payment. */
  readonly deliveredValue: bigint | null;
  /** The account that received the tokens. Null until a payment. It is always the recipient. */
  readonly paidTo: Hex | null;
  readonly handler: string | null;
  readonly deploysCopy: boolean;
  readonly hasCallback: boolean;
  /** True when the source token is native on the source chain (lock) and false when it is a bridged copy (burn). */
  readonly sourceIsNative: boolean | null;
  readonly sentTimestamp: bigint | null;
};

/** The mediator balance of a native token on its home chain. */
export type EscrowRow = {
  readonly chainId: number;
  readonly token: Hex;
  readonly balance: bigint;
  readonly updatedBlockNumber: bigint;
  readonly updatedTimestamp: bigint;
};

/** The supply of a bridged copy. */
export type SupplyRow = {
  readonly chainId: number;
  readonly token: Hex;
  readonly nativeToken: Hex;
  readonly homeChainId: number;
  readonly minted: bigint;
  readonly burned: bigint;
  readonly supply: bigint;
  readonly updatedBlockNumber: bigint;
  readonly updatedTimestamp: bigint;
};

/** One light client head update. */
export type HeadUpdateRow = {
  readonly chainId: number;
  readonly slot: bigint;
  readonly headerRoot: Hex;
  readonly executionBlockHash: Hex;
  readonly executionBlockNumber: bigint;
  readonly transactionHash: Hex;
  readonly blockNumber: bigint;
  readonly timestamp: bigint;
  readonly gasUsed: bigint;
  readonly effectiveGasPrice: bigint;
  readonly costWei: bigint;
  readonly poster: Hex;
};

/**
 * The stored head of the light client on a chain: the newest update, or the checkpoint it was deployed with when no
 * update came yet. The deployment checkpoint has no execution block: the contract stores none for it.
 */
export type LightClientHeadRow = {
  readonly chainId: number;
  readonly slot: bigint;
  readonly headerRoot: Hex;
  /** The execution block of the tracked chain that the head holds. Null while the head is the deployment checkpoint. */
  readonly executionBlockNumber: bigint | null;
  /** When the newest update was stored. Null while no update came. */
  readonly updatedTimestamp: bigint | null;
  readonly updateCount: number;
  /** The head the light client was deployed with (`head()` before any update), or null when it was not read. */
  readonly initialSlot: bigint | null;
  /** The block of the light client's chain at which the indexer read that first head. */
  readonly initialHeadBlockNumber: bigint | null;
  /** `genesisTime()` of the light client: the tracked beacon chain's genesis, in seconds. */
  readonly genesisTime: bigint | null;
  /** `secondsPerSlot()` of the light client. */
  readonly secondsPerSlot: bigint | null;
};

/** The newest block that was seen on a chain. */
export type ChainTipRow = {
  readonly chainId: number;
  readonly blockNumber: bigint;
  readonly timestamp: bigint;
  readonly baseFeePerGas: bigint | null;
};

/** The gate state of a chain. */
export type GateStateRow = {
  readonly chainId: number;
  readonly sealed: boolean;
  readonly sealedVersion: Hex | null;
  readonly sealedSlot: bigint | null;
  readonly enforcing: boolean;
  readonly lastConfirmedEpoch: bigint | null;
  readonly lastConfirmedVersion: Hex | null;
  readonly lastConfirmedTimestamp: bigint | null;
  readonly confirmations: number;
};

/** The bridge state of a chain: whether sends are open. */
export type BridgeStateRow = {
  readonly chainId: number;
  readonly depositsOpen: boolean;
  readonly openedRemoteSlot: bigint | null;
  readonly openedBlockNumber: bigint | null;
  readonly openedTimestamp: bigint | null;
};

/** A lookup of token rows by chain and address. */
export type TokenIndex = ReadonlyMap<string, TokenRow>;

/**
 * Builds the lookup key of a token.
 *
 * @param chainId The chain.
 * @param address The token address, any letter case.
 */
export const tokenKey = (chainId: number, address: string): string => `${chainId}:${address.toLowerCase()}`;

/**
 * Indexes token rows.
 *
 * @param rows The token rows.
 */
export const indexTokens = (rows: readonly TokenRow[]): TokenIndex => new Map(rows.map((row) => [tokenKey(row.chainId, row.address), row]));

/** The token as the API shows it. */
export const tokenView = (chainId: number, address: string | null, index: TokenIndex) => {
  if (address === null) return null;
  const row = index.get(tokenKey(chainId, address));
  return {
    chainId,
    address,
    symbol: row?.symbol ?? null,
    name: row?.name ?? null,
    decimals: row?.decimals ?? null,
    metadataRead: row?.metadataRead ?? false,
    isBridgedCopy: row?.isBridgedCopy ?? null,
    homeChainId: row?.homeChainId ?? null,
    homeToken: row?.homeToken ?? null,
  };
};

/** One item of `GET /api/tokens`. */
export const tokenListItemView = (row: TokenRow, index: TokenIndex) => ({
  ...tokenView(row.chainId, row.address, index),
  registeredTransactionHash: row.registeredTransactionHash,
  registeredBlockNumber: numberOf(row.registeredBlockNumber),
  registeredTimestamp: numberOf(row.registeredTimestamp),
});

/** One feed item: a message with its transfer, when it has one. */
export const feedItemView = (message: MessageRow, transfer: TransferRow | null, index: TokenIndex) => ({
  messageId: message.messageId,
  kind: message.kind,
  status: message.status,
  direction: {
    sourceChainId: message.sourceChainId,
    destinationChainId: message.destinationChainId,
    label: message.direction,
  },
  sender: message.sender,
  executor: message.executor,
  gasLimit: message.gasLimit,
  sentLogIndex: message.sentLogIndex,
  sent:
    message.sentTimestamp === null
      ? null
      : {
          transactionHash: message.sentTransactionHash,
          blockNumber: numberOf(message.sentBlockNumber),
          timestamp: numberOf(message.sentTimestamp),
        },
  covered:
    message.coveredByHeadSlot === null
      ? null
      : { headSlot: numberOf(message.coveredByHeadSlot), timestamp: numberOf(message.coveredAtTimestamp) },
  delivered:
    message.deliveredTimestamp === null
      ? null
      : {
          transactionHash: message.deliveredTransactionHash,
          blockNumber: numberOf(message.deliveredBlockNumber),
          timestamp: numberOf(message.deliveredTimestamp),
          success: message.deliveredSuccess,
          executedBy: message.executedBy,
        },
  callbackFailed: message.callbackFailed,
  releaseFailed: message.releaseFailed,
  transfer:
    transfer === null
      ? null
      : {
          sourceToken: tokenView(transfer.sourceChainId, transfer.sourceToken, index),
          destinationToken: tokenView(transfer.destinationChainId, transfer.destinationToken, index),
          sender: transfer.sender,
          recipient: transfer.recipient,
          paidTo: transfer.paidTo,
          value: amountOf(transfer.value),
          deliveredValue: amountOf(transfer.deliveredValue),
          handler: transfer.handler,
          deploysCopy: transfer.deploysCopy,
          hasCallback: transfer.hasCallback,
          sourceIsNative: transfer.sourceIsNative,
        },
});

/** An escrow row as the API shows it. */
export const escrowView = (row: EscrowRow, index: TokenIndex) => ({
  chainId: row.chainId,
  token: tokenView(row.chainId, row.token, index),
  balance: amountOf(row.balance),
  updatedBlockNumber: numberOf(row.updatedBlockNumber),
  updatedTimestamp: numberOf(row.updatedTimestamp),
});

/** A bridged supply row as the API shows it. */
export const supplyView = (row: SupplyRow, index: TokenIndex) => ({
  chainId: row.chainId,
  token: tokenView(row.chainId, row.token, index),
  nativeToken: row.nativeToken,
  homeChainId: row.homeChainId,
  minted: amountOf(row.minted),
  burned: amountOf(row.burned),
  supply: amountOf(row.supply),
  updatedBlockNumber: numberOf(row.updatedBlockNumber),
  updatedTimestamp: numberOf(row.updatedTimestamp),
});

/** One item of `GET /api/head-updates`. */
export const headUpdateView = (row: HeadUpdateRow) => ({
  chainId: row.chainId,
  slot: numberOf(row.slot),
  headerRoot: row.headerRoot,
  executionBlockHash: row.executionBlockHash,
  executionBlockNumber: numberOf(row.executionBlockNumber),
  transactionHash: row.transactionHash,
  blockNumber: numberOf(row.blockNumber),
  timestamp: numberOf(row.timestamp),
  gasUsed: amountOf(row.gasUsed),
  effectiveGasPrice: amountOf(row.effectiveGasPrice),
  costWei: amountOf(row.costWei),
  poster: row.poster,
});

/** The newest head update of one side, as `GET /api/summary` shows it. `row` is undefined when the side has none. */
export const lastHeadUpdateView = (chainId: number, row: HeadUpdateRow | undefined) =>
  row === undefined
    ? { chainId, update: null }
    : {
        chainId,
        update: {
          slot: Number(row.slot),
          executionBlockNumber: Number(row.executionBlockNumber),
          transactionHash: row.transactionHash,
          timestamp: Number(row.timestamp),
          gasUsed: row.gasUsed.toString(),
          costWei: row.costWei.toString(),
          poster: row.poster,
        },
      };

/** The fields of a head that only the indexer knows. The RPC data source leaves them out. */
type InitialHeadFields = "initialSlot" | "initialHeadBlockNumber" | "genesisTime" | "secondsPerSlot";

/** The stored head of a light client. The RPC data source does not always know when the head was stored. */
export type HeadViewRow = Omit<LightClientHeadRow, InitialHeadFields> & Partial<Pick<LightClientHeadRow, InitialHeadFields>>;

/** What the light client view of one side needs. The light client on `side` tracks the beacon chain of `tracked`. */
export type HeadViewInput = {
  readonly side: PairSide;
  readonly tracked: PairSide;
  readonly head: HeadViewRow | undefined;
  /** The finalized slot of the tracked chain, or null when no beacon endpoint answers. */
  readonly finalizedSlot: number | null;
  /** The timestamp of the execution block that the stored head holds, or null when it is unknown. */
  readonly headBlockTimestamp: number | null;
  readonly trackedTip: ChainTipRow | undefined;
  readonly ownTip: ChainTipRow | undefined;
};

/** The light client view of one side, as `GET /api/heads` shows it. */
export const headView = (input: HeadViewInput) => {
  const { side, tracked, head, finalizedSlot, headBlockTimestamp, trackedTip, ownTip } = input;
  // The start time of the head's slot. A post-merge execution block carries exactly that timestamp, so it stands in
  // for the block time of the deployment checkpoint, which has no execution block.
  const slotTimestamp =
    head === undefined || head.genesisTime == null || head.secondsPerSlot == null
      ? null
      : Number(head.genesisTime + head.slot * head.secondsPerSlot);
  const headTimestamp = headBlockTimestamp ?? slotTimestamp;
  const lagSeconds =
    headTimestamp === null || trackedTip === undefined ? null : Math.max(0, Number(trackedTip.timestamp) - headTimestamp);
  return {
    chainId: side.chainId,
    name: side.name,
    lightClient: side.contracts.lightClient,
    trackedChainId: tracked.chainId,
    /** The head the contract stores now: the newest update, or the checkpoint it was deployed with. */
    storedHeadSlot: numberOf(head?.slot),
    /** `update` once an update stored the head, `deployment` while it is the checkpoint of the deployment. */
    storedHeadSource: head === undefined ? null : head.updateCount > 0 || head.executionBlockNumber !== null ? ("update" as const) : ("deployment" as const),
    storedHeadExecutionBlock: numberOf(head?.executionBlockNumber),
    storedHeadExecutionTimestamp: headBlockTimestamp,
    storedHeadSlotTimestamp: slotTimestamp,
    lastUpdateTimestamp: numberOf(head?.updatedTimestamp),
    updateCount: head?.updateCount ?? 0,
    /** True when the light client holds a head at all. */
    initialized: head !== undefined,
    initializedAtSlot: numberOf(head?.initialSlot),
    initializedAtBlock: numberOf(head?.initialHeadBlockNumber),
    finalizedSlot,
    lagSlots: finalizedSlot === null || head === undefined ? null : Math.max(0, finalizedSlot - Number(head.slot)),
    lagSeconds,
    trackedChainTipBlock: numberOf(trackedTip?.blockNumber),
    trackedChainTipTimestamp: numberOf(trackedTip?.timestamp),
    ownChainTipBlock: numberOf(ownTip?.blockNumber),
    ownChainTipTimestamp: numberOf(ownTip?.timestamp),
  };
};

/** The mode flags of a gate, read from the chain. */
export type GateFlags = { readonly enforcing: boolean; readonly sealed: boolean };

/** What the gate view of one side needs. */
export type GateViewInput = {
  readonly side: PairSide;
  /** The flags read live from the contract, or null when the chain did not answer. */
  readonly live: GateFlags | null;
  readonly gate: GateStateRow | undefined;
  readonly bridge: BridgeStateRow | undefined;
};

/** The gate and send state of one side. The mode flags are live: a gate can start enforcing with no event. */
export const gateView = (input: GateViewInput) => {
  const { side, live, gate, bridge } = input;
  return {
    chainId: side.chainId,
    name: side.name,
    gate: side.contracts.gate,
    enforcing: live?.enforcing ?? gate?.enforcing ?? null,
    sealed: live?.sealed ?? gate?.sealed ?? null,
    sealedVersion: gate?.sealedVersion ?? null,
    sealedSlot: numberOf(gate?.sealedSlot),
    lastConfirmedEpoch: numberOf(gate?.lastConfirmedEpoch),
    lastConfirmedVersion: gate?.lastConfirmedVersion ?? null,
    lastConfirmedTimestamp: numberOf(gate?.lastConfirmedTimestamp),
    confirmations: gate?.confirmations ?? 0,
    depositsOpen: bridge?.depositsOpen ?? false,
    depositsOpenedTimestamp: numberOf(bridge?.openedTimestamp),
  };
};

/** One group of in-flight messages. */
export type InFlightGroup = { readonly direction: string; readonly status: string; readonly count: number };

/**
 * The in-flight block of `GET /api/summary`.
 *
 * @param groups Message counts by direction and status, for the in-flight statuses only.
 * @param statuses The in-flight statuses, in display order.
 */
export const inFlightView = (groups: readonly InFlightGroup[], statuses: readonly string[]) => {
  const countOf = (matches: (group: InFlightGroup) => boolean): number =>
    groups.filter(matches).reduce((total, group) => total + group.count, 0);
  return {
    total: countOf(() => true),
    byStatus: Object.fromEntries(statuses.map((status) => [status, countOf((group) => group.status === status)])),
    byDirection: Object.fromEntries(
      [...new Set(groups.map((group) => group.direction))].map((direction) => [direction, countOf((group) => group.direction === direction)]),
    ),
  };
};

/** The 24 hour volume of one source token. `total` is a decimal string, or null when nothing was summed. */
export type VolumeGroup = {
  readonly chainId: number;
  readonly token: Hex | null;
  readonly total: string | null;
  readonly count: number;
};

/** One item of the `volume24h` list of `GET /api/summary`. */
export const volumeView = (group: VolumeGroup, index: TokenIndex) => ({
  chainId: group.chainId,
  token: group.token === null ? null : tokenView(group.chainId, group.token, index),
  volume: group.total ?? "0",
  transfers: group.count,
});

/** What one item of `GET /api/audit` needs. */
export type AuditViewInput = {
  readonly audit: AuditResult;
  readonly homeChainId: number;
  /** The bridged copy on the other chain, or null when none exists. */
  readonly copy: { readonly chainId: number; readonly token: Hex } | null;
};

/** One item of the `tokens` list of `GET /api/audit`. */
export const auditItemView = (input: AuditViewInput, index: TokenIndex) => {
  const { audit, copy } = input;
  return {
    token: tokenView(input.homeChainId, audit.token, index),
    bridgedToken: copy === null ? null : tokenView(copy.chainId, copy.token, index),
    escrow: amountOf(audit.escrow),
    bridgedSupply: amountOf(audit.bridgedSupply),
    pendingForward: amountOf(audit.pendingForward),
    pendingBackward: amountOf(audit.pendingBackward),
    expectedEscrow: amountOf(audit.expectedEscrow),
    difference: amountOf(audit.difference),
    mismatch: audit.mismatch,
  };
};
