import { encodeFunctionData, parseAbi, type Hex } from "viem";
import { tokenMediatorAbi } from "@zk-bridge/shared";
import { buildFixtureFeed, FIXTURE_NOW, FIXTURE_PAIR } from "@terminal/data/fixtures";
import type { FeedItem, PairConfig } from "@terminal/model/types";
import type { IndexerClient } from "./indexer-client";
import type { MessageDetail } from "./message-detail";

// A sample call for a plain message: any contract on the other chain, with data the sender chose.
const SAMPLE_CALL_ABI = parseAbi(["function setRoute(uint256 id, address to)"]);

/**
 * The payload of a sample message: for a transfer, the mediator handler call that the indexer would carry (release the
 * native token on its home chain, else mint the bridged copy); for a plain message, a sample call.
 */
const payloadOf = (item: FeedItem): Hex => {
  const token = item.token;
  if (token === null || item.amount === null) return encodeFunctionData({ abi: SAMPLE_CALL_ABI, functionName: "setRoute", args: [7n, item.recipient] });
  // The sample tokens on the source side are either native there or a "zkb" copy of a token native on the destination.
  const homeIsSource = !token.symbol.startsWith("zkb");
  const functionName = homeIsSource ? "handleBridgedTokens" : "handleNativeTokens";
  return encodeFunctionData({ abi: tokenMediatorAbi, functionName, args: [homeIsSource ? token.address : (token.counterpart ?? token.address), item.recipient, item.amount] });
};

const detailOf = (item: FeedItem, pair: PairConfig): MessageDetail => {
  const [from, to] = item.direction === "first-to-second" ? [pair.first, pair.second] : [pair.second, pair.first];
  const token = item.token;
  const isTransfer = token !== null && item.amount !== null;
  return {
    id: item.id,
    kind: item.kind,
    status: item.status,
    sourceChainId: from.chainId,
    destinationChainId: to.chainId,
    // A transfer is a message from the mediator on one side to the mediator on the other; the user is the transfer's sender.
    sender: isTransfer ? from.contracts.tokenMediator : item.sender,
    executor: isTransfer ? to.contracts.tokenMediator : item.recipient,
    gasLimit: 2_000_000,
    sentAt: item.sentAt,
    sentBlockNumber: 12_000_000,
    sourceTransactionHash: item.sourceTransactionHash,
    coveredByHeadSlot: item.status === "sent" || item.status === "waiting_for_finality" ? null : 14_100_000,
    coveredAt: item.status === "sent" || item.status === "waiting_for_finality" ? null : item.sentAt + 700,
    deliveredAt: item.deliveredAt,
    destinationTransactionHash: item.destinationTransactionHash,
    deliveredBlockNumber: null,
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
            sender: item.sender,
            value: item.amount,
            deliveredValue: item.deliveredAt === null ? null : item.amount,
            hasCallback: false,
          },
    data: payloadOf(item),
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
