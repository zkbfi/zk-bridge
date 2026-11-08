/**
 * The text of the delivery fee: the live panel of the bridge form and the lines of the confirmation screen. Every
 * function is pure and returns lines, so a test reads the text without a terminal. The amounts and the labels
 * (`exact`, `estimate, at most X`) come from `@zk-bridge/shared`.
 */
import { GAS_MODE_HELP, GAS_MODE_SHORT_LABEL, TIP_MODE_NAMES, TIP_NATURE, TIP_RANGE_HELP, feeModeOf, routerCallbackGas, routerInWords, settingFlagsOf, type FeeDirector, type FeeMode, type FeeOption, type SettingFlagName, type TipRangeOption } from '@zk-bridge/shared'
import { getAddress } from 'viem'
import type { RouterAddressesReading } from '../chain/live-reads'
import type { DeliveryFeeState, DeliveryTarget } from '../app/delivery-fee-form'
import { formatRateAsPercent, formatUnits } from '../format/amounts'
import type { DeliveryFeeReview } from '../tx/plan'
import { colored, muted, plain, strong, type Line } from './rich-text'
import { theme } from './theme'

/** What the panel shows: the report is loading or failed, or the inputs are read. */
export type DeliveryPanelInput =
  | { readonly kind: 'loading'; readonly chainName: string }
  | { readonly kind: 'failed'; readonly chainName: string; readonly reason: string }
  | { readonly kind: 'state'; readonly state: DeliveryFeeState; readonly target: DeliveryTarget }

const LABEL_WIDTH = 16

/** The label width of the confirmation screen. The delivery lines line up with the rest of it. */
const REVIEW_LABEL_WIDTH = 14

const rowOf = (width: number) => (label: string, value: string): Line => [muted(label.padEnd(width)), plain(value)]
const row = rowOf(LABEL_WIDTH)
const reviewRow = rowOf(REVIEW_LABEL_WIDTH)

/** The words of each flag. The record is exhaustive: a new flag in the shared module fails the typecheck here. */
const FLAG_WORDS: Readonly<Record<SettingFlagName, string>> = {
  FIXED_FEE: 'fixed fee',
  MULTIPLIER_OF_TOTAL: 'share of the value',
  UNWRAP: 'paid in the native coin',
  EXCLUDE_PRIORITY: 'gas priced at the base fee only',
}

/** The flag bits of `settings`, in words. */
export function feeFlagsInWords(settings: bigint): string {
  const flags = settingFlagsOf(settings).map((name) => FLAG_WORDS[name])
  return flags.length === 0 ? 'none (gas based fee, paid in the token)' : flags.join(', ')
}

/**
 * The lines that name the address that receives the tip and the address that receives what the router cannot deliver.
 * The reading comes from the router itself. When it failed, the lines say so and do not name any address: the screen
 * must not claim a destination that nobody confirmed.
 */
export function routerAddressLines(reading: RouterAddressesReading): readonly Line[] {
  if (reading.kind === 'read') {
    return [
      reviewRow('Tip goes to', `${getAddress(reading.rewardAddress)} (reward address of the router)`),
      reviewRow('On failure', `the tokens go to ${getAddress(reading.failedDeliveryAddress)} (failed delivery address of the router)`),
    ]
  }
  return [
    reviewRow('Tip goes to', 'unknown'),
    reviewRow('On failure', 'unknown'),
    [colored(`Warning: the router did not return its addresses (${reading.reason}).`, theme.warn)],
    [colored('It may be an older router that has no reward address, or not a delivery router. Check it before you send.', theme.warn)],
  ]
}

/** The multiplier of a director in words. */
export function multiplierInWords(director: FeeDirector): string {
  const mode = feeModeOf(director.settings)
  if (mode === 'fixed') return 'not used'
  if (mode === 'share') return `${formatRateAsPercent(director.multiplier)} of the transfer`
  return `${formatUnits(director.multiplier, 18)} token units for each wei of gas cost (your price and margin are folded in)`
}

