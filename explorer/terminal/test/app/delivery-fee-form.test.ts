import { describe, expect, test } from 'bun:test'
import { getAddress } from 'viem'
import { FEE_SETTING, decodeFeeDirector, encodeFeeDirector, feeModeOf } from '@zk-bridge/shared'
import { bridgeSourceOf } from '../../src/app/actions'
import {
  buildDeliveryFeeModel,
  customFieldsOf,
  refillDeliveryFee,
  resolveDeliveryTarget,
  transferValueOf,
  type DeliveryFeeState,
  type DeliveryTarget,
  type Values,
} from '../../src/app/delivery-fee-form'
import { FIXTURE_NOW, FIXTURE_PAIR, FIXTURE_TOKENS, buildFixtureDeliveryCost } from '../../src/data/fixtures'
import type { PairConfig } from '../../src/model/types'

const usdc = FIXTURE_TOKENS[0]!
const zkUsdc = FIXTURE_TOKENS[1]!
const receiver = '0x0000000000000000000000000000000000000abc'
const baseValues: Values = { token: `first:${usdc.address}`, amount: '100', receiver, feeMode: 'percentage', feeMargin: '10', feePriorityGwei: '1' }
const price = { [zkUsdc.address.toLowerCase()]: 400_000_000_000_000n }
const report = buildFixtureDeliveryCost(369, FIXTURE_NOW)

function targetFor(values: Values, valuations: Record<string, bigint> = price, pair: PairConfig = FIXTURE_PAIR): DeliveryTarget {
  const resolved = resolveDeliveryTarget({ source: bridgeSourceOf(values, FIXTURE_TOKENS, pair), pair, tokens: FIXTURE_TOKENS, valuations })
  if (resolved.kind !== 'ready') throw new Error(resolved.reason)
  return resolved.target
}

function stateFor(values: Values, valuations: Record<string, bigint> = price, reportOverride = report, pair: PairConfig = FIXTURE_PAIR, decimals = 6): DeliveryFeeState {
  return buildDeliveryFeeModel({ values, target: targetFor(values, valuations, pair), report: reportOverride, transferValue: transferValueOf(values.amount ?? '', decimals, 10n ** 15n) })
}

// A gas based fee fits only the wrapped native token (price 10^18, 18 decimals): WETH on Ethereum bridges to zkbWETH,
// which this pair names as the wrapped native token of PulseChain.
const weth = FIXTURE_TOKENS[2]!
const zkWeth = FIXTURE_TOKENS[3]!
const nativePair: PairConfig = { ...FIXTURE_PAIR, second: { ...FIXTURE_PAIR.second, contracts: { ...FIXTURE_PAIR.second.contracts, wrappedNative: zkWeth.address } } }
const nativeValues: Values = { ...baseValues, token: `first:${weth.address}` }
const nativeState = (values: Values) => stateFor(values, {}, report, nativePair, 18)

function readyModel(state: DeliveryFeeState) {
  if (state.kind !== 'ready') throw new Error(`state is ${state.kind}`)
  return state.model
}

describe('resolveDeliveryTarget', () => {
  test('names the fee router of the destination chain, not of the source chain', () => {
    const target = targetFor(baseValues)
    expect(target.chain.name).toBe('PulseChain')
    expect(target.router).toBe(FIXTURE_PAIR.second.contracts.feeRouter!)
    expect(target.token).toEqual({ symbol: 'zkbUSDC', decimals: 6 })
  })

  test('says so and offers nothing when the deployment names no fee router for the destination', () => {
    const wpls = FIXTURE_TOKENS[4]! // on PulseChain, so the destination is Ethereum, which has no fee router
    const values = { ...baseValues, token: `second:${wpls.address}` }
    const result = resolveDeliveryTarget({ source: bridgeSourceOf(values, FIXTURE_TOKENS, FIXTURE_PAIR), pair: FIXTURE_PAIR, tokens: FIXTURE_TOKENS, valuations: {} })
    expect(result).toEqual({ kind: 'unavailable', reason: 'The deployment names no fee router for Ethereum, so a delivery fee is not offered.' })
  })

  test('the wrap and relay route carries no call data, so it is unavailable', () => {
    const result = resolveDeliveryTarget({ source: bridgeSourceOf({ token: 'first:native' }, FIXTURE_TOKENS, FIXTURE_PAIR), pair: FIXTURE_PAIR, tokens: FIXTURE_TOKENS, valuations: {} })
    expect(result.kind === 'unavailable' && result.reason).toContain('carries no call data')
  })

  test('the wrapped native token is worth 10^18 wei per token, and any other token needs a price', () => {
    const wrappedPair: PairConfig = { ...FIXTURE_PAIR, second: { ...FIXTURE_PAIR.second, contracts: { ...FIXTURE_PAIR.second.contracts, wrappedNative: zkUsdc.address } } }
    const native = targetFor(baseValues, {}, wrappedPair)
    expect(native.isWrappedNative).toBe(true)
    expect(native.valueInWei).toBe(10n ** 18n)
    const other = targetFor(baseValues, {})
    expect(other.isWrappedNative).toBe(false)
    expect(other.valueInWei).toBeNull()
    expect(targetFor(baseValues, price).valueInWei).toBe(400_000_000_000_000n)
  })
})

