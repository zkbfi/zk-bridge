/**
 * The draft of the bridge form: everything that the form can say about the transfer before the user presses "Review".
 * It is one pure function of the form values and the live data, so each rule has a unit test. The form never plans a
 * transaction in any other place.
 *
 * The tip for delivery is on by default. A transfer that cannot carry a tip (the wrap route, or a destination with no
 * delivery router) is a plain relay, and the draft says why, as the terminal does.
 */
import { formatUnits, getAddress, type Address } from "viem";
import { DEFAULT_GAS_MARGIN, defaultTipChoiceOf, UINT256_MAXIMUM, type DeliveryCostReport, type PayoutKind, type SenderPrice } from "@zk-bridge/shared";
import { bridgeSourceOf, type BridgeContext } from "@terminal/app/actions";
import { DEFAULT_TIP_PERCENT_TEXT, resolveDeliveryTarget, senderPriceText, type DeliveryTarget } from "@terminal/app/delivery-fee-form";
import type { ChainSide, PairConfig, TokenInfo } from "@terminal/model/types";
import { AmountParseError, parsePercentAsRate, parseUnits } from "@terminal/format/amounts";
import { PlanInputError } from "@terminal/tx/plan";
import { planBridgeSteps, type BridgeFormValues, type WebStep } from "./bridge-steps";
import { selectDelivery, type DeliveryMode, type DeliverySelection } from "./delivery-selection";

/** What the user chose for the tip: one of the three modes, or no tip. */
export type TipChoice = DeliveryMode | "none";

/** What the user typed for the tip. Every text is as typed. */
export type DeliveryOptions = {
  readonly mode: TipChoice;
  /** The share of the transfer in percent, for the percentage mode. */
  readonly percentText: string;
  /** The amount in whole tokens, for the fixed mode. Empty takes the suggestion. */
  readonly fixedText: string;
  /** The margin in percent that the fixed suggestion adds. */
  readonly marginPercentText: string;
  /** The factor on the gas cost for the gas based mode, as typed (`1`, the measured cost itself). */
  readonly gasMultiplierText: string;
  /** The ceiling base fee in gwei, as typed. Empty takes twice the base fee now. */
  readonly ceilingGweiText: string;
  /**
   * The sender's price: how many whole tokens one whole native coin of the destination chain is worth. Null means the
   * user has not typed one, so the field shows the default of the token valuation.
   */
  readonly senderPriceText: string | null;
  /**
   * The router of the relay. Null means the user has not typed one, so the field shows the default delivery router
   * on the destination chain. An empty text also takes that router.
   */
  readonly routerText: string | null;
  /** True when the user wants the native coin paid out (only for the wrapped native token). */
  readonly payoutNative: boolean;
};

/** The live data that a draft reads. */
export type DraftData = {
  readonly pair: PairConfig;
  readonly tokens: readonly TokenInfo[];
  readonly context: BridgeContext;
  /** The delivery cost report of the destination chain, or null while it loads or when it failed. */
  readonly report: DeliveryCostReport | null;
  /** The priority fee of the destination chain in wei per gas, or null while it loads. */
  readonly priorityFeeWei: bigint | null;
};

/**
 * Whether the relay carries a tip. `on`: it does. `off`: the user chose No tip. `unavailable`: the transfer cannot carry
 * one, the reason says why, and the page sends a plain relay.
 */
export type TipStatus =
  | { readonly kind: "on"; readonly target: DeliveryTarget }
  | { readonly kind: "off"; readonly target: DeliveryTarget }
  | { readonly kind: "unavailable"; readonly reason: string };

/** The draft. */
export type BridgeDraft = {
  /** `ready`: the steps can go to the review. `incomplete`: the form lacks input. `blocked`: the input cannot work. */
  readonly status: "ready" | "incomplete" | "blocked";
  /** A sentence that says what to do or what is wrong. Null when ready. */
  readonly reason: string | null;
  readonly steps: readonly WebStep[];
  readonly amountToken: { readonly symbol: string; readonly decimals: number } | null;
  /** The tip, when the user chose one and it can be built. */
  readonly delivery: DeliverySelection | null;
  /** Why the tip cannot be shown, or null. */
  readonly deliveryProblem: string | null;
  /** Whether the relay carries a tip. Null while no token is chosen. */
  readonly tip: TipStatus | null;
  /** The default text of the price field, from the valuation of the token. Empty when none is known. */
  readonly defaultSenderPriceText: string;
  /**
   * What the form tells the user about the default gas based tip: the destination chain has no base fee, or no price is
   * known. Null when there is nothing to say, when the tip is off, or when another mode is chosen.
   */
  readonly tipNotice: string | null;
};

