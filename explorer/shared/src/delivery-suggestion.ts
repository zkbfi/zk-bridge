import type { Address } from "viem";
import type { DeliveryCostReport, DeliveryKind } from "./delivery-cost-report.js";
import {
  deliveryCostBreakdown,
  senderPriceOfToken,
  suggestFixed,
  suggestGasMultiplier,
  suggestPercentage,
  tokenUnitsToWeiFloor,
  type DeliveryCostBreakdown,
  type SenderPrice,
} from "./delivery-fee.js";
import { expectedFee, feeModeOf, gasPriceBasisFor, maximumFee, type BaseFeeSupport, type FeeDirector, type FeeMode, type GasPriceBasis, type PayoutKind } from "./delivery-terms.js";
import { ceilingWeiOf, DEFAULT_GAS_LEVEL } from "./fee-rules.js";
import { formatRate, formatTokenAmount, RATE_SCALE } from "./format.js";

/**
 * What the sender is about to pay, stated so that nobody mistakes an estimate for a promise. The terminal dashboard and
 * the web interface both show these fields, so the labels live here. A fixed or share fee is `exact`. A gas based fee is
 * an `estimate` with a guaranteed maximum.
 */

/** Whether an amount is known to the unit or only estimated. */
export type FeeCertainty = "exact" | "estimate";

/** Where the delivery gas of a suggestion comes from, and how fresh the base fee is. */
export interface FeeDataSource {
  readonly kind: "measured" | "default";
  /** How many recorded deliveries the gas comes from. Zero for a default. */
  readonly sampleCount: number;
  /** The statistic of the samples that the suggestion uses. Null for a default. */
  readonly statistic: "p90" | null;
  /** The delivery gas that the suggestion uses. */
  readonly gas: bigint;
  /** For example `measured from 40 recent deliveries, p90` or `default, no deliveries measured yet`. */
  readonly description: string;
  readonly baseFeeWei: bigint;
  readonly baseFeeBlockNumber: number | null;
  /** The time of the block that gave the base fee, in seconds. */
  readonly baseFeeObservedAt: number | null;
  /** For example `base fee 7 gwei at block 12 (2026-10-25T10:00:00.000Z)`. */
  readonly baseFeeDescription: string;
}

/** One line of the cost breakdown, in wei. */
export interface CostLine {
  readonly id: "gas" | "margin";
  readonly label: string;
  /** Signed: a margin below zero is a shortfall. */
  readonly amountWei: bigint;
  /** Every line is an estimate: it uses the base fee now and the token price. */
  readonly certainty: "estimate";
  readonly note: string;
}

/** The token that the fee is paid in. */
export interface FeeToken {
  readonly symbol: string;
  readonly decimals: number;
  /** The value of one whole token in wei. */
  readonly valueInWei: bigint;
}

/** What the user is told about one director. */
export interface FeeDescription {
  readonly mode: FeeMode;
  readonly certainty: FeeCertainty;
  /** The fee now, in base units. Exact for fixed and share. For a gas based fee it is the estimate. */
  readonly nowUnits: bigint;
  /** The most that the runner can take, in base units. */
  readonly maximumUnits: bigint;
  /** `exact`, or `estimate, at most 2 USDC`. */
  readonly certaintyLabel: string;
  /** `1.5 USDC`, or `about 1.2 USDC now`. */
  readonly amountText: string;
  /** The amount and the label together, for example `1.5 USDC (exact)`. */
  readonly summary: string;
  /** How the router computes it, in words. */
  readonly formula: string;
  readonly breakdown: readonly CostLine[];
}

/** What {@link describeFee} needs besides the director. */
export interface DescribeFeeInput {
  /** The amount that the mediator releases to the router, in base units. */
  readonly transferValue: bigint;
  readonly token: FeeToken;
  readonly payout?: PayoutKind;
  /** The gas that the fee is priced at: the delivery gas of the data source. */
  readonly gasUsed: bigint;
  readonly baseFeeWei: bigint;
  readonly priorityFeeWei: bigint;
  /** The cost of the delivery, for the breakdown. Null leaves the breakdown empty. */
  readonly cost: DeliveryCostBreakdown | null;
}

const withSymbol = (units: bigint, token: FeeToken): string => `${formatTokenAmount(units, token.decimals)} ${token.symbol}`;

const formulaOf = (director: FeeDirector): string => {
  const mode = feeModeOf(director.settings);
  if (mode === "fixed") return "a fixed amount";
  if (mode === "share") return `${formatRate(director.multiplier)} percent of the transfer`;
  return `the gas that the deliverer's transaction makes available times the gas price, at ${formatTokenAmount(director.multiplier, 18)} token units for each wei (your price and margin), never above the limit. Expect the tip to reach the limit`;
};