describe('buildDeliveryFeeModel', () => {
  test('percentage and fixed are exact, the gas multiplier is an estimate with its maximum', () => {
    const { suggestions } = readyModel(nativeState(nativeValues))
    if (suggestions.percentage.kind !== 'available' || suggestions.fixed.kind !== 'available' || suggestions.gasMultiplier.kind !== 'available') throw new Error('all three are available')
    expect(suggestions.percentage.description.certaintyLabel).toBe('exact')
    expect(suggestions.fixed.description.certaintyLabel).toBe('exact')
    expect(suggestions.gasMultiplier.description.certaintyLabel).toMatch(/^estimate, at most [\d.]+ zkbWETH$/)
  })

  test('the measured delivery gas of the callback kind is the p90, and the proof cost is a separate line', () => {
    const model = readyModel(stateFor(baseValues))
    expect(model.dataSource.description).toBe('measured from 40 recent deliveries, p90')
    expect(model.dataSource.gas).toBe(210_000n)
    expect(model.cost.gasCostWei).toBe(210_000n * (7_000_000_000n + 1_000_000_000n))
    expect(model.cost.proofCostWei).toBe(8_000_000_000_000n)
    expect(model.proofCostMissing).toBe(false)
  })

  test('a report with no samples uses the default gas and says so', () => {
    const empty = { ...report, kinds: { ...report.kinds, token_callback: { sampleCount: 0, averageGas: null, p90Gas: null, defaultGas: '300000', isDefault: true } } }
    const model = readyModel(stateFor(baseValues, price, empty))
    expect(model.dataSource.description).toBe('default, no deliveries measured yet')
    expect(model.dataSource.gas).toBe(300_000n)
  })

  test('with no native coin price the proof cost is left out and the model says so', () => {
    const unpriced = { ...report, proofCost: { ...report.proofCost, nativeCoinPriceUsd: null, wei: null } }
    const model = readyModel(stateFor(baseValues, price, unpriced))
    expect(model.proofCostMissing).toBe(true)
    expect(model.cost.proofCostWei).toBe(0n)
  })

  test('with no token price the cost based suggestions are off, the default tip stays, and typed numbers still work', () => {
    const blank = readyModel(stateFor(baseValues, {}))
    expect(blank.suggestions.percentage.kind).toBe('unavailable')
    expect(blank.suggestions.fixed.kind).toBe('unavailable')
    expect(blank.suggestions.gasMultiplier).toEqual({ kind: 'unavailable', mode: 'gas', reason: 'enter your price of the native coin in this token' })
    if (blank.chosen.kind !== 'ready') throw new Error('the default tip needs no price')
    expect(blank.chosen.director.multiplier).toBe(10n ** 15n)
    expect(readyModel(stateFor({ ...baseValues, feeMode: 'fixed' }, {})).chosen).toEqual({ kind: 'invalid', reason: 'no value of the token is configured, so the cost cannot be turned into tokens' })
    const typed = readyModel(stateFor({ ...baseValues, feeMode: 'fixed', feeFixed: '1.5' }, {}))
    if (typed.chosen.kind !== 'ready') throw new Error('a typed amount needs no price')
    expect(typed.chosen.director.limit).toBe(1_500_000n)
    expect(typed.chosen.description.summary).toBe('1.5 zkbUSDC (exact)')
  })

  test('a transfer too small to pay for its delivery makes the suggestion unavailable with the reason', () => {
    const { suggestions } = readyModel(stateFor({ ...baseValues, amount: '0.01' }))
    expect(suggestions?.percentage).toEqual({ kind: 'unavailable', mode: 'share', reason: 'the transfer is too small to pay for its delivery' })
  })

  test('an edited percentage rebuilds the director and the description', () => {
    const model = readyModel(stateFor({ ...baseValues, feePercent: '0.5' }))
    if (model.chosen.kind !== 'ready') throw new Error('0.5 percent is valid')
    expect(model.chosen.director).toEqual({ recipient: getAddress(receiver), settings: FEE_SETTING.shareOfValue, limit: 0n, multiplier: 5n * 10n ** 15n })
    expect(model.chosen.description.certaintyLabel).toBe('exact')
    expect(model.chosen.description.nowUnits).toBe(499_500n) // 0.5 percent of 99.9 zkbUSDC, rounded down
  })

  test('the recipient defaults to the receiver and can be changed', () => {
    const defaulted = readyModel(stateFor(baseValues)).chosen
    const other = '0x00000000000000000000000000000000000000d1'
    const changed = readyModel(stateFor({ ...baseValues, feeRecipient: other })).chosen
    if (defaulted.kind !== 'ready' || changed.kind !== 'ready') throw new Error('both are valid')
    expect(defaulted.director.recipient.toLowerCase()).toBe(receiver)
    expect(changed.director.recipient.toLowerCase()).toBe(other)
  })

  test('refuses a percentage above 100 and a garbled number with a reason', () => {
    const over = readyModel(stateFor({ ...baseValues, feePercent: '101' })).chosen
    expect(over).toEqual({ kind: 'invalid', reason: 'The percentage is above 100 percent.' })
    const garbled = readyModel(stateFor({ ...baseValues, feeFixed: 'abc', feeMode: 'fixed' })).chosen
    expect(garbled.kind === 'invalid' && garbled.reason).toContain('The fixed amount is not valid')
  })

  test('refuses a fixed amount above 256 bits with a reason instead of crashing', () => {
    const huge = readyModel(stateFor({ ...baseValues, feeFixed: `1${'0'.repeat(80)}`, feeMode: 'fixed' })).chosen
    expect(huge).toEqual({ kind: 'invalid', reason: 'The fixed amount is too large: it must fit in 256 bits.' })
  })

  test('the gas multiplier mode uses the typed multiplier and the base fee ceiling as the cap', () => {
    const low = readyModel(nativeState({ ...nativeValues, feeMode: 'gas', feeMultiplier: '1.2', feeCeilingGwei: '14' })).chosen
    const high = readyModel(nativeState({ ...nativeValues, feeMode: 'gas', feeMultiplier: '1.2', feeCeilingGwei: '28' })).chosen
    if (low.kind !== 'ready' || high.kind !== 'ready') throw new Error('both are valid')
    expect(feeModeOf(low.director.settings)).toBe('gas')
    expect(low.director.multiplier).toBe(12n * 10n ** 17n)
    expect(high.director.limit).toBeGreaterThan(low.director.limit)
  })

  test('the gas multiplier works for any token: the price of the valuation is folded into the multiplier', () => {
    // One zkbUSDC is worth 4e14 wei, so one wei is worth 1e6 / 4e14 units. With the margin 1.2 the multiplier is 3e9.
    const model = readyModel(stateFor({ ...baseValues, feeMode: 'gas', feeMultiplier: '1.2' }))
    expect(model.suggestions.gasMultiplier.kind).toBe('available')
    if (model.chosen.kind !== 'ready') throw new Error('the valuation gives a price')
    expect(model.chosen.director.multiplier).toBe(3_000_000_000n)
    expect(model.chosen.description.certainty).toBe('estimate')
  })

  test('the price of the sender replaces the valuation, and works with no valuation at all', () => {
    // The sender says one whole native coin is worth 2,500 zkbUSDC: 2,500e6 units for 1e18 wei. Margin 1.0.
    const typed = { ...baseValues, feeMode: 'gas', feeMultiplier: '1', feeSenderPrice: '2500' }
    for (const valuations of [price, {}]) {
      const model = readyModel(stateFor(typed, valuations))
      if (model.chosen.kind !== 'ready') throw new Error('the sender gave a price')
      expect(model.chosen.director.multiplier).toBe(2_500_000_000n)
    }
    const garbled = readyModel(stateFor({ ...typed, feeSenderPrice: 'abc' })).chosen
    expect(garbled.kind === 'invalid' && garbled.reason).toContain('your price is not valid')
  })

  test('the router is the one of the deployment unless the form names another', () => {
    expect(readyModel(stateFor(baseValues)).router).toBe(FIXTURE_PAIR.second.contracts.feeRouter!)
    const other = '0x00000000000000000000000000000000000000f7'
    expect(readyModel(stateFor({ ...baseValues, feeRouter: other })).router).toBe(getAddress(other))
    const bad = stateFor({ ...baseValues, feeRouter: 'abc' })
    expect(bad.kind === 'unavailable' && bad.reason).toContain('router')
  })

  test('the default tip is 0.1 percent', () => {
    const chosen = readyModel(stateFor(baseValues)).chosen
    if (chosen.kind !== 'ready') throw new Error('valid')
    expect(chosen.director).toEqual({ recipient: getAddress(receiver), settings: FEE_SETTING.shareOfValue, limit: 0n, multiplier: 10n ** 15n })
    expect(chosen.description.nowUnits).toBe(99_900n)
  })

  test('needs an amount before it can say anything', () => {
    expect(buildDeliveryFeeModel({ values: baseValues, target: targetFor(baseValues), report, transferValue: null })).toEqual({ kind: 'needs-amount' })
  })

  test('a report with no base fee yet is reported as unavailable, not thrown', () => {
    const noBlock = { ...report, baseFee: { wei: null, blockNumber: null, timestamp: null } }
    const state = stateFor(baseValues, price, noBlock)
    expect(state.kind === 'unavailable' && state.reason).toContain('no base fee')
  })
})

