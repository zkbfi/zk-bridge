/**
 * What a delivery through a router really did when it did not simply pay the recipient: the words for the message page and
 * the Activity screen. The router has three outcomes that look like a delivery in the list of steps and are not one:
 *
 * - its callback failed (the mediator's `CallbackFailed` on a router recipient): the router holds the tokens, the recipient got nothing;
 * - it handed the amount off (`DeliveryFailed`): the failed delivery address got the amount, and when that address refused too
 *   (`HandOffRefused`) the tokens stay in the router;
 * - the call after the payout failed (`CallFailed`): the recipient was paid and kept the tokens.
 *
 * There is no claim function. Tokens left in the router go to the failed delivery address when anyone calls `sweep`.
 */
import type { Address } from "viem";
import type { HandOffReason } from "../data/message-detail";

/** The facts of one delivery that decide its outcome. */
export type OutcomeFacts = {
  /** The mediator's `CallbackFailed` was emitted for the message. */
  readonly callbackFailed: boolean;
  /** True when a delivery router received the mediator's payment. */
  readonly viaRouter: boolean;
  readonly handOffReason: HandOffReason | null;
  readonly handOffRefused: boolean;
  readonly callFailed: { readonly target: Address; readonly callGas: bigint } | null;
};

/** The outcome of a delivery that did not pay the recipient as asked, or paid and then failed the call after it. */
export type DeliveryOutcome = {
  readonly kind: "router-callback-failed" | "handed-off" | "call-failed";
  /** The delivery step's label. */
  readonly label: string;
  /** Say what happened and where the tokens are, one paragraph each. */
  readonly paragraphs: readonly string[];
  /** The same in one sentence, for a row of a list. */
  readonly short: string;
};

/** What a reader needs to name: the destination chain, the failed delivery address when known, and the amount. */
export type OutcomeContext = {
  readonly destination: string;
  /** The router's `failedDeliveryAddress()`, or null when the page could not read it. */
  readonly failedDelivery: Address | null;
  /** The amount that the router handled, with its symbol ("12.5 USDC"), or null when unknown. */
  readonly amountText: string | null;
  /** Who the router should have paid, or null when unknown. */
  readonly recipient: Address | null;
};

const REASONS: Readonly<Record<HandOffReason, string>> = {
  PayoutRefused: "the token or the recipient refused the payout",
  InvalidTerms: "the terms in the message were not valid for a payout",
  Reentered: "the delivery ran inside another delivery",
};

/**
 * The outcome of a delivery, or null when it was an ordinary one (or a failed callback of a recipient that is not a router).
 *
 * @param facts What the indexer recorded.
 * @param context The names the sentences use.
 */
export const deliveryOutcome = (facts: OutcomeFacts, context: OutcomeContext): DeliveryOutcome | null => {
  const failedAddress = context.failedDelivery === null ? "the router's failed delivery address" : `the router's failed delivery address (${context.failedDelivery})`;
  if (facts.handOffReason !== null || facts.handOffRefused) {
    const who = context.recipient === null ? "the recipient" : context.recipient;
    const reason = facts.handOffReason === null ? "" : `: ${REASONS[facts.handOffReason]}`;
    const handled = context.amountText === null ? "the amount" : context.amountText;
    const paragraphs = [
      `The router could not pay ${who}${reason}. It handed ${handled} to ${failedAddress}.`,
      facts.handOffRefused
        ? "The failed delivery address refused the hand-off too. The recipient received nothing, and the tokens stay in the router until anyone calls sweep, which tries the hand-off again."
        : "The recipient received nothing.",
    ];
    return {
      kind: "handed-off",
      label: `Handed off on ${context.destination}, the router could not pay the recipient`,
      paragraphs,
      short: facts.handOffRefused
        ? "The router could not pay the recipient, and the failed delivery address refused the hand-off. The tokens stay in the router until anyone calls sweep."
        : "The router could not pay the recipient and handed the amount to its failed delivery address.",
    };
  }
  if (facts.callbackFailed && facts.viaRouter) {
    return {
      kind: "router-callback-failed",
      label: `Tokens reached the router on ${context.destination}, its callback failed`,
      paragraphs: [
        "The tokens reached the router, but its callback failed: the callback gas that the sender gave was too small for the call gas in the sender's terms.",
        "The recipient received nothing.",
        `The tokens wait in the router until anyone calls sweep, which sends them to ${failedAddress}.`,
      ],
      short: "The tokens reached the router, but its callback failed, so the recipient received nothing. They wait in the router until anyone calls sweep, which sends them to the router's failed delivery address.",
    };
  }
  if (facts.callFailed !== null) {
    return {
      kind: "call-failed",
      label: `Delivered on ${context.destination}, the call after it failed`,
      paragraphs: [
        "The recipient received the tokens and keeps them.",
        `The call to ${facts.callFailed.target} that followed failed with the ${facts.callFailed.callGas.toLocaleString("en-US")} gas that the sender gave it. Nothing else changed.`,
      ],
      short: "The recipient received the tokens. The call after the delivery failed with the gas the sender gave it.",
    };
  }
  return null;
};

/** The short name of each outcome, for a tag beside a transfer. */
export const OUTCOME_TAGS: Readonly<Record<DeliveryOutcome["kind"], string>> = {
  "router-callback-failed": "Tokens in the router",
  "handed-off": "Handed off",
  "call-failed": "Call failed",
};
