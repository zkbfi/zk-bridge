import type { Address, Hex } from "viem";
import type { PairConfig } from "@terminal/model/types";
import { FEED_STATUSES, type FeedStatus } from "@terminal/model/types";
import {
  IndexerResponseError,
  readAddress,
  readAmount,
  readHex,
  readInteger,
  readNullableInteger,
  readRecord,
  readText,
} from "./json";

/** One token of a transfer, as the detail view shows it. */
export type DetailToken = {
  readonly symbol: string;
  readonly address: Address;
  readonly decimals: number;
  readonly chainId: number;
};

/** The token part of a message. Null for a message that carries no tokens. */
export type DetailTransfer = {
  readonly sourceToken: DetailToken;
  readonly destinationToken: DetailToken;
  readonly recipient: Address;
  readonly fallbackRecipient: Address;
  /** The amount after the bridge fee of the source chain, in base units. */
  readonly value: bigint;
  readonly deliveredValue: bigint | null;
  readonly hasCallback: boolean;
};

/** One message with the facts of both chains. */
export type MessageDetail = {
  readonly id: Hex;
  readonly kind: "token" | "message";
  readonly status: FeedStatus;
  readonly sourceChainId: number;
  readonly destinationChainId: number;
  readonly sender: Address;
  readonly executor: Address;
  readonly gasLimit: number | null;
  readonly sentAt: number;
  readonly sentBlockNumber: number;
  readonly sourceTransactionHash: Hex;
  /** The slot of the stored head that covers the send, or null. */
  readonly coveredByHeadSlot: number | null;
  readonly coveredAt: number | null;
  readonly deliveredAt: number | null;
  readonly destinationTransactionHash: Hex | null;
  /** True when the destination call succeeded, false when it failed, null while undelivered. */
  readonly deliverySucceeded: boolean | null;
  readonly executedBy: Address | null;
  readonly fallbackUsed: boolean;
  readonly callbackFailed: boolean;
  readonly claimableOutstanding: boolean;
  readonly transfer: DetailTransfer | null;
  /** The call data of the message, when the answer carries it. */
  readonly data: Hex | null;
};

const tokenOf = (value: unknown, what: string): DetailToken => {
  const row = readRecord(value, what);
  const address = readAddress(row.address, `${what}.address`);
  return {
    address,
    symbol: typeof row.symbol === "string" ? row.symbol : `${address.slice(0, 8)}…`,
    // The indexer sets decimals to 18 by assumption when the token did not answer.
    decimals: typeof row.decimals === "number" ? row.decimals : 18,
    chainId: readInteger(row.chainId, `${what}.chainId`),
  };
};

const transferOf = (value: unknown): DetailTransfer | null => {
  if (value === null || value === undefined) return null;
  const row = readRecord(value, "transfer");
  return {
    sourceToken: tokenOf(row.sourceToken, "transfer.sourceToken"),
    destinationToken: tokenOf(row.destinationToken, "transfer.destinationToken"),
    recipient: readAddress(row.recipient, "transfer.recipient"),
    fallbackRecipient: readAddress(row.fallbackRecipient ?? row.recipient, "transfer.fallbackRecipient"),
    value: readAmount(row.value, "value"),
    deliveredValue: row.deliveredValue === null || row.deliveredValue === undefined ? null : readAmount(row.deliveredValue, "deliveredValue"),
    hasCallback: row.hasCallback === true,
  };
};

/**
 * Reads one item of `GET /api/messages/:messageId`, or one item of `GET /api/feed`, into the detail that the message page shows.
 *
 * @param value The parsed JSON of the item.
 * @throws IndexerResponseError when a field has the wrong shape.
 */
export const parseMessageDetail = (value: unknown): MessageDetail => {
  const item = readRecord(value, "message");
  const direction = readRecord(item.direction, "direction");
  const sent = readRecord(item.sent, "sent");
  const covered = item.covered === null || item.covered === undefined ? null : readRecord(item.covered, "covered");
  const delivered = item.delivered === null || item.delivered === undefined ? null : readRecord(item.delivered, "delivered");
  const status = readText(item.status, "status");
  if (!(FEED_STATUSES as readonly string[]).includes(status)) throw new IndexerResponseError(`Unknown status "${status}".`);
  return {
    id: readHex(item.messageId, "messageId"),
    kind: item.kind === "token" ? "token" : "message",
    status: status as FeedStatus,
    sourceChainId: readInteger(direction.sourceChainId, "direction.sourceChainId"),
    destinationChainId: readInteger(direction.destinationChainId, "direction.destinationChainId"),
    sender: readAddress(item.sender, "sender"),
    executor: readAddress(item.executor, "executor"),
    gasLimit: readNullableInteger(item.gasLimit),
    sentAt: readInteger(sent.timestamp, "sent.timestamp"),
    sentBlockNumber: readInteger(sent.blockNumber, "sent.blockNumber"),
    sourceTransactionHash: readHex(sent.transactionHash, "sent.transactionHash"),
    coveredByHeadSlot: covered === null ? null : readNullableInteger(covered.headSlot),
    coveredAt: covered === null ? null : readNullableInteger(covered.timestamp),
    deliveredAt: delivered === null ? null : readNullableInteger(delivered.timestamp),
    destinationTransactionHash:
      delivered === null || typeof delivered.transactionHash !== "string" ? null : readHex(delivered.transactionHash, "delivered.transactionHash"),
    deliverySucceeded: delivered === null || typeof delivered.success !== "boolean" ? null : delivered.success,
    executedBy: delivered === null || typeof delivered.executedBy !== "string" ? null : readAddress(delivered.executedBy, "delivered.executedBy"),
    fallbackUsed: item.fallbackUsed === true,
    callbackFailed: item.callbackFailed === true,
    claimableOutstanding: item.claimableOutstanding === true,
    transfer: transferOf(item.transfer),
    data: typeof item.data === "string" ? readHex(item.data, "data") : null,
  };
};

/**
 * The name of a chain of the pair, or `chain <id>` for any other.
 *
 * @param pair The pair.
 * @param chainId The chain identifier.
 */
export const chainNameOf = (pair: PairConfig, chainId: number): string =>
  [pair.first, pair.second].find((chain) => chain.chainId === chainId)?.name ?? `chain ${chainId}`;
