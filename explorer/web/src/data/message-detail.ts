import type { Address, Hex } from "viem";
import { messageCostsSchema, type MessageCosts } from "@zk-bridge/shared";
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
  /** True when the token is a bridged copy (it goes home as its native token); false or absent for a native token. */
  readonly isBridgedCopy?: boolean;
};

/** The token part of a message. Null for a message that carries no tokens. */
export type DetailTransfer = {
  readonly sourceToken: DetailToken;
  /**
   * The token that arrives, or null when the indexer does not know it yet: before the first delivery deploys the copy,
   * the destination token has no address (rc17: an in-flight tUSD transfer on the new contracts).
   */
  readonly destinationToken: DetailToken | null;
  readonly recipient: Address;
  /** The user who sent the tokens on the source chain (the message's own sender is the mediator), or null when the answer does not carry it. */
  readonly sender: Address | null;
  /** The amount that the mediator locked or burned on the source chain, in base units. */
  readonly value: bigint;
  readonly deliveredValue: bigint | null;
  readonly hasCallback: boolean;
  /**
   * The delivery fee, when a delivery router delivered (the indexer's `fee`, `received`, `deliverer`, `feeSource`,
   * `routerAmount`, `finalRecipient`). Null for a transfer that no router delivered, before the delivery, and in an
   * answer that does not carry them (the RPC source). Amounts are base units of the destination token.
   */
  readonly delivery: DetailDelivery | null;
};

/** What a delivery router paid out of a transfer. */
export type DetailDelivery = {
  readonly router: Address;
  /** What the router received. */
  readonly amount: bigint | null;
  /** The fee to the deliverer, or null when the indexer could not read it. */
  readonly fee: bigint | null;
  /** What the recipient received, or null when unknown. Zero when the router handed the amount off. */
  readonly received: bigint | null;
  readonly deliverer: Address | null;
  /** The account that the router paid. */
  readonly recipient: Address | null;
  readonly source: "event" | "logs" | "terms" | null;
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
  readonly sentAt: number;
  readonly sentBlockNumber: number;
  readonly sourceTransactionHash: Hex;
  /** The slot of the stored head that covers the send, or null. */
  readonly coveredByHeadSlot: number | null;
  readonly coveredAt: number | null;
  readonly deliveredAt: number | null;
  readonly destinationTransactionHash: Hex | null;
  /** The block of the delivery on the destination chain, or null while undelivered or when the answer does not carry it. */
  readonly deliveredBlockNumber: number | null;
  /** True when the destination call succeeded, false when it failed, null while undelivered. */
  readonly executedBy: Address | null;
  readonly callbackFailed: boolean;
  /** True when the mediator could not release the tokens to the recipient. The failure is final. */
  readonly releaseFailed: boolean;
  readonly transfer: DetailTransfer | null;
  /** The call data of the message, when the answer carries it. */
  readonly data: Hex | null;
  /** What the send, the delivery and the proof cost (the indexer's `costs`), or null when the answer has none (RPC). */
  readonly costs: MessageCosts | null;
};

const costsOf = (value: unknown): MessageCosts | null => {
  if (value === null || value === undefined) return null;
  const parsed = messageCostsSchema.safeParse(value);
  if (!parsed.success) throw new IndexerResponseError("The message's costs have an unknown shape.");
  return parsed.data;
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
    ...(row.isBridgedCopy === true ? { isBridgedCopy: true } : {}),
  };
};

const transferOf = (value: unknown): DetailTransfer | null => {
  if (value === null || value === undefined) return null;
  const row = readRecord(value, "transfer");
  return {
    sourceToken: tokenOf(row.sourceToken, "transfer.sourceToken"),
    destinationToken: row.destinationToken === null || row.destinationToken === undefined ? null : tokenOf(row.destinationToken, "transfer.destinationToken"),
    recipient: readAddress(row.recipient, "transfer.recipient"),
    sender: typeof row.sender === "string" ? readAddress(row.sender, "transfer.sender") : null,
    value: readAmount(row.value, "value"),
    deliveredValue: row.deliveredValue === null || row.deliveredValue === undefined ? null : readAmount(row.deliveredValue, "deliveredValue"),
    hasCallback: row.hasCallback === true,
    delivery: deliveryOf(row),
  };
};

const optionalAddress = (value: unknown, what: string): Address | null => (typeof value === "string" ? readAddress(value, what) : null);
const optionalAmount = (value: unknown, what: string): bigint | null => (value === null || value === undefined ? null : readAmount(value, what));

const deliveryOf = (row: Record<string, unknown>): DetailDelivery | null => {
  if (typeof row.deliveryRouter !== "string") return null;
  const source = row.feeSource === "event" || row.feeSource === "logs" || row.feeSource === "terms" ? row.feeSource : null;
  return {
    router: readAddress(row.deliveryRouter, "transfer.deliveryRouter"),
    amount: optionalAmount(row.routerAmount, "routerAmount"),
    fee: optionalAmount(row.fee, "fee"),
    received: optionalAmount(row.received, "received"),
    deliverer: optionalAddress(row.deliverer, "transfer.deliverer"),
    recipient: optionalAddress(row.finalRecipient, "transfer.finalRecipient"),
    source,
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
    sentAt: readInteger(sent.timestamp, "sent.timestamp"),
    sentBlockNumber: readInteger(sent.blockNumber, "sent.blockNumber"),
    sourceTransactionHash: readHex(sent.transactionHash, "sent.transactionHash"),
    coveredByHeadSlot: covered === null ? null : readNullableInteger(covered.headSlot),
    coveredAt: covered === null ? null : readNullableInteger(covered.timestamp),
    deliveredAt: delivered === null ? null : readNullableInteger(delivered.timestamp),
    destinationTransactionHash:
      delivered === null || typeof delivered.transactionHash !== "string" ? null : readHex(delivered.transactionHash, "delivered.transactionHash"),
    deliveredBlockNumber: delivered === null ? null : readNullableInteger(delivered.blockNumber),
    executedBy: delivered === null || typeof delivered.executedBy !== "string" ? null : readAddress(delivered.executedBy, "delivered.executedBy"),
    callbackFailed: item.callbackFailed === true,
    releaseFailed: item.releaseFailed === true,
    transfer: transferOf(item.transfer),
    data: typeof item.data === "string" ? readHex(item.data, "data") : null,
    costs: costsOf(item.costs),
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
