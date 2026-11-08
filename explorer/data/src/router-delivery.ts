import { decodeEventLog, encodeEventTopics, parseAbi, type Address, type Hex } from "viem";
import { FIXED_FEE, MULTIPLIER_OF_TOTAL, normalizeAddress, readDeliveryTerms } from "@zkb/core";
import { deliveryRouterAbi } from "./abis/index.js";
import { decodeMediatorMessage } from "./mediator-message.js";

/**
 * What a delivery through a `DeliveryRouter` paid: what the router received, the fee to the deliverer (the router's
 * reward address), and what the recipient received. The mediator pays the router, so `TokensBridged` alone shows the
 * router as the recipient and the whole value as paid; this module finds the split.
 *
 * Sources, in order of preference:
 * - `event`: the router emits `Delivered` (routers deployed after 2026-11-07).
 * - `logs`: an older router emits nothing on success, so the split is read from the token's `Transfer` logs from the
 *   router in the delivery transaction (the fee to the reward address first, then the payout).
 * - `terms`: an older router that unwrapped to the native coin sends the coin with no log. The amount is the wrapped
 *   token's `Withdrawal`, and the fee follows from the sender's terms (the `FeeDirector` in the message): a fixed fee or
 *   a share of the value. A gas based fee cannot be recovered from the terms, so it stays unknown (null).
 */
export type FeeSource = "event" | "logs" | "terms";

/** How the recipient received the payout. */
export type PayoutKind = "token" | "native" | "wrapped";

/** The split of one router delivery, as read from the delivery transaction. */
export type RouterDelivery = {
  /** What the router received and could deliver, in base units of the destination token. */
  readonly amount: bigint;
  /** The fee paid to `deliverer`, or null when it can be found only from the terms (see `resolveTermsFee`). */
  readonly fee: bigint | null;
  /** What the recipient received, or null when the fee is unknown. Zero when the router handed the amount off. */
  readonly received: bigint | null;
  /** The account that received the fee, or null when no fee was paid (or it is not known yet). */
  readonly deliverer: Hex | null;
  /** The account that the router paid, or null when it is known only from the terms. */
  readonly finalRecipient: Hex | null;
  readonly feeSource: FeeSource;
  readonly payout: PayoutKind | null;
  /** True when the router handed the amount off to its failed delivery address (`DeliveryFailed`). */
  readonly handedOff: boolean;
};

/** A log as both viem receipts and test fixtures carry it. */
export type DeliveryLog = {
  readonly address: Hex;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly logIndex: number;
};

/** The inputs of {@link routerDeliveryFromLogs}. */
export type RouterDeliveryInput = {
  /** Every log of the delivery transaction. */
  readonly logs: readonly DeliveryLog[];
  /** The log index of the mediator's `TokensBridged` that paid the router. */
  readonly tokensBridgedLogIndex: number;
  readonly router: Hex;
  /** The token that the mediator paid. */
  readonly token: Hex;
  /** The value of `TokensBridged`. */
  readonly value: bigint;
  readonly wrappedNative: Hex;
  /** `rewardAddress()` of the router, or null when it could not be read. */
  readonly rewardAddress: Hex | null;
  /**
   * The contracts whose next log ends this delivery: the bridge (its `AffirmationCompleted` closes the execution) and
   * the mediator (the next delivery of a batch starts with it).
   */
  readonly boundaries: readonly Hex[];
  /**
   * Whether the router could take a fee: false when the message was executed on the bridge directly (the transaction
   * went to the bridge), so the router took none. Read only for the `terms` source.
   */
  readonly feePossible: boolean;
};

const ERC20_AND_WETH = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Withdrawal(address indexed src, uint256 wad)",
  "event Deposit(address indexed dst, uint256 wad)",
]);

const topicOf = (abi: typeof ERC20_AND_WETH | typeof deliveryRouterAbi, eventName: string): Hex =>
  (encodeEventTopics({ abi, eventName } as Parameters<typeof encodeEventTopics>[0])[0] as Hex).toLowerCase() as Hex;

const TRANSFER = topicOf(ERC20_AND_WETH, "Transfer");
const WITHDRAWAL = topicOf(ERC20_AND_WETH, "Withdrawal");
const DELIVERED = topicOf(deliveryRouterAbi, "Delivered");
const DELIVERY_FAILED = topicOf(deliveryRouterAbi, "DeliveryFailed");