const breakdownOf = (cost: DeliveryCostBreakdown | null, feeWei: bigint, note: string): readonly CostLine[] => {
  if (cost === null) return [];
  return [
    { id: "gas", label: "Gas cost", amountWei: cost.gasCostWei, certainty: "estimate", note: "the delivery gas at the base fee and priority fee now" },
    { id: "margin", label: "Margin", amountWei: feeWei - cost.totalWei, certainty: "estimate", note },
  ];
};

/**
 * States what a director costs the sender: the amount now, the maximum, whether it is exact, and the breakdown.
 * It uses {@link expectedFee}, which mirrors the router, so a fixed or share amount is exact to the base unit.
 *
 * @param director The fee terms.
 * @param input The transfer, the token, the gas and the prices.
 */
export const describeFee = (director: FeeDirector, input: DescribeFeeInput): FeeDescription => {
  const mode = feeModeOf(director.settings);
  const { fee } = expectedFee(director, {
    value: input.transferValue,
    gasUsed: input.gasUsed,
    baseFeeWei: input.baseFeeWei,
    priorityFeeWei: input.priorityFeeWei,
    payout: input.payout ?? "token",
  });
  const maximum = maximumFee(director, input.transferValue);
  const certainty: FeeCertainty = mode === "gas" ? "estimate" : "exact";
  const nowText = withSymbol(fee, input.token);
  const maximumText = withSymbol(maximum, input.token);
  const certaintyLabel = certainty === "exact" ? "exact" : `estimate, at most ${maximumText}`;
  const amountText = certainty === "exact" ? nowText : `about ${nowText} now`;
  const marginNote = mode === "gas" ? "the estimate less the cost" : "the fee less the cost";
  return {
    mode,
    certainty,
    nowUnits: fee,
    maximumUnits: maximum,
    certaintyLabel,
    amountText,
    summary: `${amountText} (${certaintyLabel})`,
    formula: formulaOf(director),
    breakdown: breakdownOf(input.cost, tokenUnitsToWeiFloor(fee, { tokenValueInWei: input.token.valueInWei, tokenDecimals: input.token.decimals }), marginNote),
  };
};

/**
 * Tells the data behind a suggestion.
 *
 * @param report The report of the destination chain.
 * @param kind The kind of delivery.
 * @throws When the report has no base fee yet.
 */
export const describeDataSource = (report: DeliveryCostReport, kind: DeliveryKind): FeeDataSource => {
  const entry = report.kinds[kind];
  if (report.baseFee.wei === null) throw new RangeError("the indexer has seen no block on the destination chain yet, so there is no base fee");
  const baseFeeWei = BigInt(report.baseFee.wei);
  const measured = !entry.isDefault && entry.p90Gas !== null;
  const gas = measured ? BigInt(entry.p90Gas as string) : BigInt(entry.defaultGas);
  const when = report.baseFee.timestamp === null ? "" : ` (${new Date(report.baseFee.timestamp * 1000).toISOString()})`;
  const block = report.baseFee.blockNumber === null ? "" : ` at block ${report.baseFee.blockNumber}`;
  return {
    kind: measured ? "measured" : "default",
    sampleCount: measured ? entry.sampleCount : 0,
    statistic: measured ? "p90" : null,
    gas,
    description: measured
      ? `measured from ${entry.sampleCount} recent deliveries, p90`
      : "default, no deliveries measured yet",
    baseFeeWei,
    baseFeeBlockNumber: report.baseFee.blockNumber,
    baseFeeObservedAt: report.baseFee.timestamp,
    baseFeeDescription: `base fee ${formatTokenAmount(baseFeeWei, 9)} gwei${block}${when}`,
  };
};

/** One choice of the user: a director with its description, or the reason that none exists. */
export type FeeOption =
  | { readonly kind: "available"; readonly mode: FeeMode; readonly director: FeeDirector; readonly description: FeeDescription }
  | { readonly kind: "unavailable"; readonly mode: FeeMode; readonly reason: string };

/** Input of {@link buildFeeSuggestions}. */
export interface BuildFeeSuggestionsInput {
  readonly recipient: Address;
  /** The amount that the transfer delivers, in base units of the destination token. */
  readonly transferValue: bigint;
  readonly token: FeeToken;
  readonly payout?: PayoutKind;
  readonly report: DeliveryCostReport;
  /** Default: `token_callback`, the delivery through the delivery router. */
  readonly kind?: DeliveryKind;
  /** The priority fee that the runner pays, in wei per gas. */
  readonly priorityFeeWei: bigint;
  /** The profit on top of the cost, scaled by 1e18. Default: 10 percent. */
  readonly marginRate?: bigint;
  /** The factor on the gas cost of the middle of the tip range, scaled by 1e18. Default: {@link DEFAULT_GAS_MARGIN}, 1 (the cost itself). */
  readonly gasMargin?: bigint;
  /**
   * Which gas price the gas based tip reads. Default: `base-fee-only`. Use {@link gasPriceBasisFor} to follow a chain that
   * reports no base fee: there the router reads the whole gas price.
   */
  readonly gasPrice?: GasPriceBasis;
  /**
   * The sender's own price of one wei of the destination native coin, in base units of the token. The gas multiplier mode
   * folds it into the multiplier at send time, so it works for any token. Default: the valuation of the token.
   */
  readonly senderPrice?: SenderPrice;
  /** The base fee above which a gas based fee stops rising. Default: the ceiling of the default gas level (Normal), three times the base fee now. */
  readonly baseFeeCeilingWei?: bigint;
}

