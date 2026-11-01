import { describe, expect, test } from 'bun:test'
import { encodeAbiParameters, getAddress, parseAbiParameters } from 'viem'
import {
  DEFAULT_GAS_MARGIN,
  EXCLUDE_PRIORITY,
  GAS_MODE_HELP,
  GAS_MODE_SHORT_LABEL,
  buildFeeSuggestions,
  encodeFeeDirector,
  gasOverheadOf,
  settingsOf,
} from '@zk-bridge/shared'
import { bridgeSourceOf } from '../../src/app/actions'
import {
  DEFAULT_GAS_MULTIPLIER_TEXT,
  buildDeliveryFeeModel,
  feeFormModeOf,
  refillDeliveryFee,
  resolveDeliveryTarget,
  transferValueOf,
  type DeliveryFeeState,
  type DeliveryTarget,
  type Values,
} from '../../src/app/delivery-fee-form'
import { FIXTURE_NOW, FIXTURE_PAIR, FIXTURE_TOKENS, buildFixtureDeliveryCost } from '../../src/data/fixtures'
import type { PairConfig } from '../../src/model/types'
import { deliveryFeeReviewLines, deliveryPanelLines, tipModeLabel } from '../../src/ui/delivery-fee-lines'
import { lineText } from '../../src/ui/rich-text'

const usdc = FIXTURE_TOKENS[0]!
const zkUsdc = FIXTURE_TOKENS[1]!
const receiver = '0x0000000000000000000000000000000000000abc'
/** No fee mode: the form default decides. */
const defaultValues: Values = { token: `first:${usdc.address}`, amount: '100', receiver, feeMargin: '10', feePriorityGwei: '1' }
/** One zUSDC (6 decimals) is worth 4e14 wei, so one wei is worth 1e6 / 4e14 base units. */
const TOKEN_VALUE_IN_WEI = 400_000_000_000_000n
const priced = { [zkUsdc.address.toLowerCase()]: TOKEN_VALUE_IN_WEI }
const report = buildFixtureDeliveryCost(369, FIXTURE_NOW)
const noBaseFeePair: PairConfig = { ...FIXTURE_PAIR, second: { ...FIXTURE_PAIR.second, name: 'Binary Smart Chain', baseFee: 'none' } }

function targetFor(values: Values, valuations: Record<string, bigint>, pair: PairConfig): DeliveryTarget {
  const resolved = resolveDeliveryTarget({ source: bridgeSourceOf(values, FIXTURE_TOKENS, pair), pair, tokens: FIXTURE_TOKENS, valuations })
  if (resolved.kind !== 'ready') throw new Error(resolved.reason)
  return resolved.target
}

function stateOf(values: Values, options: { valuations?: Record<string, bigint>; pair?: PairConfig } = {}): { state: DeliveryFeeState; target: DeliveryTarget } {
  const target = targetFor(values, options.valuations ?? priced, options.pair ?? FIXTURE_PAIR)
  return { state: buildDeliveryFeeModel({ values, target, report, transferValue: transferValueOf(values.amount ?? '', target.token.decimals) }), target }
}

function modelOf(values: Values, options: { valuations?: Record<string, bigint>; pair?: PairConfig } = {}) {
  const { state } = stateOf(values, options)
  if (state.kind !== 'ready') throw new Error(`state is ${state.kind}`)
  return state.model
}

function directorOf(values: Values, options: { valuations?: Record<string, bigint>; pair?: PairConfig } = {}) {
  const { chosen } = modelOf(values, options)
  if (chosen.kind !== 'ready') throw new Error(`the tip is ${chosen.kind}: ${chosen.reason}`)
  return chosen.director
}

const ceilingDivide = (numerator: bigint, denominator: bigint): bigint => (numerator + denominator - 1n) / denominator

