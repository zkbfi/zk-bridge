import type { Address, Hex } from "viem";
import { CALL_GAS_RESERVE, decodeMediatorMessage, gasOverheadOf, payoutOf, readDeliveryTerms, tokenUnitsToWeiFloor, type DeliveryCall, type FeeDirector, type PayoutKind } from "@zk-bridge/shared";
import type { FeeQuote } from "../chain/transactions.ts";

/** The director is the shared one: it matches `DeliveryRouter.sol` and the vectors of the router (`@zk-bridge/shared`). */
export type { FeeDirector };

/** Why a message carries no fee offer. */
export type NoOfferReason =
  | "no-delivery-router-configured"
  | "not-a-token-message"
  | "recipient-is-not-the-delivery-router"
  | "no-callback-data"
  | "legacy-native-receiver"
  | "unknown-callback-data";

/** What the message offers to the runner. */
export type FeeOffer =
  | {
      readonly kind: "offer";
      readonly director: FeeDirector;
      /** The tokens that the mediator releases to the router. */
      readonly value: bigint;
      /** The call that the router makes after the payment, or null when the data carries none. */
      readonly call: DeliveryCall | null;
    }
  | { readonly kind: "none"; readonly reason: NoOfferReason };

/** Input of {@link readFeeOffer}. */
export interface ReadFeeOfferInput {
  /** The call data of the message: a call to the mediator on the destination chain. */
  readonly messageData: Hex;
  /** The delivery router of the destination chain, or null when none is configured. */
  readonly deliveryRouter: Address | null;
}

/**
 * Reads the fee offer of a message. A sender that wants a runner to deliver relays the tokens to the delivery router with a
 * `FeeDirector` as callback data. In the message that is a mediator handler call whose recipient is the router and
 * whose callback data holds the four words of the director.
 */
export function readFeeOffer(input: ReadFeeOfferInput): FeeOffer {
  if (input.deliveryRouter === null) return { kind: "none", reason: "no-delivery-router-configured" };
  const message = decodeMediatorMessage(input.messageData);
  if (message === null) return { kind: "none", reason: "not-a-token-message" };
  if (message.recipient.toLowerCase() !== input.deliveryRouter.toLowerCase()) return { kind: "none", reason: "recipient-is-not-the-delivery-router" };
  if (message.callbackData === null) return { kind: "none", reason: "no-callback-data" };
  const terms = readDeliveryTerms(message.callbackData);
  if (terms.kind === "legacy") return { kind: "none", reason: "legacy-native-receiver" };
  if (terms.kind === "unknown") return { kind: "none", reason: "unknown-callback-data" };
  return { kind: "offer", director: terms.director, value: message.value, call: terms.call };
}

/** Input of {@link callGasAllowance}. */
export interface CallGasAllowanceInput {
  /** The gas that is left when the router measures the tip. */
  readonly gasLeft: bigint;
  /** How the router pays the tip: it sets the overhead that the router holds back. */
  readonly payout: PayoutKind;
}

/**
 * The gas that the tip measure of the router adds for a user call: the gas left, less the payout overhead and
 * `CALL_GAS_RESERVE`, or zero when the gas left does not pass that sum. It mirrors `DeliveryRouter._callGasAllowance`.
 */
export function callGasAllowance(input: CallGasAllowanceInput): bigint {
  const held = gasOverheadOf(input.payout) + CALL_GAS_RESERVE;
  return input.gasLeft > held ? input.gasLeft - held : 0n;
}

/** Input of {@link feeGasUnitsOf}. */
export interface FeeGasUnitsInput {
  /** The user call of the offer, or null when the offer has none. */
  readonly call: DeliveryCall | null;
  /** The gas of the execution, as simulated: what the tip counts when there is no call. */
  readonly executionGas: bigint;
  /** The gas limit that the runner plans to send. The call may use what the execution leaves of it. */
  readonly plannedGas: bigint;
  readonly payout: PayoutKind;
}

/**
 * The gas that the router counts for the tip of an offer. Without a call it is the gas of the execution. With a call the
 * router adds the allowance of the call, because the call runs after the tip: the gas left at the measure is the
 * planned gas less the execution gas, so the tip reaches up to the gas that the runner makes available.
 */
export function feeGasUnitsOf(input: FeeGasUnitsInput): bigint {
  if (input.call === null) return input.executionGas;
  const gasLeft = input.plannedGas > input.executionGas ? input.plannedGas - input.executionGas : 0n;
  return input.executionGas + callGasAllowance({ gasLeft, payout: input.payout });
}

/** Input of {@link payoutOfOffer}. */
export interface PayoutOfOfferInput {
  readonly director: FeeDirector;
  /** The token that the mediator releases to the router. */
  readonly token: Address;
  readonly wrappedNative: Address;
}

/**
 * How the router pays the tip. The native coin only when the settings ask to unwrap and the token is the wrapped native
 * token. For any other token the router pays the plain token, so the tip needs a valuation like any other token.
 */
export function payoutOfOffer(input: PayoutOfOfferInput): PayoutKind {
  return payoutOf(input.director.settings, input.token.toLowerCase() === input.wrappedNative.toLowerCase());
}

/** Input of {@link valueFeeInWei}. */
export interface ValueFeeInput {
  /** The fee in the smallest unit of the token. */
  readonly fee: bigint;
  readonly token: Address;
  readonly decimals: number;
  readonly director: FeeDirector;
  readonly wrappedNative: Address;
  /** The value of one whole token in wei, by lowercase token address. */
  readonly valuationsWei: Readonly<Record<string, bigint>>;
}

/** The fee measured in wei of the native coin. */
export type FeeValue = { readonly ok: true; readonly wei: bigint } | { readonly ok: false; readonly reason: "no-price-for-fee-token" };

/**
 * Turns the fee into wei, the unit of the gas cost. The wrapped native token is worth one wei per base unit, whether the
 * router pays it as the token or unwraps it. Any other token needs a configured valuation, also when the settings ask to
 * unwrap: the router then pays the plain token. Without a valuation the runner cannot compare, so it skips.
 */
export function valueFeeInWei(input: ValueFeeInput): FeeValue {
  const token = input.token.toLowerCase();
  if (token === input.wrappedNative.toLowerCase()) return { ok: true, wei: input.fee };
  const valuation = input.valuationsWei[token];
  if (valuation === undefined || valuation <= 0n) return { ok: false, reason: "no-price-for-fee-token" };
  return { ok: true, wei: tokenUnitsToWeiFloor(input.fee, { tokenValueInWei: valuation, tokenDecimals: input.decimals }) };
}

/** Input of {@link decideDelivery}. */
export interface DeliveryDecisionInput {
  readonly feeWei: bigint;
  readonly gasUnits: bigint;
  readonly quote: FeeQuote;
  readonly minimumMarginWei: bigint;
}

/** The comparison of the fee with the cost. */
export type DeliveryDecision =
  | { readonly deliver: true; readonly costWei: bigint; readonly profitWei: bigint }
  | { readonly deliver: false; readonly costWei: bigint; readonly shortfallWei: bigint };

/**
 * Delivers only when the fee covers the gas cost at the current base fee plus the priority fee, and the margin.
 */
export function decideDelivery(input: DeliveryDecisionInput): DeliveryDecision {
  const costWei = input.gasUnits * (input.quote.baseFee + input.quote.priorityFee);
  const required = costWei + input.minimumMarginWei;
  if (input.feeWei >= required) return { deliver: true, costWei, profitWei: input.feeWei - costWei };
  return { deliver: false, costWei, shortfallWei: required - input.feeWei };
}
