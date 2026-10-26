/**
 * Searches that need the indexer: a message identifier, a transaction hash on either chain, and an address. It uses
 * the existing routes of the indexer only. An address needs no read to be a result: the address page reads its
 * transfers and balances itself.
 */
import type { PairConfig } from "@terminal/model/types";
import type { IndexerClient } from "../data/indexer-client";
import { chainNameOf, type MessageDetail } from "../data/message-detail";
import { addressResult, transferResult, type QueryShape, type SearchResult } from "./search-model";

/** What the indexer lookup found, and why it found nothing when it did not. */
export type IdentifierSearchOutcome = {
  readonly results: readonly SearchResult[];
  /** A sentence for the user when the lookup failed or found nothing. Null when there is a result. */
  readonly problem: string | null;
};

const subtitleOf = (detail: MessageDetail, pair: PairConfig, foundBy: "identifier" | "transaction"): string =>
  `${detail.kind === "token" ? "Transfer" : "Message"} · ${detail.status.replace(/_/g, " ")} · ${chainNameOf(pair, detail.sourceChainId)} to ${chainNameOf(pair, detail.destinationChainId)} · found by ${foundBy}`;

/**
 * Looks up a query that is an address or a 32 byte hash.
 *
 * @param shape The classified query.
 * @param dependencies The indexer client and the pair.
 */
export const searchIdentifiers = async (
  shape: QueryShape,
  dependencies: { readonly indexer: IndexerClient; readonly pair: PairConfig },
): Promise<IdentifierSearchOutcome> => {
  if (shape.kind === "address") return { results: [addressResult(shape.address)], problem: null };
  if (shape.kind !== "hash") return { results: [], problem: null };
  try {
    const byIdentifier = await dependencies.indexer.message(shape.hash);
    if (byIdentifier !== null) {
      return { results: [transferResult({ messageId: byIdentifier.id, subtitle: subtitleOf(byIdentifier, dependencies.pair, "identifier") })], problem: null };
    }
    const messageId = await dependencies.indexer.findMessageByTransaction(shape.hash);
    const byTransaction = messageId === null ? null : await dependencies.indexer.message(messageId);
    if (byTransaction === null) {
      return { results: [], problem: "The indexer knows no message with this identifier or transaction hash." };
    }
    return { results: [transferResult({ messageId: byTransaction.id, subtitle: subtitleOf(byTransaction, dependencies.pair, "transaction") })], problem: null };
  } catch (error) {
    return { results: [], problem: `The indexer lookup failed: ${error instanceof Error ? error.message : String(error)}` };
  }
};
