import type { Address, Hex } from "viem";
import { decodeMediatorMessage, payoutOf, readDeliveryTerms, tokenUnitsToWeiFloor, type DeliveryCall, type FeeDirector, type PayoutKind } from "@zk-bridge/shared";

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

/** Input of {@link feeGasUnitsOf}. */
export interface FeeGasUnitsInput {
  /** The user call of the offer, or null when the offer has none. */
  readonly call: DeliveryCall | null;
  /** The gas of the execution, as estimated. */
  readonly executionGas: bigint;
  /** The `callGas` of the director of the offer. */
  readonly callGas: bigint;
}

/**
 * The gas that the router counts for the tip of an offer: the gas of the execution, plus the `callGas` of the director
 * when the offer asks for a follow-up call. The call gets exactly `callGas`, so the count does not depend on what the
 * runner makes available.
 */
export function feeGasUnitsOf(input: FeeGasUnitsInput): bigint {
  return input.call === null ? input.executionGas : input.executionGas + input.callGas;
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
  /** What the tip is worth in wei. */
  readonly feeWei: bigint;
  /** What the delivery costs in wei, with its share of the light client update. */
  readonly costWei: bigint;
  /** The share of the cost that the runner accepts to lose, from 0 to 100. A loss at this share is already too much. */
  readonly maximumLossPercent: number;
}

/**
 * The comparison of the tip with the cost. `lossWei` is the cost less the tip. It is negative when the tip is above the
 * cost.
 */
export type DeliveryDecision =
  | { readonly deliver: true; readonly costWei: bigint; readonly lossWei: bigint }
  | { readonly deliver: false; readonly costWei: bigint; readonly lossWei: bigint };

/**
 * Delivers when there is no loss (the tip is at or above the cost), and otherwise when the loss stays under the share of
 * the cost that the setting allows: `(cost - fee) * 100` is less than `maximumLossPercent * cost`. A loss of exactly that
 * share is left out. A tip of nothing on a cost above zero is a full loss.
 */
export function decideDelivery(input: DeliveryDecisionInput): DeliveryDecision {
  const { costWei, feeWei } = input;
  const lossWei = costWei - feeWei;
  const deliver = lossWei <= 0n || lossWei * 100n < BigInt(input.maximumLossPercent) * costWei;
  return { deliver, costWei, lossWei };
}
