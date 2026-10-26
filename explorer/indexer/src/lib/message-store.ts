import { and, eq, inArray, isNull, lte } from "ponder";
import { messages, chainTips, lightClientHeads, transfers } from "ponder:schema";
import { isCovered, mergeMessage, sideOf, type MessageRow } from "@zk-bridge/shared";
import type { Hex } from "viem";
import type { Context } from "ponder:registry";
import { pair } from "./pair";

type AnyContext = Context<"MessageBridge:AffirmationCompleted">;

/** The database handle of an indexing function. */
export type IndexingDatabase = AnyContext["db"];

/** The inputs of `writeMessage`. */
export type WriteMessageInput = {
  readonly database: IndexingDatabase;
  readonly messageId: Hex;
  readonly sourceChainId: number;
  readonly destinationChainId: number;
  readonly patch: Partial<MessageRow>;
  /** A timestamp that the caller just saw on the source chain, to advance the clock without a read. */
  readonly sourceTimestampHint?: bigint;
};

const newerOf = (left: bigint | null, right: bigint | null): bigint | null => {
  if (left === null) return right;
  if (right === null) return left;
  return left > right ? left : right;
};

/**
 * Merges facts into a message row, covers it when a stored head already reaches its block, recomputes its status,
 * and writes it. Safe to call in any order for the same message.
 *
 * @param input The database, the message identity and the new facts.
 * @returns The row that was written.
 */
export const writeMessage = async (input: WriteMessageInput): Promise<MessageRow> => {
  const { database, messageId } = input;
  const existing = await database.find(messages, { messageId });
  const tip = await database.find(chainTips, { chainId: input.sourceChainId });
  const latestSourceTimestamp = newerOf(tip?.timestamp ?? null, input.sourceTimestampHint ?? null);
  const finalitySeconds = sideOf(pair, input.sourceChainId).finalitySeconds;
  const merged = mergeMessage({
    messageId,
    sourceChainId: input.sourceChainId,
    destinationChainId: input.destinationChainId,
    existing,
    patch: input.patch,
    latestSourceTimestamp,
    finalitySeconds,
  });
  const covering = await coverFromStoredHead(database, merged);
  const final =
    covering === null
      ? merged
      : mergeMessage({
          messageId,
          sourceChainId: input.sourceChainId,
          destinationChainId: input.destinationChainId,
          existing: merged,
          patch: covering,
          latestSourceTimestamp,
          finalitySeconds,
        });
  await database.insert(messages).values(final).onConflictDoUpdate(final);
  return final;
};

/**
 * Looks up the newest stored head on the destination and returns the facts that cover the message, if it is covered
 * and was not marked yet. Returns null when nothing changes.
 */
const coverFromStoredHead = async (database: IndexingDatabase, row: MessageRow): Promise<Partial<MessageRow> | null> => {
  if (row.coveredByHeadSlot !== null || row.sentBlockNumber === null) return null;
  const head = await database.find(lightClientHeads, { chainId: row.destinationChainId });
  if (!head || !isCovered(head.executionBlockNumber, row.sentBlockNumber)) return null;
  return { coveredByHeadSlot: head.slot, coveredAtTimestamp: head.updatedTimestamp };
};

/**
 * Marks every uncovered message that a new head covers, and recomputes their status.
 *
 * @param database The database handle.
 * @param destinationChainId The chain that holds the light client.
 * @param head The new head: its slot, its execution block on the source chain, and when it was stored.
 */
export const coverMessages = async (
  database: IndexingDatabase,
  destinationChainId: number,
  head: { readonly slot: bigint; readonly executionBlockNumber: bigint; readonly timestamp: bigint },
): Promise<number> => {
  const rows = await database.sql
    .select({ messageId: messages.messageId, sourceChainId: messages.sourceChainId })
    .from(messages)
    .where(
      and(
        eq(messages.destinationChainId, destinationChainId),
        isNull(messages.coveredByHeadSlot),
        lte(messages.sentBlockNumber, head.executionBlockNumber),
      ),
    );
  for (const row of rows) {
    await writeMessage({
      database,
      messageId: row.messageId,
      sourceChainId: row.sourceChainId,
      destinationChainId,
      patch: { coveredByHeadSlot: head.slot, coveredAtTimestamp: head.timestamp },
    });
  }
  return rows.length;
};

/**
 * Moves the sends that have passed the finality window from `sent` to `waiting_for_finality`.
 *
 * @param database The database handle.
 * @param sourceChainId The chain whose clock moved.
 * @param timestamp The new timestamp of the source chain.
 */
export const ageMessages = async (database: IndexingDatabase, sourceChainId: number, timestamp: bigint): Promise<void> => {
  const finalitySeconds = BigInt(sideOf(pair, sourceChainId).finalitySeconds);
  const rows = await database.sql
    .select({ messageId: messages.messageId, destinationChainId: messages.destinationChainId })
    .from(messages)
    .where(
      and(
        eq(messages.sourceChainId, sourceChainId),
        inArray(messages.status, ["sent"]),
        lte(messages.sentTimestamp, timestamp - finalitySeconds),
      ),
    );
  for (const row of rows) {
    await writeMessage({
      database,
      messageId: row.messageId,
      sourceChainId,
      destinationChainId: row.destinationChainId,
      patch: {},
      sourceTimestampHint: timestamp,
    });
  }
};

/** The transfer row of a message, or null. */
export const findTransfer = (database: IndexingDatabase, messageId: Hex) => database.find(transfers, { messageId });