/** The limit of a director in words. */
export function limitInWords(director: FeeDirector, token: { readonly symbol: string; readonly decimals: number }): string {
  const mode = feeModeOf(director.settings)
  const amount = `${formatUnits(director.limit, token.decimals)} ${token.symbol}`
  if (mode === 'fixed') return `${amount} (the fee)`
  if (mode === 'gas') return `${amount} (price ceiling: the most the tip can be)`
  return 'not used'
}

/**
 * The name of a tip mode for the lines. The gas mode shows the short label, which fits the label column. The help line
 * (`GAS_MODE_HELP`) carries the long text.
 */
export function tipModeLabel(mode: FeeMode): string {
  return mode === 'gas' ? GAS_MODE_SHORT_LABEL : TIP_MODE_NAMES[mode]
}

function suggestionLine(name: string, option: FeeOption): Line {
  const label = name.padEnd(LABEL_WIDTH)
  if (option.kind === 'unavailable') return [muted(label), colored(`unavailable: ${option.reason}`, theme.warn)]
  return [muted(label), plain(option.description.summary), muted(`  (${option.description.formula})`)]
}

/** The suggested range as one line: the low, the suggested and the high tip, in the token. */
function tipRangeLine(range: TipRangeOption, token: DeliveryTarget['token']): Line {
  const label = 'Tip range'.padEnd(LABEL_WIDTH)
  if (range.kind === 'unavailable') return [muted(label), colored(`unavailable: ${range.reason}`, theme.warn)]
  const amount = (units: bigint) => `${formatUnits(units, token.decimals)} ${token.symbol}`
  const { low, default: suggested, high } = range
  return [muted(label), plain(`low ${amount(low.description.nowUnits)}, suggested ${amount(suggested.description.nowUnits)}, high ${amount(high.description.nowUnits)}`)]
}

/**
 * The lines of the live panel under the bridge form.
 *
 * @param input The state of the report and of the inputs.
 */
export function deliveryPanelLines(input: DeliveryPanelInput): readonly Line[] {
  if (input.kind === 'loading') return [[strong('Delivery cost', theme.accent)], [muted(`Reading the delivery cost of ${input.chainName} from the indexer…`)]]
  if (input.kind === 'failed') {
    return [
      [strong('Delivery cost', theme.accent)],
      [colored(`The delivery cost of ${input.chainName} could not be read: ${input.reason}`, theme.bad)],
      [muted('Pay for delivery needs it. Choose No to bridge with no fee.')],
    ]
  }
  const { state, target } = input
  const heading: Line = [strong(`Delivery cost on ${target.chain.name}`, theme.accent)]
  if (state.kind === 'needs-amount') return [heading, [muted('Enter an amount to see the fee.')]]
  if (state.kind === 'unavailable') return [heading, [colored(state.reason, theme.bad)]]
  const { model } = state
  const coin = target.chain.nativeSymbol
  const wei = (amount: bigint) => `${formatUnits(amount, 18)} ${coin}`
  const margin = model.chosen.kind === 'ready' ? model.chosen.description.breakdown.find((line) => line.id === 'margin') : undefined
  const costParts = [
    `gas ${wei(model.cost.gasCostWei)}`,
    ...(margin === undefined ? [] : [`margin ${wei(margin.amountWei)}`]),
  ]
  return [
    heading,
    row('Router', routerInWords(model.router, target.router)),
    row('Gas', `${model.dataSource.gas} gas, ${model.dataSource.description}`),
    row('Base fee', model.dataSource.baseFeeDescription.replace(/^base fee /, '')),
    row('Cost', costParts.join(' + ')),
    tipRangeLine(model.suggestions.tipRange, target.token),
    [muted(TIP_RANGE_HELP)],
    [muted(TIP_NATURE)],
    ...suggestionLines(model.suggestions),
    ...chosenLines(model.chosen, target),
    ...(model.notice === null ? [] : [[colored(model.notice, theme.warn)] as Line]),
  ]
}

function suggestionLines(suggestions: DeliveryFeeStateReady['suggestions']): readonly Line[] {
  return [
    suggestionLine('Percentage', suggestions.percentage),
    suggestionLine('Fixed', suggestions.fixed),
    suggestionLine('Gas multiplier', suggestions.gasMultiplier),
  ]
}

