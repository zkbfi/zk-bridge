/**
 * The logic of the "Pay for delivery" part of the bridge form, with no rendering. A sender who pays for delivery
 * relays tokens to the fee router of the other chain. The call data names the fee terms (a `FeeDirector`), and a runner
 * that delivers the transfer through the router takes the fee from the tokens.
 *
 * Every function here is pure. It reads the form values and the delivery cost report and returns plain data. The
 * amounts and the labels (`exact`, `estimate, at most X`) come from `@zk-bridge/shared`, so the terminal and the web
 * interface say the same thing.
 */
import {
  DEFAULT_TIP_PERCENTAGE_MULTIPLIER,
  FEE_SETTING,
  buildFeeSuggestions,
  defaultTip,
  describeFee,
  feeModeOf,
  type DeliveryCostBreakdown,
  type DeliveryCostReport,
  type FeeDataSource,
  type FeeDescription,
  type FeeDirector,
  type FeeOption,
  type FeeSuggestions,
  type FeeToken,
  type GasPriceBasis,
  type PayoutKind,
  type SenderPrice,
  UINT256_MAXIMUM,
} from '@zk-bridge/shared'
import type { Address } from 'viem'
import { AmountParseError, RATE_SCALE, formatUnits, parsePercentAsRate, parseUnits } from '../format/amounts'
import type { ChainConfig, PairConfig, TokenInfo } from '../model/types'
import { PlanInputError, parseAddress } from '../tx/plan'
import type { BridgeSource } from './actions'

/** The names of the form fields of the delivery fee. */
export const DELIVERY_FIELD = {
  delivery: 'delivery',
  mode: 'feeMode',
  percent: 'feePercent',
  fixed: 'feeFixed',
  multiplier: 'feeMultiplier',
  ceiling: 'feeCeilingGwei',
  margin: 'feeMargin',
  priority: 'feePriorityGwei',
  payout: 'feePayout',
  recipient: 'feeRecipient',
  customKind: 'feeCustomKind',
  customLimit: 'feeCustomLimit',
  customMultiplier: 'feeCustomMultiplier',
  customBasis: 'feeCustomBasis',
  router: 'feeRouter',
  senderPrice: 'feeSenderPrice',
} as const

/** How the fee is chosen: a percentage, a fixed amount, a gas multiplier with the sender's price, or raw terms. */
export type FeeFormMode = 'percentage' | 'fixed' | 'gas' | 'custom'

/** The default tip, in percent: 0.1 percent of the transfer. The sender fixes it ahead of time. Same as `defaultTip`. */
export const DEFAULT_TIP_PERCENT_TEXT = formatUnits(DEFAULT_TIP_PERCENTAGE_MULTIPLIER, 16)

/** The default margin on top of the cost, in percent. Same as the suggestion of `@zk-bridge/shared`. */
export const DEFAULT_MARGIN_PERCENT = '10'
/** The default priority fee that the runner is assumed to pay, in gwei. The user edits it. */
export const DEFAULT_PRIORITY_GWEI = '1'
/** The margin on the gas cost that a blank field of the gas multiplier mode means. Same as the suggestion of `@zk-bridge/shared`. */
export const DEFAULT_GAS_MULTIPLIER_TEXT = '1.2'

/** The value of one whole native coin of the chain, in wei. */
const WEI_PER_WHOLE_COIN = 10n ** 18n

/** The form values by field name. */
export type Values = Readonly<Record<string, string>>

/** The value of one whole token in wei, by lowercase token address. The user supplies it for tokens that are not the wrapped native token. */
export type TokenValuationsWei = Readonly<Record<string, bigint>>

/** Where the fee is paid and in what: the destination chain, its fee router and the token that the router pays out. */
export interface DeliveryTarget {
  readonly chain: ChainConfig
  /** The fee router of the deployment on the destination chain: the default router. The extra data may name another. */
  readonly router: Address
  /** The token that the router pays out: the token on the destination chain. */
  readonly token: { readonly symbol: string; readonly decimals: number }
  /** True when the token is the wrapped native token of the destination chain, so the fee may be paid in the native coin. */
  readonly isWrappedNative: boolean
  /** The value of one whole token in wei, or null when no price is known. */
  readonly valueInWei: bigint | null
}

