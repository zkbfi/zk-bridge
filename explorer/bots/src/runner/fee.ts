import { decodeAbiParameters, type Address, type Hex } from "viem";
import { decodeMediatorMessage } from "@zk-bridge/shared";
import type { FeeQuote } from "../chain/transactions.ts";

/** The `FeeDirector` that the sender of the tokens put in the callback data (`FeeRouter.sol`). */
export interface FeeDirector {
  readonly recipient: Address;
  /** Flag bits: 1 fixed fee, 2 unwrap to the native coin, 4 base fee only, 8 share of the value. */
  readonly settings: bigint;
  readonly limit: bigint;
  readonly multiplier: bigint;
}

/** The `settings` bit that unwraps the wrapped native token to the native coin. */
export const UNWRAP_SETTING = 2n;

/** Why a message carries no fee offer. */
export type NoOfferReason =
  | "no-fee-router-configured"
  | "not-a-token-message"
  | "recipient-is-not-the-fee-router"
  | "no-callback-data"
  | "legacy-native-receiver"
  | "malformed-fee-director";

/** What the message offers to the runner. */
export type FeeOffer =
  | {
      readonly kind: "offer";
      readonly director: FeeDirector;
      /** The tokens that the mediator releases to the router. */
      readonly value: bigint;
    }
  | { readonly kind: "none"; readonly reason: NoOfferReason };

/** Input of {@link readFeeOffer}. */
export interface ReadFeeOfferInput {
  /** The call data of the message: a call to the mediator on the destination chain. */
  readonly messageData: Hex;
  /** The fee router of the destination chain, or null when none is configured. */
  readonly feeRouter: Address | null;
}

const FEE_DIRECTOR_BYTES = 128;

/**
 * Reads the fee offer of a message. A sender that wants a runner to deliver relays the tokens to the fee router with a
 * `FeeDirector` as callback data. In the message that is a mediator handler call whose recipient is the router and
 * whose callback data holds the four words of the director.
 */
export function readFeeOffer(input: ReadFeeOfferInput): FeeOffer {
  if (input.feeRouter === null) return { kind: "none", reason: "no-fee-router-configured" };
  const message = decodeMediatorMessage(input.messageData);
  if (message === null) return { kind: "none", reason: "not-a-token-message" };
  if (message.recipient.toLowerCase() !== input.feeRouter.toLowerCase()) return { kind: "none", reason: "recipient-is-not-the-fee-router" };
  if (message.callbackData === null) return { kind: "none", reason: "no-callback-data" };
  const bytes = (message.callbackData.length - 2) / 2;
  if (bytes === 20) return { kind: "none", reason: "legacy-native-receiver" };
  if (bytes !== FEE_DIRECTOR_BYTES) return { kind: "none", reason: "malformed-fee-director" };
  const [recipient, settings, limit, multiplier] = decodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
    message.callbackData,
  );
  return { kind: "offer", director: { recipient, settings, limit, multiplier }, value: message.value };
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
 * Turns the fee into wei, the unit of the gas cost. The wrapped native token is worth one wei per base unit. Any
 * other token needs a configured valuation. Without one the runner cannot compare, so it skips.
 */
export function valueFeeInWei(input: ValueFeeInput): FeeValue {
  const token = input.token.toLowerCase();
  if (token === input.wrappedNative.toLowerCase()) return { ok: true, wei: input.fee };
  const valuation = input.valuationsWei[token];
  if (valuation === undefined) return { ok: false, reason: "no-price-for-fee-token" };
  return { ok: true, wei: (input.fee * valuation) / 10n ** BigInt(input.decimals) };
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