/** The `PaidAs` enum of the router: 1 Token, 2 Native, 3 Wrapped. */
const PAID_AS: Readonly<Record<number, PayoutKind>> = { 1: "token", 2: "native", 3: "wrapped" };

const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
/** The address in an indexed topic. A topic is always a 32 byte word. */
const topicAddress = (topic: Hex | undefined): Hex => normalizeAddress(`0x${String(topic).slice(26)}`) as Hex;
const isFrom = (log: DeliveryLog, address: Hex, topic: Hex): boolean => same(log.address, address) && log.topics[0] !== undefined && same(log.topics[0], topic);

/** The logs of this delivery: after the `TokensBridged` log, up to the next log of the bridge or the mediator. */
const segmentOf = (input: RouterDeliveryInput): readonly DeliveryLog[] => {
  const after = [...input.logs].filter((log) => log.logIndex > input.tokensBridgedLogIndex).sort((a, b) => a.logIndex - b.logIndex);
  const end = after.findIndex((log) => input.boundaries.some((boundary) => same(log.address, boundary)));
  return end === -1 ? after : after.slice(0, end);
};

const fromEvent = (log: DeliveryLog): RouterDelivery => {
  const decoded = decodeEventLog({ abi: deliveryRouterAbi, eventName: "Delivered", topics: log.topics as [Hex, ...Hex[]], data: log.data });
  const args = decoded.args as { recipient: Address; feeTo: Address; amount: bigint; fee: bigint; paidOut: bigint; paidAs: number };
  return {
    amount: args.amount,
    fee: args.fee,
    received: args.paidOut,
    deliverer: args.fee === 0n ? null : (normalizeAddress(args.feeTo) as Hex),
    finalRecipient: normalizeAddress(args.recipient) as Hex,
    feeSource: "event",
    payout: PAID_AS[Number(args.paidAs)] ?? null,
    handedOff: false,
  };
};

const valueOf = (log: DeliveryLog): bigint => BigInt(log.data === "0x" ? 0 : log.data.slice(0, 66));

/**
 * Reads the split of one router delivery from the logs of its transaction.
 *
 * @param input The logs, the `TokensBridged` position, the router and its reward address.
 * @returns The split, or null when the segment holds no trace of the router (it was not called back).
 */
