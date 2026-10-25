import type { bridgedSupply, escrow, messages, tokens, transfers } from "ponder:schema";

/**
 * Conversion rules of the HTTP API: block numbers, timestamps, slots and chain identifiers are JSON numbers (they stay
 * far below 2^53). Every token amount is a decimal string of base units, because it can pass 2^53.
 */

/** A bigint that is a block number, a timestamp or a slot, as a JSON number. */
export const numberOf = (value: bigint | null | undefined): number | null =>
  value === null || value === undefined ? null : Number(value);

/** A bigint amount as a decimal string. */
export const amountOf = (value: bigint | null | undefined): string | null =>
  value === null || value === undefined ? null : value.toString();

type TokenRow = typeof tokens.$inferSelect;
type MessageRow = typeof messages.$inferSelect;
type TransferRow = typeof transfers.$inferSelect;
type EscrowRow = typeof escrow.$inferSelect;
type SupplyRow = typeof bridgedSupply.$inferSelect;

/** A lookup of token rows by chain and address. */
export type TokenIndex = ReadonlyMap<string, TokenRow>;

/**
 * Builds the lookup key of a token.
 *
 * @param chainId The chain.
 * @param address The token address, any letter case.
 */
export const tokenKey = (chainId: number, address: string): string => `${chainId}:${address.toLowerCase()}`;

/**
 * Indexes token rows.
 *
 * @param rows The rows of the `tokens` table.
 */
export const indexTokens = (rows: readonly TokenRow[]): TokenIndex => new Map(rows.map((row) => [tokenKey(row.chainId, row.address), row]));

/** The token as the API shows it. */
export const tokenView = (chainId: number, address: string | null, index: TokenIndex) => {
  if (address === null) return null;
  const row = index.get(tokenKey(chainId, address));
  return {
    chainId,
    address,
    symbol: row?.symbol ?? null,
    name: row?.name ?? null,
    decimals: row?.decimals ?? null,
    metadataRead: row?.metadataRead ?? false,
    isBridgedCopy: row?.isBridgedCopy ?? null,
    homeChainId: row?.homeChainId ?? null,
    homeToken: row?.homeToken ?? null,
  };
};

/** One feed item: a message with its transfer, when it has one. */
export const feedItemView = (message: MessageRow, transfer: TransferRow | null, index: TokenIndex) => ({
  messageId: message.messageId,
  kind: message.kind,
  status: message.status,
  direction: {
    sourceChainId: message.sourceChainId,
    destinationChainId: message.destinationChainId,
    label: message.direction,
  },
  sender: message.sender,
  executor: message.executor,
  gasLimit: message.gasLimit,
  sent:
    message.sentTimestamp === null
      ? null
      : {
          transactionHash: message.sentTransactionHash,
          blockNumber: numberOf(message.sentBlockNumber),
          timestamp: numberOf(message.sentTimestamp),
        },
  covered:
    message.coveredByHeadSlot === null
      ? null
      : { headSlot: numberOf(message.coveredByHeadSlot), timestamp: numberOf(message.coveredAtTimestamp) },
  delivered:
    message.deliveredTimestamp === null
      ? null
      : {
          transactionHash: message.deliveredTransactionHash,
          blockNumber: numberOf(message.deliveredBlockNumber),
          timestamp: numberOf(message.deliveredTimestamp),
          success: message.deliveredSuccess,
          executedBy: message.executedBy,
        },
  fallbackUsed: message.fallbackUsed,
  callbackFailed: message.callbackFailed,
  claimableOutstanding: message.claimableOutstanding,
  transfer:
    transfer === null
      ? null
      : {
          sourceToken: tokenView(transfer.sourceChainId, transfer.sourceToken, index),
          destinationToken: tokenView(transfer.destinationChainId, transfer.destinationToken, index),
          sender: transfer.sender,
          recipient: transfer.recipient,
          fallbackRecipient: transfer.fallbackRecipient,
          paidTo: transfer.paidTo,
          value: amountOf(transfer.value),
          deliveredValue: amountOf(transfer.deliveredValue),
          handler: transfer.handler,
          deploysCopy: transfer.deploysCopy,
          hasCallback: transfer.hasCallback,
          sourceIsNative: transfer.sourceIsNative,
        },
});

/** An escrow row as the API shows it. */
export const escrowView = (row: EscrowRow, index: TokenIndex) => ({
  chainId: row.chainId,
  token: tokenView(row.chainId, row.token, index),
  balance: amountOf(row.balance),
  accruedFees: amountOf(row.accruedFees),
  updatedBlockNumber: numberOf(row.updatedBlockNumber),
  updatedTimestamp: numberOf(row.updatedTimestamp),
});

/** A bridged supply row as the API shows it. */
export const supplyView = (row: SupplyRow, index: TokenIndex) => ({
  chainId: row.chainId,
  token: tokenView(row.chainId, row.token, index),
  nativeToken: row.nativeToken,
  homeChainId: row.homeChainId,
  minted: amountOf(row.minted),
  burned: amountOf(row.burned),
  supply: amountOf(row.supply),
  updatedBlockNumber: numberOf(row.updatedBlockNumber),
  updatedTimestamp: numberOf(row.updatedTimestamp),
});