/** The suggestions of the form, with the data behind them. */
export interface FeeSuggestions {
  readonly dataSource: FeeDataSource;
  readonly cost: DeliveryCostBreakdown;
  readonly percentage: FeeOption;
  readonly fixed: FeeOption;
  readonly gasMultiplier: FeeOption;
  /** The low, suggested and high tip, or the reason that none can be computed. */
  readonly tipRange: TipRangeOption;
}

/** The low, suggested and high tip of the gas based mode, each with its description. */
export type TipRangeOption =
  | {
      readonly kind: "available";
      readonly low: Extract<FeeOption, { kind: "available" }>;
      readonly default: Extract<FeeOption, { kind: "available" }>;
      readonly high: Extract<FeeOption, { kind: "available" }>;
    }
  | { readonly kind: "unavailable"; readonly reason: string };

const DEFAULT_MARGIN_RATE = RATE_SCALE / 10n;

/** The default factor on the gas cost of the gas based tip: 1, so the tip equals the measured cost, scaled by 1e18. */
export const DEFAULT_GAS_MARGIN = RATE_SCALE;

/**
 * The ends of the suggested tip range, as factors on the measured delivery gas cost at the base fee, scaled by 1e18:
 * one half to one and a half. The range is low on purpose. A user may set any tip from zero up, and any frontend may set
 * its own range.
 */
export const SUGGESTED_TIP_RANGE = { low: RATE_SCALE / 2n, high: (RATE_SCALE * 3n) / 2n } as const;


const attempt = <Value>(build: () => Value): { readonly value: Value } | { readonly reason: string } => {
  try {
    return { value: build() };
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return { reason: error.message };
  }
};

const tryOption = (mode: FeeMode, build: () => FeeDirector, describe: (director: FeeDirector) => FeeDescription): FeeOption => {
  const result = attempt(build);
  if ("reason" in result) return { kind: "unavailable", mode, reason: result.reason };
  return { kind: "available", mode, director: result.value, description: describe(result.value) };
};

const gasTipOf = (input: BuildFeeSuggestionsInput, dataSource: FeeDataSource, margin: bigint): FeeDirector => {
  const price = { tokenValueInWei: input.token.valueInWei, tokenDecimals: input.token.decimals };
  return suggestGasMultiplier({
    recipient: input.recipient,
    senderPrice: input.senderPrice ?? senderPriceOfToken(price),
    margin,
    baseFeeCeilingWei: input.baseFeeCeilingWei ?? ceilingWeiOf(dataSource.baseFeeWei, DEFAULT_GAS_LEVEL),
    priorityFeeCeilingWei: input.priorityFeeWei,
    deliveryGas: dataSource.gas,
    gasPrice: input.gasPrice ?? "base-fee-only",
    ...(input.payout === undefined ? {} : { payout: input.payout }),
  });
};

/**
 * The suggested tip range of the gas based mode: a low, a suggested and a high tip. The suggested tip is the measured
 * delivery gas cost at the base fee, times the margin (default {@link DEFAULT_GAS_MARGIN}, 1). The low and high tips are
 * half and one and a half times that cost ({@link SUGGESTED_TIP_RANGE}). The range holds no share of the cost of proving,
 * because a tip does not pay for proving. A tip below the cost is fine: the user may set any tip from zero up, and a low
 * tip never makes a delivery fail.
 *
 * @param input The transfer, the token, the report and the prices.
 * @throws When the report has no base fee yet, or the price of the token is not above zero.
 */
export const suggestedTipRange = (input: BuildFeeSuggestionsInput): { low: FeeDirector; default: FeeDirector; high: FeeDirector } => {
  const dataSource = describeDataSource(input.report, input.kind ?? "token_callback");
  return {
    low: gasTipOf(input, dataSource, SUGGESTED_TIP_RANGE.low),
    default: gasTipOf(input, dataSource, input.gasMargin ?? DEFAULT_GAS_MARGIN),
    high: gasTipOf(input, dataSource, SUGGESTED_TIP_RANGE.high),
  };
};

