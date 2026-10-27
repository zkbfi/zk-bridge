import type { Hex } from "viem";
import { buildFixtureFeed, FIXTURE_NOW, FIXTURE_PAIR } from "@terminal/data/fixtures";
import type { FeedItem, PairConfig } from "@terminal/model/types";
import type { IndexerClient } from "./indexer-client";
import type { MessageDetail } from "./message-detail";

const detailOf = (item: FeedItem, pair: PairConfig): MessageDetail => {
  const [from, to] = item.direction === "first-to-second" ? [pair.first, pair.second] : [pair.second, pair.first];
  const token = item.token;
  return {
    id: item.id,
    kind: item.kind,
    status: item.status,
    sourceChainId: from.chainId,
    destinationChainId: to.chainId,
    sender: item.sender,
    executor: item.recipient,
    gasLimit: 2_000_000,
    sentAt: item.sentAt,
    sentBlockNumber: 12_000_000,
    sourceTransactionHash: item.sourceTransactionHash,
    coveredByHeadSlot: item.status === "sent" || item.status === "waiting_for_finality" ? null : 14_100_000,
    coveredAt: item.status === "sent" || item.status === "waiting_for_finality" ? null : item.sentAt + 700,
    deliveredAt: item.deliveredAt,
    destinationTransactionHash: item.destinationTransactionHash,
    deliverySucceeded: item.deliveredAt === null ? null : item.status !== "failed_call",
    executedBy: item.deliveredAt === null ? null : item.recipient,
    callbackFailed: false,
    releaseFailed: item.status === "release_failed",
    transfer:
      token === null || item.amount === null
        ? null
        : {
            sourceToken: { symbol: token.symbol, address: token.address, decimals: token.decimals, chainId: from.chainId },
            destinationToken: { symbol: token.symbol, address: token.counterpart ?? token.address, decimals: token.decimals, chainId: to.chainId },
            recipient: item.recipient,
            value: item.amount,
            deliveredValue: item.deliveredAt === null ? null : item.amount,
            hasCallback: false,
          },
    data: null,
  };
};

/**
 * An indexer client with no network. It answers from the fixture feed.
 *
 * @param options The pair to describe.
 */
export const createFixtureIndexerClient = (options: { readonly pair?: PairConfig } = {}): IndexerClient => {
  const pair = options.pair ?? FIXTURE_PAIR;
  const feed = buildFixtureFeed(FIXTURE_NOW);
  return {
    async message(messageId) {
      const item = feed.find((candidate) => candidate.id === messageId.toLowerCase());
      return item === undefined ? null : detailOf(item, pair);
    },
    async findMessageByTransaction(transactionHash: Hex) {
      const lower = transactionHash.toLowerCase();
      const item = feed.find((candidate) => candidate.sourceTransactionHash === lower || candidate.destinationTransactionHash === lower);
      return item?.id ?? null;
    },
  };
};