const EMPTY_DRAFT: BridgeDraft = { status: "incomplete", reason: null, steps: [], amountToken: null, delivery: null, deliveryProblem: null, tip: null, defaultSenderPriceText: "", tipNotice: null };

/** The default share for the percentage mode, in percent. It is the default of `defaultTip` in `@zk-bridge/shared`: 0.1 percent. */
export const DEFAULT_TIP_PERCENT = DEFAULT_TIP_PERCENT_TEXT;

/** The words that end every reason why no tip travels. */
const PLAIN_RELAY_SENTENCE = "The page sends a plain relay, with no tip.";

const WEI_PER_COIN = 10n ** 18n;

const sideOfChoice = (choice: string): ChainSide => (choice.startsWith("second:") ? "second" : "first");

/** Runs a parser of user text. Text that is not a number gives null. Any other failure is a defect and propagates. */
const orNull = (parse: () => bigint): bigint | null => {
  try {
    return parse();
  } catch (error) {
    if (error instanceof AmountParseError) return null;
    throw error;
  }
};

const parseDecimalText = (text: string, decimals: number): bigint | null => orNull(() => parseUnits(text, decimals));

const parsePercentText = (text: string): bigint | null => orNull(() => parsePercentAsRate(text));

/** Input of {@link tipStatusOf}. */
export type TipStatusInput = {
  readonly values: BridgeFormValues;
  readonly options: DeliveryOptions;
  readonly pair: PairConfig;
  readonly tokens: readonly TokenInfo[];
  readonly valuations: Readonly<Record<string, bigint>>;
};

/**
 * Tells whether the relay carries a tip. The wrap route and a destination with no delivery router cannot carry one. Otherwise
 * the tip is on unless the user chose No tip.
 *
 * @param input The form values, the options, the pair and the token valuations.
 */
export const tipStatusOf = (input: TipStatusInput): TipStatus => {
  const source = bridgeSourceOf(input.values, input.tokens, input.pair);
  if (source.kind === "native") return { kind: "unavailable", reason: `The wrap route carries no call data, so it cannot carry a tip. ${PLAIN_RELAY_SENTENCE}` };
  const resolved = resolveDeliveryTarget({ source, pair: input.pair, tokens: input.tokens, valuations: input.valuations });
  if (resolved.kind === "unavailable") return { kind: "unavailable", reason: `${resolved.reason} ${PLAIN_RELAY_SENTENCE}` };
  return { kind: input.options.mode === "none" ? "off" : "on", target: resolved.target };
};

/** The notice of the default tip, from the shared choice. Only the gas based mode of a tip that is on has one. */
const tipNoticeOf = (options: DeliveryOptions, tip: TipStatus, defaultPriceText: string): string | null => {
  if (tip.kind !== "on" || options.mode !== "gas-multiplier") return null;
  const price = priceOf(options.senderPriceText ?? defaultPriceText, tip.target.token.decimals);
  if (!price.ok) return null;
  return defaultTipChoiceOf({
    senderPrice: price.value.senderPrice,
    tokenValueInWei: price.value.tokenValueInWei,
    tokenDecimals: tip.target.token.decimals,
    chainName: tip.target.chain.name,
    ...(tip.target.chain.baseFee === undefined ? {} : { destinationBaseFee: tip.target.chain.baseFee }),
  }).notice;
};

type TipInputs = {
  readonly router: Address;
  readonly percentageRate: bigint;
  readonly fixedAmount: bigint | null;
  readonly marginRate: bigint;
  readonly gasMargin: bigint;
  readonly baseFeeCeilingWei: bigint | null;
  readonly senderPrice: SenderPrice | null;
  readonly tokenValueInWei: bigint | null;
};

type Parsed<Value> = { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly problem: string };

const failure = (problem: string): { readonly ok: false; readonly problem: string } => ({ ok: false, problem });

