/**
 * The tip for delivery. It turns the form inputs and the indexer report into one fee director, with every label that
 * the page shows: exact or estimate, the guaranteed maximum, the cost lines and the data source. The arithmetic lives in
 * `@zk-bridge/shared` (`buildFeeSuggestions`, `describeFee`); this file only picks the mode and adds the maximum that
 * the tip can take from the amount that is still in the transfer.
 */
import type { Address } from "viem";
import {
  buildFeeSuggestions,
  defaultTip,
  describeFee,
  maximumFee,
  RATE_SCALE,
  settingsOf,
  type DeliveryCostReport,
  type FeeDescription,
  type FeeDirector,
  type FeeSuggestions,
  type FeeToken,
  type PayoutKind,
  type SenderPrice,
} from "@zk-bridge/shared";

/** The ways that the page offers to tip. */
export type DeliveryMode = "percentage" | "fixed" | "gas-multiplier";

/** Input of {@link selectDelivery}. */
export type DeliverySelectionInput = {
  readonly mode: DeliveryMode;
  /** Who receives the tokens after the tip. */
  readonly recipient: Address;
  /** What the delivery router receives at the rates of now: the amount less both bridge fees. */
  readonly transferValue: bigint;
  /** What the delivery router receives at most: the amount less the source fee. Used for the maximum. */
  readonly transferValueAtMost: bigint;
  /** The token that the tip is paid in. */
  readonly token: { readonly symbol: string; readonly decimals: number };
  /** The value of one whole token in wei, from the price of the sender. Null when no price is known. */
  readonly tokenValueInWei: bigint | null;
  /** The sender's price of one wei of the destination native coin, in base units of the token. Null when none is known. */
  readonly senderPrice: SenderPrice | null;
  readonly payout: PayoutKind;
  readonly report: DeliveryCostReport;
  /** The priority fee that the deliverer pays, in wei per gas. */
  readonly priorityFeeWei: bigint;
  /** The share of the transfer for the percentage mode, scaled by 1e18. */
  readonly percentageRate: bigint;
  /** The amount for the fixed mode, in base units of the token. Null takes the suggestion, which needs a price. */
  readonly fixedAmount: bigint | null;
  /** The profit on top of the cost that the fixed suggestion adds, scaled by 1e18. */
  readonly marginRate: bigint;
  /** The factor on the gas cost, scaled by 1e18. Only the gas multiplier mode reads it. */
  readonly gasMargin: bigint;
  /** The base fee above which a gas based tip stops rising, in wei per gas. Null takes twice the base fee now. */
  readonly baseFeeCeilingWei: bigint | null;
};

/** The router of a selection: where the relay goes, and the router of the deployment. */
export type DeliveryRouters = { readonly router: Address; readonly defaultRouter: Address };

/** A tip that the form can send. */
export type DeliverySelection = DeliveryRouters & {
  readonly kind: "available";
  readonly mode: DeliveryMode;
  readonly director: FeeDirector;
  readonly description: FeeDescription;
  readonly suggestions: FeeSuggestions;
  /** The most that the tip can take, in base units of the token. For a gas based tip it is the limit. */
  readonly maximumTip: bigint;
  readonly token: FeeToken;
  readonly baseFeeCeilingWei: bigint | null;
};

/** The choice cannot be built. The reason is a sentence for the user. */
export type DeliveryUnavailable = { readonly kind: "unavailable"; readonly reason: string };

/** The default margin: ten percent. Only the fixed suggestion uses it. */
export const DEFAULT_MARGIN_RATE = RATE_SCALE / 10n;

/** The default gas multiplier: 1.2. */
export const DEFAULT_GAS_MULTIPLIER = (RATE_SCALE * 12n) / 10n;

const needsPrice = (symbol: string): DeliveryUnavailable => ({
  kind: "unavailable",
  reason: `Enter your coin price: how many ${symbol} one native coin of the destination chain is worth.`,
});

const isUnavailable = (value: FeeDirector | DeliveryUnavailable): value is DeliveryUnavailable => "kind" in value;

const directorOf = (input: DeliverySelectionInput, suggestions: FeeSuggestions): FeeDirector | DeliveryUnavailable => {
  if (input.mode === "percentage") {
    if (input.percentageRate > RATE_SCALE) return { kind: "unavailable", reason: "The percentage is above 100 percent." };
    return { ...defaultTip(input.recipient, input.payout), multiplier: input.percentageRate };
  }
  if (input.mode === "fixed" && input.fixedAmount !== null) {
    return { recipient: input.recipient, settings: settingsOf({ mode: "fixed", payout: input.payout }), limit: input.fixedAmount, multiplier: 0n };
  }
  const option = input.mode === "fixed" ? suggestions.fixed : suggestions.gasMultiplier;
  return option.kind === "available" ? option.director : { kind: "unavailable", reason: option.reason };
};

/**
 * Builds the fee director for the chosen mode. The percentage mode needs no price: it is a share of the transfer. The
 * fixed suggestion and the gas multiplier need the price of the sender.
 *
 * @param input The transfer, the token, the report and the prices.
 * @param routers The router of the relay and the router of the deployment. The selection carries them to the dialog.
 */
export const selectDelivery = (input: DeliverySelectionInput, routers: DeliveryRouters): DeliverySelection | DeliveryUnavailable => {
  if (input.report.baseFee.wei === null) return { kind: "unavailable", reason: "The indexer has seen no block on the destination chain yet, so there is no base fee." };
  const needsSuggestionPrice = input.mode === "gas-multiplier" || (input.mode === "fixed" && input.fixedAmount === null);
  if (needsSuggestionPrice && input.tokenValueInWei === null) return needsPrice(input.token.symbol);
  const token: FeeToken = { ...input.token, valueInWei: input.tokenValueInWei ?? 1n };
  try {
    const suggestions = buildFeeSuggestions({
      recipient: input.recipient,
      transferValue: input.transferValue,
      token,
      payout: input.payout,
      report: input.report,
      priorityFeeWei: input.priorityFeeWei,
      marginRate: input.marginRate,
      gasMargin: input.gasMargin,
      ...(input.senderPrice === null ? {} : { senderPrice: input.senderPrice }),
      ...(input.baseFeeCeilingWei === null ? {} : { baseFeeCeilingWei: input.baseFeeCeilingWei }),
    });
    const director = directorOf(input, suggestions);
    if (isUnavailable(director)) return director;
    const description = describeFee(director, {
      transferValue: input.transferValue,
      token,
      payout: input.payout,
      gasUsed: suggestions.dataSource.gas,
      baseFeeWei: suggestions.dataSource.baseFeeWei,
      priorityFeeWei: input.priorityFeeWei,
      cost: input.tokenValueInWei === null ? null : suggestions.cost,
    });
    return {
      kind: "available",
      mode: input.mode,
      director,
      description,
      suggestions,
      maximumTip: maximumFee(director, input.transferValueAtMost),
      token,
      baseFeeCeilingWei: input.baseFeeCeilingWei,
      ...routers,
    };
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return { kind: "unavailable", reason: error.message };
  }
};
