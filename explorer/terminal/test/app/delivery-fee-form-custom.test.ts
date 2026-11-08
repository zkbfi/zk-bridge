import { describe, expect, test } from 'bun:test'
import { settingsOf } from '@zk-bridge/shared'
import { getAddress } from 'viem'
import { bridgeSourceOf } from '../../src/app/actions'
import {
  buildDeliveryFeeModel,
  resolveDeliveryTarget,
  transferValueOf,
  type DeliveryFeeState,
  type DeliveryTarget,
  type Values,
} from '../../src/app/delivery-fee-form'
import { FIXTURE_NOW, FIXTURE_PAIR, FIXTURE_TOKENS, buildFixtureDeliveryCost } from '../../src/data/fixtures'

const usdc = FIXTURE_TOKENS[0]!
const zkUsdc = FIXTURE_TOKENS[1]!
const receiver = '0x0000000000000000000000000000000000000abc'
const customValues: Values = { token: `first:${usdc.address}`, amount: '100', receiver, feeMode: 'custom' }
const price = { [zkUsdc.address.toLowerCase()]: 400_000_000_000_000n }
const report = buildFixtureDeliveryCost(369, FIXTURE_NOW)

function targetFor(values: Values): DeliveryTarget {
  const resolved = resolveDeliveryTarget({ source: bridgeSourceOf(values, FIXTURE_TOKENS, FIXTURE_PAIR), pair: FIXTURE_PAIR, tokens: FIXTURE_TOKENS, valuations: price })
  if (resolved.kind !== 'ready') throw new Error(resolved.reason)
  return resolved.target
}

function stateFor(values: Values, reportOverride = report): DeliveryFeeState {
  const target = targetFor(values)
  return buildDeliveryFeeModel({ values, target, report: reportOverride, transferValue: transferValueOf(values.amount ?? '', target.token.decimals) })
}

function chosenOf(values: Values) {
  const state = stateFor(values)
  if (state.kind !== 'ready') throw new Error(`state is ${state.kind}`)
  return state.model.chosen
}