/** The price of the sender as the shared functions want it, and the value of one whole token in wei that it implies. */
const priceOf = (text: string, decimals: number): Parsed<{ senderPrice: SenderPrice | null; tokenValueInWei: bigint | null }> => {
  if (text.trim() === "") return { ok: true, value: { senderPrice: null, tokenValueInWei: null } };
  const units = parseDecimalText(text, decimals);
  const tokenValueInWei = units === null || units <= 0n ? 0n : (WEI_PER_COIN * 10n ** BigInt(decimals)) / units;
  if (units === null || units <= 0n || tokenValueInWei <= 0n) return failure("Your coin price must be a number above zero, such as 3000.");
  return { ok: true, value: { senderPrice: { numerator: units, denominator: WEI_PER_COIN }, tokenValueInWei } };
};

const routerOf = (options: DeliveryOptions, target: DeliveryTarget): Parsed<Address> => {
  const text = (options.routerText ?? "").trim();
  if (text === "") return { ok: true, value: target.router };
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) return failure("The router must be an address that starts with 0x and has 40 hexadecimal digits.");
  return { ok: true, value: getAddress(text) };
};

const readTipInputs = (options: DeliveryOptions, target: DeliveryTarget, defaultPriceText: string): Parsed<TipInputs> => {
  const router = routerOf(options, target);
  if (!router.ok) return router;
  const percentageRate = parsePercentText(options.percentText.trim() === "" ? DEFAULT_TIP_PERCENT : options.percentText);
  if (percentageRate === null) return failure("The percentage must be a number such as 0.1.");
  const margin = parsePercentText(options.marginPercentText);
  if (margin === null) return failure("The margin must be a percentage such as 10.");
  const gasMargin = parseDecimalText(options.gasMultiplierText, 18);
  if (gasMargin === null || gasMargin <= 0n) return failure("The gas multiplier must be a number above zero, such as 2.");
  const ceilingText = options.ceilingGweiText.trim();
  const baseFeeCeilingWei = ceilingText === "" ? null : parseDecimalText(ceilingText, 9);
  if (ceilingText !== "" && baseFeeCeilingWei === null) return failure("The ceiling must be a number of gwei.");
  const fixedText = options.fixedText.trim();
  const fixedAmount = fixedText === "" ? null : parseDecimalText(fixedText, target.token.decimals);
  if (fixedText !== "" && fixedAmount === null) return failure(`The fixed amount must be a number with at most ${target.token.decimals} fraction digits.`);
  if (fixedAmount !== null && fixedAmount > UINT256_MAXIMUM) return failure("The fixed amount is too large: it must fit in 256 bits.");
  const price = priceOf(options.senderPriceText ?? defaultPriceText, target.token.decimals);
  if (!price.ok) return price;
  return { ok: true, value: { router: router.value, percentageRate, fixedAmount, marginRate: margin, gasMargin, baseFeeCeilingWei, ...price.value } };
};

const buildDelivery = (input: {
  readonly values: BridgeFormValues;
  readonly options: DeliveryOptions;
  readonly data: DraftData;
  readonly amount: bigint;
  readonly target: DeliveryTarget;
  readonly mode: DeliveryMode;
  readonly defaultPriceText: string;
}): { delivery: DeliverySelection | null; problem: string | null } => {
  const { values, options, data, amount, target, mode, defaultPriceText } = input;
  if (data.report === null) return { delivery: null, problem: "The delivery cost has not loaded from the indexer yet. Wait for it, or choose No tip." };
  if (data.priorityFeeWei === null) return { delivery: null, problem: "The priority fee of the destination chain has not loaded yet." };
  const receiver = values.receiver.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(receiver)) return { delivery: null, problem: "Enter the receiver first." };
  const inputs = readTipInputs(options, target, defaultPriceText);
  if (!inputs.ok) return { delivery: null, problem: inputs.problem };
  const payout: PayoutKind = target.isWrappedNative && options.payoutNative ? "native" : "token";
  const selection = selectDelivery(
    {
      mode,
      recipient: receiver as Address,
      // The mediator takes no fee, so the router receives the whole amount.
      transferValue: amount,
      transferValueAtMost: amount,
      token: target.token,
      tokenValueInWei: inputs.value.tokenValueInWei,
      senderPrice: inputs.value.senderPrice,
      payout,
      destinationName: target.chain.name,
      ...(target.chain.baseFee === undefined ? {} : { destinationBaseFee: target.chain.baseFee }),
      report: data.report,
      priorityFeeWei: data.priorityFeeWei,
      percentageRate: inputs.value.percentageRate,
      fixedAmount: inputs.value.fixedAmount,
      marginRate: inputs.value.marginRate,
      gasMargin: inputs.value.gasMargin,
      baseFeeCeilingWei: inputs.value.baseFeeCeilingWei,
    },
    { router: inputs.value.router, defaultRouter: target.router },
  );
  return selection.kind === "available" ? { delivery: selection, problem: null } : { delivery: null, problem: selection.reason };
};