/** How a tip stands against the cost of the delivery. */
export type TipPosition = "below-cost" | "covers-cost" | "above-cost";

/** A tip set against the cost, with words for the user. */
export interface TipVersusCost {
  readonly position: TipPosition;
  /** The wei by which the tip falls short of the cost. Zero when the tip covers the cost. */
  readonly shortfallWei: bigint;
  /** A plain sentence for the user. */
  readonly words: string;
}

/**
 * Sets a tip against the cost of a delivery. A tip of zero is allowed and reads as below cost. The words say that a
 * low tip never makes a delivery fail. They promise nothing in return for a larger tip. This function is pure, so the two
 * line graphs of the dapp (the delivery cost and the tip against the base fee) call it at each base fee to find where the
 * tip stops covering the cost.
 *
 * @param input The tip and the cost, both in wei of the destination native coin.
 */
export const tipVersusCost = (input: { readonly tipWei: bigint; readonly costWei: bigint }): TipVersusCost => {
  if (input.tipWei < 0n || input.costWei < 0n) throw new RangeError("the tip and the cost must not be negative");
  if (input.tipWei < input.costWei) {
    return {
      position: "below-cost",
      shortfallWei: input.costWei - input.tipWei,
      words: "This tip is below the cost of the delivery. The delivery still works. Whoever delivers it pays the difference and may choose to wait for a higher tip elsewhere.",
    };
  }
  if (input.tipWei === input.costWei) return { position: "covers-cost", shortfallWei: 0n, words: "This tip equals the cost of the delivery." };
  return { position: "above-cost", shortfallWei: 0n, words: "This tip is above the cost of the delivery." };
};

const tryTipRange = (build: () => { low: FeeDirector; default: FeeDirector; high: FeeDirector }, describe: (director: FeeDirector) => FeeDescription): TipRangeOption => {
  const result = attempt(build);
  if ("reason" in result) return { kind: "unavailable", reason: result.reason };
  const optionOf = (director: FeeDirector) => ({ kind: "available", mode: "gas", director, description: describe(director) }) as const;
  return { kind: "available", low: optionOf(result.value.low), default: optionOf(result.value.default), high: optionOf(result.value.high) };
};

/**
 * Builds the suggestions of the "Pay for delivery" form from the report of the indexer. The percentage and the fixed fee
 * cover the gas cost plus a margin, and are exact. The gas multiplier is the middle of the tip range: the measured gas
 * cost at the base fee. It follows the base fee up to the ceiling, and is an estimate with a maximum. The router measures
 * the gas that the deliverer's transaction makes available, and the deliverer chooses the gas limit of that transaction, so
 * the sender should expect a gas based tip to reach the limit: the limit is the price ceiling. It works for any token: the
 * sender's price of the native coin is folded into the multiplier. When the indexer records more deliveries, the gas
 * figure and the suggestions follow with no code change.
 *
 * @param input The transfer, the token, the report and the prices.
 * @throws When the report has no base fee yet.
 */
export const buildFeeSuggestions = (input: BuildFeeSuggestionsInput): FeeSuggestions => {
  const dataSource = describeDataSource(input.report, input.kind ?? "token_callback");
  const cost = deliveryCostBreakdown({
    deliveryGas: dataSource.gas,
    baseFeeWei: dataSource.baseFeeWei,
    priorityFeeWei: input.priorityFeeWei,
  });
  const price = { tokenValueInWei: input.token.valueInWei, tokenDecimals: input.token.decimals };
  const shared = { recipient: input.recipient, transferValue: input.transferValue, ...price, ...(input.payout === undefined ? {} : { payout: input.payout }) };
  const marginRate = input.marginRate ?? DEFAULT_MARGIN_RATE;
  const describe = (director: FeeDirector): FeeDescription =>
    describeFee(director, {
      transferValue: input.transferValue,
      token: input.token,
      payout: input.payout ?? "token",
      gasUsed: dataSource.gas,
      baseFeeWei: dataSource.baseFeeWei,
      priorityFeeWei: input.priorityFeeWei,
      cost,
    });
  const gasMultiplier = tryOption("gas", () => gasTipOf(input, dataSource, input.gasMargin ?? DEFAULT_GAS_MARGIN), describe);
  const tipRange = tryTipRange(() => suggestedTipRange(input), describe);
  return {
    dataSource,
    cost,
    percentage: tryOption("share", () => suggestPercentage({ ...shared, costWei: cost.totalWei, marginRate }), describe),
    fixed: tryOption("fixed", () => suggestFixed({ ...shared, costWei: cost.totalWei, marginRate }), describe),
    gasMultiplier,
    tipRange,
  };
};

// The gas price basis rule lives in core (`gasPriceBasisFor`); this file keeps its old path for it.
export { gasPriceBasisFor };
