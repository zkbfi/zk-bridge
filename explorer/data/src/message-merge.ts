import type { Hex } from "viem";
import type { TransferRow } from "./api-views.js";
import { deriveStatus, type DeliveryOutcome } from "./status.js";

/**
 * One message with the facts of both chains. The indexer stores it as a row of its `messages` table, and the RPC data
 * source builds it in memory. The indexer checks at compile time that its table row has exactly this shape.
 */
export type MessageRow = {
  readonly messageId: Hex;
  readonly sourceChainId: number;
  readonly destinationChainId: number;
  /** `<sourceChainId>><destinationChainId>`, for example `1>369`. */
  readonly direction: string;
  /** `token` when the executor is the remote mediator and the data is a handler call, else `message`. */
  readonly kind: string;
  readonly status: string;
  readonly sender: Hex | null;
  readonly executor: Hex | null;
  readonly dataType: number | null;
  readonly data: Hex | null;
  readonly sentTransactionHash: Hex | null;
  readonly sentBlockNumber: bigint | null;
  readonly sentTimestamp: bigint | null;
  /** The position of the `UserRequestForAffirmation` log in its block, or null before the send is seen. */
  readonly sentLogIndex: number | null;
  readonly deliveredTransactionHash: Hex | null;
  readonly deliveredBlockNumber: bigint | null;
  readonly deliveredTimestamp: bigint | null;
  /** The account that sent the execution transaction. */
  readonly executedBy: Hex | null;
  /** The slot of the first stored head that covered this message, or null. */
  readonly coveredByHeadSlot: bigint | null;
  readonly coveredAtTimestamp: bigint | null;
  readonly callbackFailed: boolean;
  /** True when the mediator emitted `ReleaseFailed` for this message. */
  readonly releaseFailed: boolean;
};

/** The inputs of `mergeMessage`. */
export type MergeMessageInput = {
  readonly messageId: MessageRow["messageId"];
  readonly sourceChainId: number;
  readonly destinationChainId: number;
  /** The stored row, or null when this is the first fact about the message. */
  readonly existing: MessageRow | null;
  /** The facts to add. A key that is present replaces the stored value, even when the new value is null. */
  readonly patch: Partial<MessageRow>;
  /** The newest block timestamp the indexer saw on the source chain, or null when it saw none. */
  readonly latestSourceTimestamp: bigint | null;
  /** The finality window of the source chain, in seconds. */
  readonly finalitySeconds: number;
};

/**
 * The row for a message that has no facts yet. `status` is a placeholder that `mergeMessage` replaces.
 *
 * @param messageId The message identifier.
 * @param sourceChainId The source chain.
 * @param destinationChainId The destination chain.
 */
const emptyRow = (messageId: MessageRow["messageId"], sourceChainId: number, destinationChainId: number): MessageRow => ({
  messageId,
  sourceChainId,
  destinationChainId,
  direction: `${sourceChainId}>${destinationChainId}`,
  kind: "message",
  status: "sent",
  sender: null,
  executor: null,
  dataType: null,
  data: null,
  sentTransactionHash: null,
  sentBlockNumber: null,
  sentTimestamp: null,
  sentLogIndex: null,
  deliveredTransactionHash: null,
  deliveredBlockNumber: null,
  deliveredTimestamp: null,
  executedBy: null,
  coveredByHeadSlot: null,
  coveredAtTimestamp: null,
  callbackFailed: false,
  releaseFailed: false,
});

/** A message is delivered once its delivery log is stored. A delivery that fails reverts and leaves no log. */
const deliveryOf = (row: MessageRow): DeliveryOutcome => (row.deliveredBlockNumber === null ? "none" : "succeeded");

/**
 * Computes the status of a stored message row from the facts it holds.
 *
 * @param row The merged row.
 * @param latestSourceTimestamp The newest source chain timestamp seen, or null.
 * @param finalitySeconds The finality window of the source chain.
 */
export const statusOfRow = (row: MessageRow, latestSourceTimestamp: bigint | null, finalitySeconds: number) => {
  const sentTimestamp = row.sentTimestamp ?? 0n;
  const latest = latestSourceTimestamp !== null && latestSourceTimestamp > sentTimestamp ? latestSourceTimestamp : sentTimestamp;
  return deriveStatus({
    delivery: deliveryOf(row),
    releaseFailed: row.releaseFailed,
    coveredByHead: row.coveredByHeadSlot !== null,
    sentTimestamp,
    latestSourceTimestamp: latest,
    finalitySeconds,
  });
};

/**
 * Adds facts to a message row and recomputes its status. The result does not depend on the order in which the
 * source chain and the destination chain facts arrive, because status is a pure function of the merged facts.
 *
 * @param input The stored row, the new facts and the clock of the source chain.
 */
export const mergeMessage = (input: MergeMessageInput): MessageRow => {
  const base = input.existing ?? emptyRow(input.messageId, input.sourceChainId, input.destinationChainId);
  const merged: MessageRow = { ...base, ...input.patch };
  return { ...merged, status: statusOfRow(merged, input.latestSourceTimestamp, input.finalitySeconds) };
};

/** The facts to add to a transfer row. A key that is present replaces the stored value, even when the new value is null. */
export type TransferPatch = Partial<TransferRow>;

/** The inputs of {@link mergeTransfer}. */
export type MergeTransferInput = {
  readonly messageId: Hex;
  readonly sourceChainId: number;
  readonly destinationChainId: number;
  /** The stored row, or null when this is the first fact about the transfer. */
  readonly existing: TransferRow | null;
  readonly patch: TransferPatch;
};

/**
 * Adds facts to the transfer row of a message, creating it when needed. Facts arrive from both chains in any order, so
 * every key of the patch replaces the stored value and every other key stays.
 *
 * @param input The identity of the transfer, the stored row and the new facts.
 */
export const mergeTransfer = (input: MergeTransferInput): TransferRow => {
  const base: TransferRow = input.existing ?? {
    messageId: input.messageId,
    sourceChainId: input.sourceChainId,
    destinationChainId: input.destinationChainId,
    sourceToken: null,
    destinationToken: null,
    sender: null,
    recipient: null,
    value: null,
    deliveredValue: null,
    paidTo: null,
    handler: null,
    deploysCopy: false,
    hasCallback: false,
    sourceIsNative: null,
    sentTimestamp: null,
    deliveryRouter: null,
    routerAmount: null,
    fee: null,
    received: null,
    deliverer: null,
    finalRecipient: null,
    feeSource: null,
    handOffReason: null,
    handOffRefused: null,
    callFailedTarget: null,
    callFailedRecipient: null,
    callFailedGas: null,
  };
  return { ...base, ...input.patch };
};