export const routerDeliveryFromLogs = (input: RouterDeliveryInput): RouterDelivery | null => {
  const segment = segmentOf(input);
  const event = segment.find((log) => isFrom(log, input.router, DELIVERED));
  if (event !== undefined) return fromEvent(event);

  const failedAt = segment.findIndex((log) => isFrom(log, input.router, DELIVERY_FAILED));
  const withdrawal = segment.find(
    (log) => isFrom(log, input.wrappedNative, WITHDRAWAL) && log.topics[1] !== undefined && same(topicAddress(log.topics[1]), input.router),
  );
  const routerTransfers = segment
    .map((log, position) => ({ log, position }))
    .filter(({ log }) => log.topics[1] !== undefined && log.topics[2] !== undefined && same(String(log.topics[0]), TRANSFER) && same(topicAddress(log.topics[1]), input.router));

  if (failedAt !== -1) {
    const failed = segment[failedAt] as DeliveryLog;
    const fee = routerTransfers
      .filter(({ log, position }) => position < failedAt && same(log.address, input.token) && input.rewardAddress !== null && same(topicAddress(log.topics[2]), input.rewardAddress))
      .reduce((sum, { log }) => sum + valueOf(log), 0n);
    return {
      amount: withdrawal === undefined ? input.value : valueOf(withdrawal),
      // A native fee leaves no log; the terms give it.
      fee: withdrawal === undefined ? fee : null,
      received: 0n,
      deliverer: fee > 0n ? input.rewardAddress : withdrawal === undefined ? null : input.feePossible ? input.rewardAddress : null,
      finalRecipient: topicAddress(failed.topics[2]),
      feeSource: withdrawal === undefined ? "logs" : "terms",
      payout: null,
      handedOff: true,
    };
  }

  if (withdrawal !== undefined) {
    // The coin went out with no log. A refused coin comes back as a wrapped token transfer to the recipient.
    const wrapped = routerTransfers.find(({ log }) => same(log.address, input.wrappedNative) && (input.rewardAddress === null || !same(topicAddress(log.topics[2]), input.rewardAddress)));
    return {
      amount: valueOf(withdrawal),
      fee: null,
      received: null,
      deliverer: input.feePossible ? input.rewardAddress : null,
      finalRecipient: wrapped === undefined ? null : topicAddress(wrapped.log.topics[2]),
      feeSource: "terms",
      payout: wrapped === undefined ? "native" : "wrapped",
      handedOff: false,
    };
  }

  const tokenTransfers = routerTransfers.filter(({ log }) => same(log.address, input.token)).map(({ log }) => log);
  if (tokenTransfers.length === 0) return null;
  // With the reward address known, every transfer to it is the fee. Without it, the router's order decides: the fee
  // goes first, then the payout, so of two transfers the first is the fee.
  const isFee = (log: DeliveryLog, index: number): boolean =>
    input.rewardAddress !== null ? same(topicAddress(log.topics[2]), input.rewardAddress) : tokenTransfers.length > 1 && index === 0;
  const feeLogs = tokenTransfers.filter(isFee);
  const payoutLogs = tokenTransfers.filter((log, index) => !isFee(log, index));
  const fee = feeLogs.reduce((sum, log) => sum + valueOf(log), 0n);
  const received = payoutLogs.reduce((sum, log) => sum + valueOf(log), 0n);
  const last = payoutLogs.at(-1);
  return {
    amount: fee + received,
    fee,
    received,
    deliverer: fee === 0n ? null : topicAddress((feeLogs[0] as DeliveryLog).topics[2]),
    finalRecipient: last === undefined ? null : topicAddress(last.topics[2]),
    feeSource: "logs",
    payout: "token",
    handedOff: false,
  };
};

/** The delivery facts that the explorer stores per transfer, and the API serves. */
export type DeliveryFeeFacts = {
  readonly deliveryRouter: Hex | null;
  readonly routerAmount: bigint | null;
  readonly fee: bigint | null;
  readonly received: bigint | null;
  readonly deliverer: Hex | null;
  readonly finalRecipient: Hex | null;
  readonly feeSource: string | null;
};

/**
 * Completes facts of the `terms` source with the terms of the message: the fee of a fixed or share director, capped at
 * the amount as the router caps it, and the recipient. A gas based fee stays unknown. A message executed on the bridge
 * directly (no deliverer) took no fee. Facts of other sources pass through unchanged.
 *
 * @param facts The stored facts.
 * @param messageData The call data of the message (the mediator handler call), or null when the send is not indexed yet.
 */
export const resolveTermsFee = (facts: DeliveryFeeFacts, messageData: Hex | null): DeliveryFeeFacts => {
  if (facts.feeSource !== "terms" || facts.fee !== null || facts.routerAmount === null) return facts;
  const amount = facts.routerAmount;
  const callback = messageData === null ? null : (decodeMediatorMessage(messageData)?.callbackData ?? null);
  const terms = callback === null ? null : readDeliveryTerms(callback);
  const recipient = terms?.kind === "director" ? (normalizeAddress(terms.director.recipient) as Hex) : terms?.kind === "legacy" ? (normalizeAddress(terms.receiver) as Hex) : null;
  const finalRecipient = facts.finalRecipient ?? recipient;
  const handedOff = facts.received === 0n;
  if (terms?.kind === "legacy" || facts.deliverer === null) {
    return { ...facts, fee: 0n, deliverer: null, received: handedOff ? 0n : amount, finalRecipient };
  }
  if (terms?.kind !== "director") return { ...facts, finalRecipient };
  const { settings, limit, multiplier } = terms.director;
  const raw = (settings & FIXED_FEE) !== 0n ? limit : (settings & MULTIPLIER_OF_TOTAL) !== 0n ? (amount * multiplier) / 10n ** 18n : null;
  if (raw === null) return { ...facts, finalRecipient };
  const fee = raw > amount ? amount : raw;
  return { ...facts, fee, deliverer: fee === 0n ? null : facts.deliverer, received: handedOff ? 0n : amount - fee, finalRecipient };
};
