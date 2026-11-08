import { ponder } from "ponder:registry";
import { bridgedSupply, releaseEvents, tokens } from "ponder:schema";
import { deliveryRoutersOf, otherSide, sideOf } from "@zk-bridge/shared";
import { routerDeliveryPatch, type RouterDeliveryClient } from "../lib/router-delivery";
import { refreshEscrow } from "../lib/escrow";
import { writeMessage } from "../lib/message-store";
import { pair } from "../lib/pair";
import { ensureToken, nativeTokenBehind } from "../lib/tokens";
import { writeTransfer } from "../lib/transfer-store";

/** A sender started a transfer on this chain: tokens were locked (native) or burned (bridged copy). */
ponder.on("TokenMediator:TokensBridgingInitiated", async ({ event, context }) => {
  const chainId = context.chain.id;
  const destinationChainId = otherSide(pair, chainId).chainId;
  const nativeBehind = await nativeTokenBehind(context.client, chainId, event.args.token);
  const isBridgedCopy = nativeBehind !== null;
  await ensureToken({
    database: context.db,
    client: context.client,
    chainId,
    address: event.args.token,
    hints: isBridgedCopy
      ? { isBridgedCopy: true, homeChainId: destinationChainId, homeToken: nativeBehind }
      : { isBridgedCopy: false, homeChainId: chainId, homeToken: event.args.token },
  });
  await writeTransfer({
    database: context.db,
    messageId: event.args.messageId,
    sourceChainId: chainId,
    destinationChainId,
    patch: {
      sourceToken: event.args.token,
      sender: event.args.sender,
      value: event.args.value,
      sourceIsNative: !isBridgedCopy,
      sentTimestamp: event.block.timestamp,
    },
  });
  await refreshEscrow({
    database: context.db,
    client: context.client,
    chainId,
    token: event.args.token,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  });
});

/**
 * A delivery paid an account on this chain. When the account is one of the side's delivery routers, the handler also
 * records the split of the router: what it received, the fee and what the recipient received.
 */
ponder.on("TokenMediator:TokensBridged", async ({ event, context }) => {
  const chainId = context.chain.id;
  const sourceChainId = otherSide(pair, chainId).chainId;
  const side = sideOf(pair, chainId);
  const router = deliveryRoutersOf(side).find((address: string) => address === event.args.recipient.toLowerCase()) ?? null;
  const split =
    router === null
      ? {}
      : await routerDeliveryPatch({
          client: context.client as unknown as RouterDeliveryClient,
          side,
          router,
          token: event.args.token,
          value: event.args.value,
          transactionHash: event.transaction.hash,
          transactionTo: event.transaction.to ?? null,
          logIndex: event.log.logIndex,
          blockNumber: event.block.number,
        });
  await writeTransfer({
    database: context.db,
    messageId: event.args.messageId,
    sourceChainId,
    destinationChainId: chainId,
    patch: { destinationToken: event.args.token, paidTo: event.args.recipient, deliveredValue: event.args.value, ...split },
  });
  await refreshEscrow({
    database: context.db,
    client: context.client,
    chainId,
    token: event.args.token,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  });
});

/** The mediator deployed the bridged copy of a native token. */
ponder.on("TokenMediator:NewTokenRegistered", async ({ event, context }) => {
  await ensureToken({
    database: context.db,
    client: context.client,
    chainId: context.chain.id,
    address: event.args.bridgedToken,
    hints: {
      isBridgedCopy: true,
      homeChainId: otherSide(pair, context.chain.id).chainId,
      homeToken: event.args.nativeToken,
      registeredTransactionHash: event.transaction.hash,
      registeredBlockNumber: event.block.number,
      registeredTimestamp: event.block.timestamp,
    },
  });
});

/** A release the recipient cannot take is final. The mediator keeps no claim record, so the indexer keeps none. */
ponder.on("TokenMediator:ReleaseFailed", async ({ event, context }) => {
  const chainId = context.chain.id;
  const { token, recipient, value, messageId } = event.args;
  await writeMessage({
    database: context.db,
    messageId,
    sourceChainId: otherSide(pair, chainId).chainId,
    destinationChainId: chainId,
    patch: { releaseFailed: true },
  });
  await context.db.insert(releaseEvents).values({
    id: event.id,
    chainId,
    kind: "release_failed",
    token,
    account: recipient,
    value,
    messageId,
    transactionHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  });
});

/** The `onTokenBridged` callback of a recipient failed. The tokens stay with the recipient. */
ponder.on("TokenMediator:CallbackFailed", async ({ event, context }) => {
  const chainId = context.chain.id;
  await writeMessage({
    database: context.db,
    messageId: event.args.messageId,
    sourceChainId: otherSide(pair, chainId).chainId,
    destinationChainId: chainId,
    patch: { callbackFailed: true },
  });
  await context.db.insert(releaseEvents).values({
    id: event.id,
    chainId,
    kind: "callback_failed",
    token: event.args.token,
    account: event.args.recipient,
    value: null,
    messageId: event.args.messageId,
    transactionHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  });
});

/**
 * Moves the supply of a bridged copy by a mint (a transfer from the zero address) or a burn (to the zero address).
 * The two events come from two filters, so each handler knows which one it got.
 */
const recordSupplyChange = async (
  context: Parameters<Parameters<typeof ponder.on<"BridgedTokenMints:Transfer">>[1]>[0]["context"],
  event: { log: { address: `0x${string}` }; args: { value: bigint }; block: { number: bigint; timestamp: bigint } },
  change: { readonly mint: bigint; readonly burn: bigint },
): Promise<void> => {
  const chainId = context.chain.id;
  const token = event.log.address;
  const registered = await context.db.find(tokens, { chainId, address: token });
  if (!registered) throw new Error(`transfer of ${token} on chain ${chainId} before its registration`);
  const existing = await context.db.find(bridgedSupply, { chainId, token });
  const minted = (existing?.minted ?? 0n) + change.mint;
  const burned = (existing?.burned ?? 0n) + change.burn;
  const row = {
    chainId,
    token,
    nativeToken: registered.homeToken,
    homeChainId: registered.homeChainId,
    minted,
    burned,
    supply: minted - burned,
    updatedBlockNumber: event.block.number,
    updatedTimestamp: event.block.timestamp,
  };
  await context.db.insert(bridgedSupply).values(row).onConflictDoUpdate(row);
};

ponder.on("BridgedTokenMints:Transfer", ({ event, context }) =>
  recordSupplyChange(context, event, { mint: event.args.value, burn: 0n }),
);

ponder.on("BridgedTokenBurns:Transfer", ({ event, context }) =>
  recordSupplyChange(context, event, { mint: 0n, burn: event.args.value }),
);