const hasSnapshot = (data: DraftData, side: ChainSide): boolean =>
  (data.context.snapshots ?? []).some((result) => result.status === "ok" && result.snapshot.chain.side === side);

/**
 * Computes the draft.
 *
 * @param values The form values.
 * @param options The tip choices.
 * @param data The live data.
 */
export const computeBridgeDraft = (values: BridgeFormValues, options: DeliveryOptions, data: DraftData): BridgeDraft => {
  if (values.token === "") return { ...EMPTY_DRAFT, reason: "Choose a token." };
  const side = sideOfChoice(values.token);
  const isNative = values.token.endsWith(":native");
  const token = isNative ? null : data.tokens.find((candidate) => `${candidate.side}:${candidate.address}`.toLowerCase() === values.token.toLowerCase());
  if (!isNative && token === undefined) return { ...EMPTY_DRAFT, reason: "Choose a token." };
  const decimals = token === null || token === undefined ? 18 : token.decimals;
  const sourceChain = side === "first" ? data.pair.first : data.pair.second;
  const amountToken = token === null || token === undefined ? { symbol: `wrapped ${sourceChain.nativeSymbol}`, decimals: 18 } : { symbol: token.symbol, decimals: token.decimals };
  const tip = tipStatusOf({ values, options, pair: data.pair, tokens: data.tokens, valuations: data.context.tokenValuationsWei ?? {} });
  const defaultSenderPriceText = tip.kind === "unavailable" ? "" : senderPriceText(tip.target);
  const early = { ...EMPTY_DRAFT, amountToken, tip, defaultSenderPriceText, tipNotice: tipNoticeOf(options, tip, defaultSenderPriceText) };
  if (values.amount.trim() === "") return { ...early, reason: "Enter an amount." };
  const amount = parseDecimalText(values.amount, decimals);
  if (amount === null) return { ...early, status: "blocked", reason: `The amount must be a plain number with at most ${decimals} fraction digits.` };
  if (amount <= 0n) return { ...early, status: "blocked", reason: "The amount must be above zero." };
  if (!hasSnapshot(data, side)) {
    return { ...early, reason: "The balances of the source chain are loading. Check the RPC URLs if this stays." };
  }
  if (values.receiver.trim() === "") return { ...early, reason: "Enter the receiver." };
  const built =
    tip.kind === "on" && options.mode !== "none"
      ? buildDelivery({ values, options, data, amount, target: tip.target, mode: options.mode, defaultPriceText: defaultSenderPriceText })
      : { delivery: null, problem: null };
  if (tip.kind === "on" && built.delivery === null) {
    return { ...early, deliveryProblem: built.problem, status: "blocked", reason: built.problem };
  }
  try {
    const steps = planBridgeSteps({ values, tokens: data.tokens, context: data.context, delivery: built.delivery });
    return { ...early, status: "ready", reason: null, steps, delivery: built.delivery };
  } catch (error) {
    if (!(error instanceof PlanInputError)) throw error;
    return { ...early, status: "blocked", reason: error.message, delivery: built.delivery };
  }
};

/** The default factor on the gas cost, as text: `1`, the measured cost itself. It comes from `@zk-bridge/shared`. */
export const DEFAULT_GAS_MARGIN_TEXT = formatUnits(DEFAULT_GAS_MARGIN, 18);

/**
 * The tip options before the user touches them: the gas based tip at the base fee, equal to the measured cost. Its
 * limit is the price ceiling, twice the base fee now, and the deliverer's gas choice decides how much of it the tip takes.
 */
export const DEFAULT_DELIVERY_OPTIONS: DeliveryOptions = {
  mode: "gas-multiplier",
  percentText: DEFAULT_TIP_PERCENT,
  fixedText: "",
  marginPercentText: "10",
  gasMultiplierText: DEFAULT_GAS_MARGIN_TEXT,
  ceilingGweiText: "",
  senderPriceText: null,
  routerText: null,
  payoutNative: false,
};