/** The destination, or the reason that delivery fees are not offered. */
export type DeliveryTargetResult =
  | { readonly kind: 'ready'; readonly target: DeliveryTarget }
  | { readonly kind: 'unavailable'; readonly reason: string }

/** Input of {@link resolveDeliveryTarget}. */
export interface ResolveTargetInput {
  readonly source: BridgeSource
  readonly pair: PairConfig
  /** Every known token, to find the token on the destination chain. */
  readonly tokens: readonly TokenInfo[]
  readonly valuations: TokenValuationsWei
}

/**
 * Finds the fee router and the payout token for the chosen source. Delivery fees need a token transfer with call data
 * and a fee router in the deployment. When one is missing, this says so and the form offers no fee.
 *
 * @param input The source of the transfer, the pair and the known prices.
 */
export function resolveDeliveryTarget(input: ResolveTargetInput): DeliveryTargetResult {
  const { source, pair } = input
  if (source.kind === 'none') return { kind: 'unavailable', reason: 'Choose a token first.' }
  if (source.kind === 'native') {
    return { kind: 'unavailable', reason: 'The wrap and relay route carries no call data, so it cannot pay for delivery. Choose a token.' }
  }
  const chain = source.side === 'first' ? pair.second : pair.first
  if (chain.contracts.feeRouter === null) {
    return { kind: 'unavailable', reason: `The deployment names no fee router for ${chain.name}, so a delivery fee is not offered.` }
  }
  const counterpart = source.token.counterpart
  const known = counterpart === null ? undefined : input.tokens.find((candidate) => candidate.side !== source.side && candidate.address.toLowerCase() === counterpart.toLowerCase())
  // A bridged copy has the decimals of its home token. When the copy is not listed yet, the source token tells the decimals.
  const token = { symbol: known?.symbol ?? source.token.symbol, decimals: known?.decimals ?? source.token.decimals }
  const wrappedNative = chain.contracts.wrappedNative
  const isWrappedNative = counterpart !== null && wrappedNative !== null && wrappedNative.toLowerCase() === counterpart.toLowerCase()
  const valueInWei = isWrappedNative ? WEI_PER_WHOLE_COIN : counterpart === null ? null : (input.valuations[counterpart.toLowerCase()] ?? null)
  return { kind: 'ready', target: { chain, router: chain.contracts.feeRouter, token, isWrappedNative, valueInWei } }
}

/** What the user chose, once it is a director. */
export type ChosenFee =
  | { readonly kind: 'ready'; readonly mode: FeeFormMode; readonly director: FeeDirector; readonly description: FeeDescription }
  | { readonly kind: 'invalid'; readonly reason: string }

/** The numbers behind the panel of the form. */
export interface DeliveryFeeModel {
  /** The router that the relay targets: the field of the form, or the router of the deployment. */
  readonly router: Address
  readonly dataSource: FeeDataSource
  readonly cost: DeliveryCostBreakdown
  /** True when the report has no native coin price, so the cost leaves out the proof. */
  readonly proofCostMissing: boolean
  /** The three suggestions. A suggestion that needs a price that nobody gave says so. */
  readonly suggestions: FeeSuggestions
  readonly chosen: ChosenFee
}

/** The state of the panel after the inputs are read. */
export type DeliveryFeeState =
  | { readonly kind: 'needs-amount' }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'ready'; readonly model: DeliveryFeeModel }

/** Input of {@link buildDeliveryFeeModel}. */
export interface DeliveryFeeInput {
  readonly values: Values
  readonly target: DeliveryTarget
  readonly report: DeliveryCostReport
  /** The amount that reaches the fee router, in base units of the destination token. Null when the amount is not valid yet. */
  readonly transferValue: bigint | null
}

/** The mode that the form values choose. */
export function feeFormModeOf(values: Values): FeeFormMode {
  const mode = values[DELIVERY_FIELD.mode]
  return mode === 'fixed' || mode === 'gas' || mode === 'custom' ? mode : 'percentage'
}

/** True when the user chose to pay for delivery. */
export function paysForDelivery(values: Values): boolean {
  return values[DELIVERY_FIELD.delivery] === 'yes'
}

