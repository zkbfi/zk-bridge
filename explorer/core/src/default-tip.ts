import { senderPriceOfToken, type SenderPrice } from "./delivery-fee.js";
import { gasPriceBasisFor, type BaseFeeSupport, type GasPriceBasis } from "./delivery-terms.js";

/**
 * The default tip of the terminal and the web page: the gas based mode at the base fee, with a margin of 100 percent and a
 * limit that is the tip at a ceiling base fee. This module decides which gas price basis and which price the default uses,
 * and what the form tells the user about it, so both interfaces choose and speak alike. The numbers come from
 * `buildFeeSuggestions`, which reads the choice made here.
 */

/** What {@link defaultTipChoiceOf} needs to know. */
export interface DefaultTipChoiceInput {
  /** The sender's own price of one wei of the destination native coin, in base units of the token. Null when none is typed. */
  readonly senderPrice: SenderPrice | null;
  /** The value of one whole token in wei, from the valuation of the token. Null when none is known. */
  readonly tokenValueInWei: bigint | null;
  /** The decimals of the token. */
  readonly tokenDecimals: number;
  /** Whether the destination chain reports a base fee. Default: `reported`. */
  readonly destinationBaseFee?: BaseFeeSupport;
  /** The name of the destination chain, for the words. */
  readonly chainName: string;
}

/** Where the price of the default tip comes from. `missing` means that the default cannot be computed. */
export type DefaultTipPriceSource = "sender" | "valuation" | "missing";

/** The default tip, as far as it can be chosen before any number is computed. */
export interface DefaultTipChoice {
  /** The default mode is always the gas based mode. */
  readonly mode: "gas";
  /** `base-fee-only` where the chain reports a base fee, else `transaction`. */
  readonly gasPrice: GasPriceBasis;
  readonly priceSource: DefaultTipPriceSource;
  /** The price that the multiplier uses, or null when the price is missing. */
  readonly senderPrice: SenderPrice | null;
  /** A sentence for the user when the default departs from the plain base fee mode, or lacks a price. Null otherwise. */
  readonly notice: string | null;
}

/**
 * Chooses the default tip. The mode is gas based. The gas price basis is the base fee, or the whole gas price when the
 * destination chain reports no base fee. The price is the sender's own price when typed, else the one that the valuation of
 * the token gives. With neither, the default cannot be computed: a fixed tip needs the same price to turn a cost into
 * tokens, so there is no fixed fallback, and the notice asks for a price.
 *
 * @param input The prices and the destination chain.
 */
export const defaultTipChoiceOf = (input: DefaultTipChoiceInput): DefaultTipChoice => {
  const gasPrice = gasPriceBasisFor(input.destinationBaseFee);
  const valuationPrice =
    input.tokenValueInWei === null ? null : senderPriceOfToken({ tokenValueInWei: input.tokenValueInWei, tokenDecimals: input.tokenDecimals });
  const senderPrice = input.senderPrice ?? valuationPrice;
  const priceSource: DefaultTipPriceSource = input.senderPrice !== null ? "sender" : valuationPrice !== null ? "valuation" : "missing";
  const notices = [
    gasPrice === "transaction" ? `${input.chainName} reports no base fee, so the tip reads the whole gas price.` : null,
    priceSource === "missing" ? "Enter your price of the native coin in this token. The tip cannot be computed without it. Percentage and fixed amount stay available." : null,
  ].filter((notice): notice is string => notice !== null);
  return { mode: "gas", gasPrice, priceSource, senderPrice, notice: notices.length === 0 ? null : notices.join(" ") };
};
