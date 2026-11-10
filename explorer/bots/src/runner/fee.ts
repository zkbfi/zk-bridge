import type { Address, Hex } from "viem";
import { decodeMediatorMessage, payoutOf, readDeliveryTerms, type DeliveryCall, type FeeDirector, type PayoutKind } from "@zk-bridge/shared";

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
 * token. For any other token the router pays the plain token, so the tip needs a price like any other token.
 */
export function payoutOfOffer(input: PayoutOfOfferInput): PayoutKind {
  return payoutOf(input.director.settings, input.token.toLowerCase() === input.wrappedNative.toLowerCase());
}