type Parsed<Value> = { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly reason: string }

function attempt<Value>(read: () => Value): Parsed<Value> {
  try {
    return { ok: true, value: read() }
  } catch (error) {
    if (error instanceof AmountParseError || error instanceof PlanInputError || error instanceof RangeError) return { ok: false, reason: error.message }
    throw error
  }
}

/** Runs a read of an amount and names the field in the message when the text is not a valid amount. */
function readAmount(label: string, read: () => bigint): bigint {
  try {
    const amount = read()
    if (amount > UINT256_MAXIMUM) throw new PlanInputError(`The ${label} is too large: it must fit in 256 bits.`)
    return amount
  } catch (error) {
    if (error instanceof AmountParseError) throw new PlanInputError(`The ${label} is not valid: ${error.message}.`)
    throw error
  }
}

function parseNumber(label: string, text: string, decimals: number): bigint {
  return readAmount(label, () => parseUnits(text, decimals))
}

function parseRatePercent(label: string, text: string): bigint {
  return readAmount(label, () => parsePercentAsRate(text))
}

const valueOf = (values: Values, name: string): string => (values[name] ?? '').trim()

/** The base fee ceiling that a blank field means: twice the base fee now. */
export function defaultCeilingWei(dataSource: FeeDataSource): bigint {
  return dataSource.baseFeeWei * 2n
}

function payoutOf(values: Values, target: DeliveryTarget): PayoutKind {
  return values[DELIVERY_FIELD.payout] === 'native' && target.isWrappedNative ? 'native' : 'token'
}

/**
 * Reads the form and builds everything the panel shows: the data source, the cost, the three suggestions and the fee
 * that the user chose.
 *
 * With no known price of the token, the wei based suggestions are off. The shared builder still runs with a stand-in
 * price of one wei, only to read the data source and the cost, and its suggestions are dropped.
 */
export function buildDeliveryFeeModel(input: DeliveryFeeInput): DeliveryFeeState {
  const { values, target, report, transferValue } = input
  if (transferValue === null || transferValue <= 0n) return { kind: 'needs-amount' }
  const margin = attempt(() => parseRatePercent('margin', valueOf(values, DELIVERY_FIELD.margin) || DEFAULT_MARGIN_PERCENT))
  if (!margin.ok) return { kind: 'unavailable', reason: margin.reason }
  const priority = attempt(() => parseNumber('priority fee', valueOf(values, DELIVERY_FIELD.priority) || DEFAULT_PRIORITY_GWEI, 9))
  if (!priority.ok) return { kind: 'unavailable', reason: priority.reason }
  const recipient = attempt(() => parseAddress(valueOf(values, DELIVERY_FIELD.recipient) || valueOf(values, 'receiver'), 'fee recipient'))
  if (!recipient.ok) return { kind: 'unavailable', reason: recipient.reason }
  const router = attempt(() => routerOf(values, target))
  if (!router.ok) return { kind: 'unavailable', reason: router.reason }
  const payout = payoutOf(values, target)
  const gasInputs = attempt(() => gasInputsOf(values, target))
  const built = attempt(() =>
    buildFeeSuggestions({
      recipient: recipient.value,
      transferValue,
      token: { ...target.token, valueInWei: target.valueInWei ?? 1n },
      payout,
      report,
      priorityFeeWei: priority.value,
      marginRate: margin.value,
      ...(gasInputs.ok ? gasInputs.value : {}),
    }),
  )
  if (!built.ok) return { kind: 'unavailable', reason: built.reason }
  const suggestions = withoutMissingPrices(built.value, { valuationKnown: target.valueInWei !== null, senderPriceGiven: gasInputs.ok && gasInputs.value.senderPrice !== undefined })
  const describe = (director: FeeDirector): FeeDescription =>
    describeFee(director, {
      transferValue,
      token: feeTokenOf(target),
      payout,
      gasUsed: built.value.dataSource.gas,
      baseFeeWei: built.value.dataSource.baseFeeWei,
      priorityFeeWei: priority.value,
      cost: target.valueInWei === null ? null : built.value.cost,
    })
  const chosen = chooseFee({ values, target, recipient: recipient.value, payout, suggestions, gasInputs, describe })
  return { kind: 'ready', model: { router: router.value, dataSource: built.value.dataSource, cost: built.value.cost, proofCostMissing: built.value.proofCostMissing, suggestions, chosen } }
}

