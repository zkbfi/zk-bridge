import { encodeFunctionData, parseAbi, type Hex } from "viem";
import { costView, tokenMediatorAbi, transactionCostRow, type CostView, type MessageCosts } from "@zk-bridge/shared";
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

/** Sample coin prices (USD × 1e18) of the sample data, at block 0: ETH $3,000, PLS $0.00003. */
const SAMPLE_COIN_USD_E18: Readonly<Record<number, bigint>> = { 1: 3_000n * 10n ** 18n, 369: 30_000_000_000_000n };
/** The sample light client update's transaction. */
const SAMPLE_PROOF_TRANSACTION: Hex = `0x${"3".repeat(64)}`;

/** A sample cost: the gas at the sample base fee of 7 gwei, priced at the sample coin price. */
const sampleCost = (chainId: number, hash: Hex, gasUsed: bigint): CostView => {
  const usdE18 = SAMPLE_COIN_USD_E18[chainId];
  return costView(
    transactionCostRow({ chainId, transactionHash: hash, blockNumber: 12_000_000n, timestamp: BigInt(FIXTURE_NOW), gasUsed, effectiveGasPrice: 7_000_000_000n, price: usdE18 === undefined ? null : { usdE18, block: 0n, pool: null, source: chainId === 369 ? "pulsex-pls-usd" : "pulsex-weth-copy" } }),
  )!;
};

/** The sample costs of a message: the send, the delivery, and a light client update shared by three messages. */
const sampleCosts = (item: FeedItem, from: number, to: number, covered: boolean): MessageCosts => ({
  sent: sampleCost(from, item.sourceTransactionHash, 120_000n),
  delivered: item.destinationTransactionHash === null ? null : sampleCost(to, item.destinationTransactionHash, 210_000n),
  proof: covered ? { ...sampleCost(to, SAMPLE_PROOF_TRANSACTION, 1_500_000n), coveredMessages: 3 } : null,
});

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
    costs: sampleCosts(item, from.chainId, to.chainId, !(item.status === "sent" || item.status === "waiting_for_finality")),
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
    async transactionCost(chainId, transactionHash) {
      const lower = transactionHash.toLowerCase();
      const item = feed.find((candidate) => candidate.sourceTransactionHash === lower || candidate.destinationTransactionHash === lower);
      if (item === undefined) return null;
      const detail = detailOf(item, pair);
      const costs = [detail.costs!.sent, detail.costs!.delivered];
      return costs.find((cost) => cost !== null && cost.chainId === chainId && cost.hash === lower) ?? null;
    },
  };
};