describe('the default tip of the form', () => {
  test('the form mode is gas unless the user chose another one', () => {
    expect(feeFormModeOf({})).toBe('gas')
    expect(feeFormModeOf({ feeMode: 'gibberish' })).toBe('gas')
    for (const mode of ['percentage', 'fixed', 'custom'] as const) expect(feeFormModeOf({ feeMode: mode })).toBe(mode)
    expect(DEFAULT_GAS_MULTIPLIER_TEXT).toBe('1')
  })

  test('a chain that reports a base fee gets the gas mode with the base fee flag and no notice', () => {
    const director = directorOf(defaultValues)
    expect(director.settings).toBe(EXCLUDE_PRIORITY)
    expect(director.settings).toBe(settingsOf({ mode: 'gas', gasPrice: 'base-fee-only' }))
    expect(modelOf(defaultValues).notice).toBeNull()
  })

  test('a chain with no base fee gets the whole gas price, with no flag, and says why', () => {
    const director = directorOf(defaultValues, { pair: noBaseFeePair })
    expect(director.settings).toBe(0n)
    expect(modelOf(defaultValues, { pair: noBaseFeePair }).notice).toBe('Binary Smart Chain reports no base fee, so the tip reads the whole gas price.')
  })

  test('the multiplier is the price of one wei in base units, times 1, times 1e18, rounded up', () => {
    const { multiplier } = directorOf(defaultValues)
    expect(multiplier).toBe(ceilingDivide(10n ** 6n * 10n ** 18n, TOKEN_VALUE_IN_WEI))
    expect(DEFAULT_GAS_MARGIN).toBe(10n ** 18n)
  })

  test('a price that does not divide evenly rounds the multiplier up, never down', () => {
    const odd = { [zkUsdc.address.toLowerCase()]: 300_000_000_000_001n }
    const { multiplier } = directorOf(defaultValues, { valuations: odd })
    expect(multiplier).toBe(ceilingDivide(10n ** 6n * 10n ** 18n, 300_000_000_000_001n))
    expect(multiplier * 300_000_000_000_001n).toBeGreaterThan(10n ** 6n * 10n ** 18n)
  })

  test('the price that the sender types replaces the valuation', () => {
    // 2500 whole tokens for one coin: 2,500e6 base units for 1e18 wei.
    const typed = { ...defaultValues, feeSenderPrice: '2500' }
    for (const valuations of [priced, {}]) {
      expect(directorOf(typed, { valuations }).multiplier).toBe(ceilingDivide(2_500n * 10n ** 6n * 10n ** 18n, 10n ** 18n))
    }
  })

  test('the limit is the tip at the ceiling base fee, which is twice the base fee now', () => {
    const director = directorOf(defaultValues)
    const baseFeeNow = 7_000_000_000n
    const deliveryGas = 210_000n
    expect(director.limit).toBe(ceilingDivide((deliveryGas + gasOverheadOf('token')) * director.multiplier * (2n * baseFeeNow), 10n ** 18n))
    const suggestion = buildFeeSuggestions({
      recipient: getAddress(receiver),
      transferValue: 100_000_000n,
      token: { symbol: zkUsdc.symbol, decimals: zkUsdc.decimals, valueInWei: TOKEN_VALUE_IN_WEI },
      report,
      priorityFeeWei: 1_000_000_000n,
      gasPrice: 'base-fee-only',
    }).gasMultiplier
    if (suggestion.kind !== 'available') throw new Error('the shared suggestion is available')
    expect(director.limit).toBe(suggestion.director.limit)
    expect(director).toEqual({ ...suggestion.director, recipient: getAddress(receiver) })
  })

  test('the encoding of the default director is abi.encode of the recipient, 4, the limit and the multiplier', () => {
    const director = directorOf(defaultValues)
    const context = { router: FIXTURE_PAIR.second.contracts.deliveryRouter!, protectedAddresses: [], destinationToken: null, destinationWrappedNative: null }
    const expected = encodeAbiParameters(parseAbiParameters('address, uint256, uint256, uint256'), [getAddress(receiver), 4n, director.limit, director.multiplier])
    expect(encodeFeeDirector(director, context)).toBe(expected)
  })

  test('percentage and fixed stay selectable and keep their own numbers', () => {
    const percentage = directorOf({ ...defaultValues, feeMode: 'percentage' })
    expect(percentage).toEqual({ recipient: getAddress(receiver), settings: settingsOf({ mode: 'share' }), limit: 0n, multiplier: 10n ** 15n })
    const fixed = directorOf({ ...defaultValues, feeMode: 'fixed' })
    expect(fixed.settings).toBe(settingsOf({ mode: 'fixed' }))
    expect(fixed.limit).toBeGreaterThan(0n)
  })

  test('with no sender price and no valuation the tip cannot be computed, and the notice asks for a price', () => {
    const model = modelOf(defaultValues, { valuations: {} })
    expect(model.chosen).toEqual({ kind: 'invalid', reason: 'enter your price of the native coin in this token' })
    expect(model.notice).toContain('Enter your price of the native coin in this token.')
    // Percentage and fixed need the same price: no fixed fallback is invented.
    expect(modelOf({ ...defaultValues, feeMode: 'fixed' }, { valuations: {} }).chosen.kind).toBe('invalid')
  })

  test('a typed price makes the missing-price notice go away', () => {
    const model = modelOf({ ...defaultValues, feeSenderPrice: '2500' }, { valuations: {} })
    expect(model.chosen.kind).toBe('ready')
    expect(model.notice).toBeNull()
  })

  test('the notice is only for the gas mode', () => {
    expect(modelOf({ ...defaultValues, feeMode: 'percentage' }, { valuations: {} }).notice).toBeNull()
  })

  test('a typed price that is not a number leaves the notice to the missing price, and the field reports its own error', () => {
    const model = modelOf({ ...defaultValues, feeSenderPrice: 'abc' }, { valuations: {} })
    expect(model.chosen.kind).toBe('invalid')
    expect(model.notice).toContain('Enter your price')
  })
})