/** The token of a target as the shared description wants it. A missing price becomes one wei: only the cost lines use it, and they are empty then. */
function feeTokenOf(target: DeliveryTarget): FeeToken {
  return { ...target.token, valueInWei: target.valueInWei ?? 1n }
}

interface GasInputs {
  readonly gasMargin?: bigint
  readonly baseFeeCeilingWei?: bigint
  /** The sender's own price of one wei of the native coin, in base units of the token. Absent when the field is blank. */
  readonly senderPrice?: SenderPrice
}

function gasInputsOf(values: Values, target: DeliveryTarget): GasInputs {
  const marginText = valueOf(values, DELIVERY_FIELD.multiplier)
  const ceilingText = valueOf(values, DELIVERY_FIELD.ceiling)
  const priceText = valueOf(values, DELIVERY_FIELD.senderPrice)
  return {
    ...(marginText === '' ? {} : { gasMargin: parseNumber('gas multiplier', marginText, 18) }),
    ...(ceilingText === '' ? {} : { baseFeeCeilingWei: parseNumber('base fee ceiling', ceilingText, 9) }),
    ...(priceText === '' ? {} : { senderPrice: { numerator: parseNumber('your price', priceText, target.token.decimals), denominator: WEI_PER_WHOLE_COIN } }),
  }
}

/** The router that the form names, or the router of the deployment when the field is blank. */
export function routerOf(values: Values, target: DeliveryTarget): Address {
  const text = valueOf(values, DELIVERY_FIELD.router)
  return text === '' ? target.router : parseAddress(text, 'router')
}

/**
 * The suggestions of the shared builder run with a stand-in valuation of one wei when none is known. This turns the
 * suggestions that would rest on the stand-in into a plain statement. The percentage and the fixed amount need the
 * valuation of the token. The gas multiplier needs a price, from the sender or from the valuation.
 */
function withoutMissingPrices(suggestions: FeeSuggestions, known: { readonly valuationKnown: boolean; readonly senderPriceGiven: boolean }): FeeSuggestions {
  if (known.valuationKnown) return suggestions
  const missing = (mode: FeeOption['mode'], reason: string): FeeOption => ({ kind: 'unavailable', mode, reason })
  return {
    ...suggestions,
    percentage: missing('share', NO_PRICE_REASON),
    fixed: missing('fixed', NO_PRICE_REASON),
    gasMultiplier: known.senderPriceGiven ? suggestions.gasMultiplier : missing('gas', NO_SENDER_PRICE_REASON),
  }
}

interface ChooseInput {
  readonly values: Values
  readonly target: DeliveryTarget
  readonly recipient: Address
  readonly payout: PayoutKind
  readonly suggestions: FeeSuggestions
  readonly gasInputs: Parsed<GasInputs>
  readonly describe: (director: FeeDirector) => FeeDescription
}

const NO_PRICE_REASON = 'no value of the token is configured, so the cost cannot be turned into tokens'
const NO_SENDER_PRICE_REASON = 'enter your price of the native coin in this token'

function chooseFee(input: ChooseInput): ChosenFee {
  const mode = feeFormModeOf(input.values)
  const director = directorOf(mode, input)
  if (!director.ok) return { kind: 'invalid', reason: director.reason }
  const described = attempt(() => input.describe(director.value))
  if (!described.ok) return { kind: 'invalid', reason: described.reason }
  return { kind: 'ready', mode, director: director.value, description: described.value }
}

const payoutBits = (payout: PayoutKind): bigint => (payout === 'native' ? FEE_SETTING.unwrap : 0n)

function suggestedDirector(option: FeeOption): Parsed<FeeDirector> {
  if (option.kind === 'unavailable') return { ok: false, reason: option.reason }
  return { ok: true, value: option.director }
}

