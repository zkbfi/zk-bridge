import { transfers } from "ponder:schema";
import type { Hex } from "viem";
import type { IndexingDatabase } from "./message-store";

/** One row of the `transfers` table. */
export type TransferRow = typeof transfers.$inferSelect;

/** The inputs of `writeTransfer`. */
export type WriteTransferInput = {
  readonly database: IndexingDatabase;
  readonly messageId: Hex;
  readonly sourceChainId: number;
  readonly destinationChainId: number;
  readonly patch: Partial<TransferRow>;
};

/**
 * Merges facts into the transfer row of a message, creating it when needed. Facts arrive from both chains in any
 * order, so every key of the patch replaces the stored value and every other key stays.
 *
 * @param input The database, the message identity and the new facts.
 */
export const writeTransfer = async (input: WriteTransferInput): Promise<void> => {
  const existing = await input.database.find(transfers, { messageId: input.messageId });
  const base: TransferRow = existing ?? {
    messageId: input.messageId,
    sourceChainId: input.sourceChainId,
    destinationChainId: input.destinationChainId,
    sourceToken: null,
    destinationToken: null,
    sender: null,
    recipient: null,
    fallbackRecipient: null,
    value: null,
    deliveredValue: null,
    paidTo: null,
    handler: null,
    deploysCopy: false,
    hasCallback: false,
    sourceIsNative: null,
    sentTimestamp: null,
  };
  const merged = { ...base, ...input.patch };
  await input.database.insert(transfers).values(merged).onConflictDoUpdate(merged);
};
