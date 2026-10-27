import { and, eq } from "ponder";
import { ponder } from "ponder:registry";
import { bridgedSupply, claimEvents, claimables, messages, tokens } from "ponder:schema";
import { otherSide } from "@zk-bridge/shared";
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

/** A delivery paid an account on this chain. */
ponder.on("TokenMediator:TokensBridged", async ({ event, context }) => {
  const chainId = context.chain.id;
  const sourceChainId = otherSide(pair, chainId).chainId;
  await writeTransfer({
    database: context.db,
    messageId: event.args.messageId,
    sourceChainId,
    destinationChainId: chainId,
    patch: { destinationToken: event.args.token, paidTo: event.args.recipient, deliveredValue: event.args.value },
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

/** The recipient refused a release and the fallback address received it. */
ponder.on("TokenMediator:FallbackUsed", async ({ event, context }) => {
  const sourceChainId = otherSide(pair, context.chain.id).chainId;
  await writeMessage({
    database: context.db,
    messageId: event.args.messageId,
    sourceChainId,
    destinationChainId: context.chain.id,
    patch: { fallbackUsed: true },
  });
  await context.db.insert(claimEvents).values({
    id: event.id,
    chainId: context.chain.id,
    kind: "fallback_used",
    token: event.args.token,
    account: event.args.recipient,
    fallbackRecipient: event.args.fallbackRecipient,
    value: null,
    messageId: event.args.messageId,
    transactionHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  });
});

/** A release could not be paid and waits for `claim`. */
ponder.on("TokenMediator:ClaimableRecorded", async ({ event, context }) => {
  const chainId = context.chain.id;
  const { token, account, value, messageId } = event.args;
  await writeMessage({
    database: context.db,
    messageId,
    sourceChainId: otherSide(pair, chainId).chainId,
    destinationChainId: chainId,
    patch: { claimableOutstanding: true, claimableToken: token, claimableAccount: account },
  });
  const key = { chainId, token, account };
  const existing = await context.db.find(claimables, key);
  const recordedTotal = (existing?.recordedTotal ?? 0n) + value;
  const claimedTotal = existing?.claimedTotal ?? 0n;
  const row = { ...key, outstanding: (existing?.outstanding ?? 0n) + value, recordedTotal, claimedTotal };
  await context.db.insert(claimables).values(row).onConflictDoUpdate(row);
  await context.db.insert(claimEvents).values({
    id: event.id,
    chainId,
    kind: "claimable_recorded",
    token,
    account,
    fallbackRecipient: null,
    value,
    messageId,
    transactionHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  });
});

/** `claim` paid an account everything it was owed in a token. */
ponder.on("TokenMediator:Claimed", async ({ event, context }) => {
  const chainId = context.chain.id;
  const { token, account, value } = event.args;
  const key = { chainId, token, account };
  const existing = await context.db.find(claimables, key);
  const row = {
    ...key,
    outstanding: 0n,
    recordedTotal: existing?.recordedTotal ?? value,
    claimedTotal: (existing?.claimedTotal ?? 0n) + value,
  };
  await context.db.insert(claimables).values(row).onConflictDoUpdate(row);
  const waiting = await context.db.sql
    .select({ messageId: messages.messageId })
    .from(messages)
    .where(
      and(
        eq(messages.destinationChainId, chainId),
        eq(messages.claimableToken, token),
        eq(messages.claimableAccount, account),
        eq(messages.claimableOutstanding, true),
      ),
    );
  for (const message of waiting) {
    await writeMessage({
      database: context.db,
      messageId: message.messageId,
      sourceChainId: otherSide(pair, chainId).chainId,
      destinationChainId: chainId,
      patch: { claimableOutstanding: false, claimedTimestamp: event.block.timestamp },
    });
  }
  await context.db.insert(claimEvents).values({
    id: event.id,
    chainId,
    kind: "claimed",
    token,
    account,
    fallbackRecipient: null,
    value,
    messageId: null,
    transactionHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  });
  await refreshEscrow({
    database: context.db,
    client: context.client,
    chainId,
    token,
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
  await context.db.insert(claimEvents).values({
    id: event.id,
    chainId,
    kind: "callback_failed",
    token: event.args.token,
    account: event.args.recipient,
    fallbackRecipient: null,
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