function directorOf(mode: FeeFormMode, input: ChooseInput): Parsed<FeeDirector> {
  const { values, target, recipient, payout } = input
  const bits = payoutBits(payout)
  if (mode === 'percentage') {
    const text = valueOf(values, DELIVERY_FIELD.percent)
    if (text === '') return { ok: true, value: defaultTip(recipient, payout) }
    return attempt(() => {
      const multiplier = parseRatePercent('percentage', text)
      if (multiplier > RATE_SCALE) throw new PlanInputError('The percentage is above 100 percent.')
      return { recipient, settings: FEE_SETTING.shareOfValue | bits, limit: 0n, multiplier }
    })
  }
  if (mode === 'fixed') {
    const text = valueOf(values, DELIVERY_FIELD.fixed)
    if (text === '') return suggestedDirector(input.suggestions.fixed)
    return attempt(() => ({ recipient, settings: FEE_SETTING.fixedFee | bits, limit: parseNumber('fixed amount', text, target.token.decimals), multiplier: 0n }))
  }
  if (mode === 'gas') {
    if (!input.gasInputs.ok) return { ok: false, reason: input.gasInputs.reason }
    return suggestedDirector(input.suggestions.gasMultiplier)
  }
  return customDirector(values, { recipient, bits, decimals: target.token.decimals })
}

/** The kinds of a custom fee, in the order of the form. */
export const CUSTOM_KINDS = ['fixed', 'share', 'gas'] as const

function customDirector(values: Values, input: { recipient: Address; bits: bigint; decimals: number }): Parsed<FeeDirector> {
  return attempt(() => {
    const kind = values[DELIVERY_FIELD.customKind] ?? 'fixed'
    const limit = parseNumber('limit', valueOf(values, DELIVERY_FIELD.customLimit) || '0', input.decimals)
    const multiplier = parseNumber('multiplier', valueOf(values, DELIVERY_FIELD.customMultiplier) || '0', 18)
    const basis: GasPriceBasis = values[DELIVERY_FIELD.customBasis] === 'base-fee-only' ? 'base-fee-only' : 'transaction'
    if (kind === 'fixed') return { recipient: input.recipient, settings: FEE_SETTING.fixedFee | input.bits, limit, multiplier: 0n }
    if (kind === 'share') {
      if (multiplier > RATE_SCALE) throw new PlanInputError('The multiplier of a share is above 1, which is above 100 percent.')
      return { recipient: input.recipient, settings: FEE_SETTING.shareOfValue | input.bits, limit: 0n, multiplier }
    }
    if (multiplier === 0n) throw new PlanInputError('The multiplier of a gas based fee must be above zero.')
    return { recipient: input.recipient, settings: input.bits | (basis === 'base-fee-only' ? FEE_SETTING.baseFeeOnly : 0n), limit, multiplier }
  })
}

/**
 * The sender's price that the valuation of the token gives, as the text of the field: whole tokens for one whole native
 * coin. Blank when no valuation is known. The user may replace it: the price is the sender's own.
 */
export function senderPriceText(target: DeliveryTarget): string {
  if (target.valueInWei === null) return ''
  return formatUnits((WEI_PER_WHOLE_COIN * 10n ** BigInt(target.token.decimals)) / target.valueInWei, target.token.decimals)
}

/**
 * The numbers that the chosen mode puts into the editable fields. The percentage starts at the default tip of 0.1
 * percent. The fixed amount starts at the suggestion. The gas multiplier starts at the margin, the ceiling and the price
 * of the valuation. The cost based suggestions stay on the panel for the user to read.
 */
export function suggestedFields(mode: FeeFormMode, state: DeliveryFeeState, target: DeliveryTarget): Values {
  if (mode === 'custom') return {}
  if (mode === 'percentage') return { [DELIVERY_FIELD.percent]: DEFAULT_TIP_PERCENT_TEXT }
  if (state.kind !== 'ready') return {}
  const { suggestions, dataSource } = state.model
  if (mode === 'gas') {
    return {
      [DELIVERY_FIELD.multiplier]: DEFAULT_GAS_MULTIPLIER_TEXT,
      [DELIVERY_FIELD.ceiling]: formatUnits(defaultCeilingWei(dataSource), 9),
      [DELIVERY_FIELD.senderPrice]: senderPriceText(target),
    }
  }
  const option = suggestions.fixed
  return { [DELIVERY_FIELD.fixed]: option.kind === 'available' ? formatUnits(option.director.limit, target.token.decimals) : '' }
}