type DeliveryFeeStateReady = Extract<DeliveryFeeState, { kind: 'ready' }>['model']

function chosenLines(chosen: DeliveryFeeStateReady['chosen'], target: DeliveryTarget): readonly Line[] {
  if (chosen.kind === 'invalid') return [[muted('Your tip'.padEnd(LABEL_WIDTH)), colored(chosen.reason, theme.bad)]]
  const maximum = `${formatUnits(chosen.description.maximumUnits, target.token.decimals)} ${target.token.symbol}`
  const limit = chosen.mode === 'gas' ? [row('Limit', limitInWords(chosen.director, target.token))] : []
  const gas = chosen.director.callGas > 0n ? callGasRows(chosen.director, row) : []
  return [
    row('Tip mode', tipModeLabel(chosen.description.mode)),
    [muted('Your tip'.padEnd(LABEL_WIDTH)), strong(chosen.description.summary, theme.good)],
    ...limit,
    row('At most', maximum),
    ...gas,
  ]
}

/** The gas of the call, and the callback gas that the relay passes: the call gas plus the router's own work. The callback gas is derived, never typed. */
function callGasRows(director: FeeDirector, makeRow: (label: string, value: string) => Line): readonly Line[] {
  return [
    makeRow('Call gas', `${director.callGas} (the exact gas the call gets)`),
    makeRow('Callback gas', `${routerCallbackGas({ callGas: director.callGas })} (the call gas plus the router's own work; set for you)`),
  ]
}

/** The call after the delivery: its target, its call data and its gas, and for a gas based tip the note that the call gas counts. */
function callReviewLines(deliveryFee: DeliveryFeeReview): readonly Line[] {
  const { call, description } = deliveryFee
  if (call === undefined) return []
  return [
    reviewRow('Call target', getAddress(call.target)),
    reviewRow('Call data', call.data === '0x' ? '0x (empty)' : `${call.data} (${(call.data.length - 2) / 2} bytes)`),
    ...callGasRows(deliveryFee.director, reviewRow),
    ...(description.mode === 'gas' ? [[colored('A gas based tip counts the call gas, so the tip is higher with a call. The limit above is still the most it can be.', theme.warn)] as Line] : []),
  ]
}

/**
 * The lines of the delivery fee on the confirmation screen: the mode, the numbers, the amount now with its label, the
 * most that the router can pay as the tip, and the data behind the amount.
 *
 * @param deliveryFee The review that the plan carries.
 */
export function deliveryFeeReviewLines(deliveryFee: DeliveryFeeReview): readonly Line[] {
  const { director, description, dataSource, token } = deliveryFee
  return [
    [strong('Tip for delivery', theme.accent)],
    reviewRow('Router', routerInWords(deliveryFee.router, deliveryFee.defaultRouter)),
    reviewRow('Tip mode', tipModeLabel(description.mode)),
    ...(description.mode === 'gas' ? [[muted(GAS_MODE_HELP)] as Line] : []),
    reviewRow('Recipient', getAddress(director.recipient)),
    ...routerAddressLines(deliveryFee.routerAddresses),
    reviewRow('Flags', feeFlagsInWords(director.settings)),
    reviewRow('Limit', limitInWords(director, token)),
    reviewRow('Multiplier', multiplierInWords(director)),
    reviewRow('Tip now', description.summary),
    ...(description.mode === 'gas' ? [reviewRow('Expected', `about ${formatUnits(description.expectedUnits, token.decimals)} ${token.symbol} at the gas estimate`)] : []),
    reviewRow('Most the tip', `${formatUnits(description.maximumUnits, token.decimals)} ${token.symbol} (the tip never passes this${description.mode === 'gas' ? '; more gas from the deliverer can raise it up to here' : ''})`),
    ...callReviewLines(deliveryFee),
    reviewRow('Data source', `${dataSource.description}, ${dataSource.gas} gas`),
    reviewRow('Base fee', dataSource.baseFeeDescription.replace(/^base fee /, '')),
  ]
}
