import { deriveStatus, type DeliveryOutcome } from "@zk-bridge/shared";
import type { messages } from "../../ponder.schema";

/** One row of the `messages` table. */
export type MessageRow = typeof messages.$inferSelect;

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
  gasLimit: null,
  dataType: null,
  data: null,
  sentTransactionHash: null,
  sentBlockNumber: null,
  sentTimestamp: null,
  deliveredTransactionHash: null,
  deliveredBlockNumber: null,
  deliveredTimestamp: null,
  deliveredSuccess: null,
  executedBy: null,
  coveredByHeadSlot: null,
  coveredAtTimestamp: null,
  fallbackUsed: false,
  callbackFailed: false,
  claimableOutstanding: false,
  claimableToken: null,
  claimableAccount: null,
  claimedTimestamp: null,
});

const deliveryOf = (row: MessageRow): DeliveryOutcome => {
  if (row.deliveredSuccess === null) return "none";
  return row.deliveredSuccess ? "succeeded" : "failed";
};

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
    fallbackUsed: row.fallbackUsed,
    claimableOutstanding: row.claimableOutstanding,
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