/** The fields of a director, for the custom mode. */
export function customFieldsOf(director: FeeDirector, decimals: number): Values {
  const mode = feeModeOf(director.settings)
  return {
    [DELIVERY_FIELD.customKind]: mode,
    [DELIVERY_FIELD.customLimit]: formatUnits(director.limit, decimals),
    [DELIVERY_FIELD.customMultiplier]: formatUnits(director.multiplier, 18),
    [DELIVERY_FIELD.customBasis]: (director.settings & FEE_SETTING.baseFeeOnly) !== 0n ? 'base-fee-only' : 'transaction',
  }
}

/** The fields whose change refills the percentage: the default tip does not depend on the amount or the prices. */
const PERCENTAGE_REFILL_TRIGGERS: readonly string[] = [DELIVERY_FIELD.delivery, DELIVERY_FIELD.mode]

/** The fields whose change makes the suggestions change. Their change refills the numbers of the chosen mode. */
const REFILL_TRIGGERS: readonly string[] = [
  DELIVERY_FIELD.delivery,
  DELIVERY_FIELD.mode,
  DELIVERY_FIELD.margin,
  DELIVERY_FIELD.priority,
  DELIVERY_FIELD.payout,
  'amount',
  'token',
]

/** What the form needs to recompute the model for any values. */
export interface RefillContext {
  /** Builds the state for these values, or null when no report or target exists yet. */
  readonly stateFor: (values: Values) => { readonly state: DeliveryFeeState; readonly target: DeliveryTarget } | null
}

/**
 * Called after each edit. Choosing a suggestion (a new mode, a new margin, a new amount) fills the editable numbers
 * with the suggested ones, so the user starts from the suggestion and edits from there. Editing a number does not
 * refill, so the user's number stays. A switch to the custom mode starts from the terms of the mode just left.
 *
 * @param previous The values before the edit.
 * @param next The values after the edit.
 * @param context Builds the state of the model for a set of values.
 */
export function refillDeliveryFee(previous: Values, next: Values, context: RefillContext): Values {
  if (!paysForDelivery(next)) return next
  const mode = feeFormModeOf(next)
  const triggers = mode === 'percentage' ? PERCENTAGE_REFILL_TRIGGERS : REFILL_TRIGGERS
  if (!triggers.some((name) => previous[name] !== next[name])) return next
  if (mode === 'custom') return previous[DELIVERY_FIELD.mode] === next[DELIVERY_FIELD.mode] ? next : { ...next, ...customStart(previous, context) }
  const built = context.stateFor(next)
  if (built === null) return next
  const fields = suggestedFields(mode, built.state, built.target)
  // A gas multiplier and its ceiling are inputs, not outputs: refill them only when the user just chose the mode.
  const keepGasInputs = mode === 'gas' && previous[DELIVERY_FIELD.mode] === next[DELIVERY_FIELD.mode]
  return keepGasInputs ? next : { ...next, ...fields }
}

function customStart(previous: Values, context: RefillContext): Values {
  const built = context.stateFor(previous)
  if (built === null || built.state.kind !== 'ready' || built.state.model.chosen.kind !== 'ready') return {}
  return customFieldsOf(built.state.model.chosen.director, built.target.token.decimals)
}

/**
 * The amount that reaches the fee router: the amount that the user typed, less the fee of the mediator.
 *
 * @param amountText What the user typed, in whole tokens.
 * @param decimals The decimals of the token.
 * @param feeRate The fee rate of the mediator, 1e18-scaled. Use zero when it is not read yet.
 * @returns The amount in base units, or null when the text is not an amount above zero or nothing is left after the fee.
 */
export function transferValueOf(amountText: string, decimals: number, feeRate: bigint): bigint | null {
  const amount = attempt(() => parseUnits(amountText, decimals))
  if (!amount.ok) return null
  const remaining = amount.value - (amount.value * feeRate) / RATE_SCALE
  return remaining > 0n ? remaining : null
}