describe('refillDeliveryFee', () => {
  const context = { stateFor: (values: Values) => ({ state: stateFor(values), target: targetFor(values) }) }

  test('choosing the percentage mode fills the default tip, and the filled number rebuilds the same fee', () => {
    const next = refillDeliveryFee({ ...baseValues, delivery: 'yes', feeMode: 'fixed' }, { ...baseValues, delivery: 'yes', feeMode: 'percentage' }, context)
    expect(next.feePercent).toBe('0.1')
    const typed = readyModel(stateFor(next)).chosen
    if (typed.kind !== 'ready') throw new Error('valid')
    expect(typed.director.multiplier).toBe(10n ** 15n)
  })

  test('changing the amount keeps the percentage that the user typed', () => {
    const before = { ...baseValues, delivery: 'yes', feeMode: 'percentage', feePercent: '0.7' }
    expect(refillDeliveryFee(before, { ...before, amount: '250' }, context).feePercent).toBe('0.7')
  })

  test('choosing the gas multiplier fills the margin, the ceiling and the price of the valuation as the sender price', () => {
    const next = refillDeliveryFee({ ...baseValues, delivery: 'yes', feeMode: 'percentage' }, { ...baseValues, delivery: 'yes', feeMode: 'gas' }, context)
    expect(next.feeMultiplier).toBe('1.2')
    expect(next.feeSenderPrice).toBe('2500') // one zkbUSDC is worth 4e14 wei, so one coin is worth 2,500
    expect(next.feeCeilingGwei).toBe('14')
  })

  test('editing a number alone does not refill it', () => {
    const before = { ...baseValues, delivery: 'yes', feePercent: '1' }
    expect(refillDeliveryFee(before, { ...before, feePercent: '2' }, context).feePercent).toBe('2')
  })

  test('changing the margin refills the fixed amount', () => {
    const before = { ...baseValues, delivery: 'yes', feeMode: 'fixed', feeFixed: '1' }
    const next = refillDeliveryFee(before, { ...before, feeMargin: '50' }, context)
    expect(next.feeFixed).toBe('6.33') // the cost is 4.22 zkbUSDC, plus 50 percent
  })

  test('does nothing when the user pays nothing', () => {
    const before = { ...baseValues, delivery: 'no', feeMode: 'fixed' }
    const next = { ...before, feeMode: 'percentage' }
    expect(refillDeliveryFee(before, next, context)).toBe(next)
  })

  test('switching to custom starts from the terms of the mode just left', () => {
    const before = { ...baseValues, delivery: 'yes', feeMode: 'percentage', feePercent: '0.5' }
    const next = refillDeliveryFee(before, { ...before, feeMode: 'custom' }, context)
    expect(next.feeCustomKind).toBe('share')
    expect(next.feeCustomMultiplier).toBe('0.005')
  })

  test('custom terms round trip through the director', () => {
    const director = { recipient: receiver as `0x${string}`, settings: FEE_SETTING.fixedFee | FEE_SETTING.baseFeeOnly, limit: 2_000_000n, multiplier: 0n }
    expect(customFieldsOf(director, 6).feeCustomBasis).toBe('base-fee-only')
    expect(decodeFeeDirector(encodeFeeDirector(director))).toEqual({ ...director, recipient: getAddress(receiver) })
  })
})
