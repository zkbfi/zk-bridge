import { ponder } from "ponder:registry";
import { bridgeStates, deliveryCosts } from "ponder:schema";
import { decodeSend, isSingleDelivery, otherSide, sideOf } from "@zk-bridge/shared";
import { pair } from "../lib/pair";
import { writeMessage } from "../lib/message-store";
import { writeTransfer } from "../lib/transfer-store";

/** A message was sent on this chain. Decode it and, for a mediator call, record the transfer side. */
ponder.on("MessageBridge:UserRequestForAffirmation", async ({ event, context }) => {
  const decoded = decodeSend(pair, context.chain.id, event.args.encodedData);
  if (decoded.messageFacts.messageId !== event.args.messageId) {
    throw new Error(`message identifier mismatch in ${event.transaction.hash}: topic and data disagree`);
  }
  await writeMessage({
    database: context.db,
    messageId: event.args.messageId,
    sourceChainId: decoded.sourceChainId,
    destinationChainId: decoded.destinationChainId,
    sourceTimestampHint: event.block.timestamp,
    patch: {
      ...decoded.messageFacts,
      sentTransactionHash: event.transaction.hash,
      sentBlockNumber: event.block.number,
      sentTimestamp: event.block.timestamp,
      sentLogIndex: event.log.logIndex,
    },
  });
  const transfer = decoded.transfer;
  if (transfer === null) return;
  await writeTransfer({
    database: context.db,
    messageId: event.args.messageId,
    sourceChainId: decoded.sourceChainId,
    destinationChainId: decoded.destinationChainId,
    patch: {
      recipient: transfer.recipient,
      value: transfer.value,
      handler: transfer.handler,
      deploysCopy: transfer.deploysCopy,
      hasCallback: transfer.callbackData !== null,
      sourceIsNative: !transfer.releasesNativeToken,
      sentTimestamp: event.block.timestamp,
      ...(transfer.releasesNativeToken ? { destinationToken: transfer.token } : { sourceToken: transfer.token }),
    },
  });
});

/** A message was executed on this chain. The source chain is the other side of the pair. */
ponder.on("MessageBridge:AffirmationCompleted", async ({ event, context }) => {
  const source = otherSide(pair, context.chain.id);
  await writeMessage({
    database: context.db,
    messageId: event.args.messageId,
    sourceChainId: source.chainId,
    destinationChainId: context.chain.id,
    patch: {
      deliveredTransactionHash: event.transaction.hash,
      deliveredBlockNumber: event.block.number,
      deliveredTimestamp: event.block.timestamp,
      deliveredSuccess: event.args.status,
      executedBy: event.transaction.from,
    },
  });
  const bridge = sideOf(pair, context.chain.id).contracts.bridge;
  // The receipt that Ponder attaches to the event has no logs, so the handler reads the full receipt (cached by Ponder).
  const receipt = await context.client.getTransactionReceipt({ hash: event.transaction.hash });
  if (!isSingleDelivery(receipt.logs, bridge)) return;
  const cost = {
    messageId: event.args.messageId,
    destinationChainId: context.chain.id,
    transactionHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
    gasUsed: event.transactionReceipt.gasUsed,
    effectiveGasPrice: event.transactionReceipt.effectiveGasPrice,
  };
  await context.db.insert(deliveryCosts).values(cost).onConflictDoUpdate(cost);
});

/** The bridge on this chain opened its sends. */
ponder.on("MessageBridge:DepositsOpened", async ({ event, context }) => {
  const row = {
    chainId: context.chain.id,
    depositsOpen: true,
    openedRemoteSlot: event.args.remoteSlot,
    openedBlockNumber: event.block.number,
    openedTimestamp: event.block.timestamp,
  };
  await context.db.insert(bridgeStates).values(row).onConflictDoUpdate(row);
});