describe('refilling the gas fields', () => {
  const context = { stateFor: (values: Values) => stateOf(values) }
  const entered = { ...defaultValues, delivery: 'yes' }

  test('entering the form with the default mode fills the multiplier, the ceiling and the price', () => {
    const next = refillDeliveryFee({ ...entered, delivery: 'no' }, entered, context)
    expect(next.feeMultiplier).toBe('1')
    expect(next.feeCeilingGwei).toBe('14')
    expect(next.feeSenderPrice).toBe('2500')
  })

  test('a number that the user typed stays when the amount changes, and a blank one is filled', () => {
    const typed = { ...entered, feeMultiplier: '3', feeCeilingGwei: '20', feeSenderPrice: '' }
    const next = refillDeliveryFee(typed, { ...typed, amount: '250' }, context)
    expect(next.feeMultiplier).toBe('3')
    expect(next.feeCeilingGwei).toBe('20')
    expect(next.feeSenderPrice).toBe('2500')
  })

  test('changing the token starts the gas numbers over', () => {
    const typed = { ...entered, feeMultiplier: '3', feeCeilingGwei: '20', feeSenderPrice: '1' }
    const next = refillDeliveryFee(typed, { ...typed, token: `second:${zkUsdc.address}` }, { stateFor: () => stateOf(typed) })
    expect(next.feeMultiplier).toBe('1')
    expect(next.feeCeilingGwei).toBe('14')
  })
})

describe('the words of the gas mode', () => {
  const target = targetFor(defaultValues, priced, FIXTURE_PAIR)
  const panelText = (values: Values, options: { valuations?: Record<string, bigint>; pair?: PairConfig } = {}): string => {
    const { state, target: resolved } = stateOf(values, options)
    return deliveryPanelLines({ kind: 'state', state, target: resolved }).map(lineText).join('\n')
  }

  test('the short label fits the label column of 14 characters', () => {
    expect(GAS_MODE_SHORT_LABEL.length).toBeLessThanOrEqual(14)
    expect(tipModeLabel('gas')).toBe(GAS_MODE_SHORT_LABEL)
    expect(tipModeLabel('share')).toBe('percentage of the transfer')
    expect(tipModeLabel('fixed')).toBe('fixed amount')
  })

  test('the panel shows the short label and the limit as the price ceiling', () => {
    const text = panelText(defaultValues)
    expect(text).toContain(`Tip mode        ${GAS_MODE_SHORT_LABEL}`)
    expect(text).toMatch(/Limit {11}[\d.]+ zUSDC \(price ceiling: the most the tip can be\)/)
    expect(text).not.toContain('proof')
  })

  test('the panel shows the notice for a chain with no base fee and for a missing price', () => {
    expect(panelText(defaultValues, { pair: noBaseFeePair })).toContain('Binary Smart Chain reports no base fee')
    expect(panelText(defaultValues, { valuations: {} })).toContain('Enter your price of the native coin in this token.')
    expect(panelText(defaultValues)).not.toContain('reports no base fee')
  })

  test('the review shows the short label, the help line and the limit as the price ceiling in the 14 character column', () => {
    const director = directorOf(defaultValues)
    const description = modelOf(defaultValues).chosen
    if (description.kind !== 'ready') throw new Error('ready')
    const lines = deliveryFeeReviewLines({
      router: FIXTURE_PAIR.second.contracts.deliveryRouter!,
      defaultRouter: FIXTURE_PAIR.second.contracts.deliveryRouter!,
      routerChainName: 'PulseChain',
      director,
      token: target.token,
      description: description.description,
      dataSource: modelOf(defaultValues).dataSource,
      routerAddresses: { kind: 'unreadable', reason: 'none' },
    }).map(lineText)
    expect(lines).toContain(`Tip mode      ${GAS_MODE_SHORT_LABEL}`)
    expect(lines).toContain(GAS_MODE_HELP)
    expect(lines.find((line) => line.startsWith('Limit '))).toContain('price ceiling')
  })
})