describe('a custom fee', () => {
  test('a fixed fee is the typed limit with no multiplier', () => {
    const chosen = chosenOf({ ...customValues, feeCustomKind: 'fixed', feeCustomLimit: '2.5' })
    if (chosen.kind !== 'ready') throw new Error(`chosen is ${chosen.kind}`)
    expect(chosen.mode).toBe('custom')
    expect(chosen.director).toEqual({ recipient: getAddress(receiver), settings: settingsOf({ mode: 'fixed' }), limit: 2_500_000n, multiplier: 0n, callGas: 0n })
  })

  test('with no kind chosen the kind is fixed, and a blank limit is zero', () => {
    const chosen = chosenOf(customValues)
    if (chosen.kind !== 'ready') throw new Error(`chosen is ${chosen.kind}`)
    expect(chosen.director).toEqual({ recipient: getAddress(receiver), settings: settingsOf({ mode: 'fixed' }), limit: 0n, multiplier: 0n, callGas: 0n })
  })

  test('a share keeps the multiplier, drops the limit, and allows exactly one', () => {
    const half = chosenOf({ ...customValues, feeCustomKind: 'share', feeCustomMultiplier: '0.5', feeCustomLimit: '9' })
    if (half.kind !== 'ready') throw new Error(`chosen is ${half.kind}`)
    expect(half.director).toEqual({ recipient: getAddress(receiver), settings: settingsOf({ mode: 'share' }), limit: 0n, multiplier: 5n * 10n ** 17n, callGas: 0n })
    const whole = chosenOf({ ...customValues, feeCustomKind: 'share', feeCustomMultiplier: '1' })
    expect(whole.kind).toBe('ready')
  })

  test('a share above one is refused with the reason', () => {
    expect(chosenOf({ ...customValues, feeCustomKind: 'share', feeCustomMultiplier: '1.000000000000000001' })).toEqual({
      kind: 'invalid',
      reason: 'The multiplier of a share is above 1, which is above 100 percent.',
    })
  })

  test('a gas based fee keeps the limit and the multiplier, and the basis sets the flag', () => {
    const transaction = chosenOf({ ...customValues, feeCustomKind: 'gas', feeCustomMultiplier: '1.2', feeCustomLimit: '3', feeCustomBasis: 'transaction' })
    if (transaction.kind !== 'ready') throw new Error(`chosen is ${transaction.kind}`)
    expect(transaction.director).toEqual({ recipient: getAddress(receiver), settings: 0n, limit: 3_000_000n, multiplier: 12n * 10n ** 17n, callGas: 0n })
    const baseOnly = chosenOf({ ...customValues, feeCustomKind: 'gas', feeCustomMultiplier: '1.2', feeCustomBasis: 'base-fee-only' })
    if (baseOnly.kind !== 'ready') throw new Error(`chosen is ${baseOnly.kind}`)
    expect(baseOnly.director.settings).toBe(settingsOf({ mode: 'gas', gasPrice: 'base-fee-only' }))
  })

  test('a gas based fee with no basis chosen reads the base fee only, because the destination chain reports a base fee', () => {
    const chosen = chosenOf({ ...customValues, feeCustomKind: 'gas', feeCustomMultiplier: '1.2' })
    if (chosen.kind !== 'ready') throw new Error(`chosen is ${chosen.kind}`)
    expect(chosen.director.settings).toBe(settingsOf({ mode: 'gas', gasPrice: 'base-fee-only' }))
  })

  test('a gas based fee needs a multiplier above zero', () => {
    expect(chosenOf({ ...customValues, feeCustomKind: 'gas' })).toEqual({ kind: 'invalid', reason: 'The multiplier of a gas based fee must be above zero.' })
  })

  test('a limit or a multiplier that is not a number names the field', () => {
    expect(chosenOf({ ...customValues, feeCustomLimit: 'abc' })).toEqual({ kind: 'invalid', reason: 'The limit is not valid: "abc" is not a decimal number.' })
    expect(chosenOf({ ...customValues, feeCustomMultiplier: '1e3' })).toEqual({ kind: 'invalid', reason: 'The multiplier is not valid: "1e3" is not a decimal number.' })
  })
})

describe('a field that is not valid', () => {
  test('a margin that is not a percentage makes the whole panel unavailable with the field named', () => {
    expect(stateFor({ ...customValues, feeMode: 'percentage', feeMargin: 'ten' })).toEqual({
      kind: 'unavailable',
      reason: 'The margin is not valid: "ten" is not a decimal number.',
    })
  })

  test('a margin with more digits than a percentage holds is refused with the count', () => {
    const state = stateFor({ ...customValues, feeMargin: '0.12345678901234567' })
    expect(state).toEqual({ kind: 'unavailable', reason: 'The margin is not valid: "0.12345678901234567" has more than 16 fraction digits.' })
  })

  test('a token with impossible decimals is reported as a range error, not as a typing error', () => {
    const target = { ...targetFor(customValues), token: { symbol: 'BAD', decimals: 300 } }
    const state = buildDeliveryFeeModel({ values: { ...customValues, feeMode: 'fixed', feeFixed: '1' }, target, report, transferValue: 1_000_000n })
    if (state.kind !== 'ready') throw new Error(`state is ${state.kind}`)
    expect(state.model.chosen).toEqual({ kind: 'invalid', reason: 'decimals must be an integer from 0 to 255, got 300' })
  })

  test('a report that the indexer filled with text that is not a number is a fault, not a message for the user', () => {
    const broken = { ...report, kinds: { ...report.kinds, token_callback: { ...report.kinds.token_callback, p90Gas: 'lots' } } }
    expect(() => stateFor({ ...customValues, feeMode: 'percentage' }, broken)).toThrow(SyntaxError)
  })
})
