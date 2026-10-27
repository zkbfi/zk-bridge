import { describe, expect, test } from 'bun:test'
import { settingsOf } from '@zk-bridge/shared'
import { bridgeSourceOf } from '../../src/app/actions'
import { buildDeliveryFeeModel, resolveDeliveryTarget, type Values } from '../../src/app/delivery-fee-form'
import { FIXTURE_NOW, FIXTURE_PAIR, FIXTURE_TOKENS, buildFixtureDeliveryCost } from '../../src/data/fixtures'
import { deliveryPanelLines, feeFlagsInWords, limitInWords, multiplierInWords } from '../../src/ui/delivery-fee-lines'
import { lineText } from '../../src/ui/rich-text'

const usdc = FIXTURE_TOKENS[0]!
const zkUsdc = FIXTURE_TOKENS[1]!
const values: Values = { token: `first:${usdc.address}`, amount: '100', receiver: '0x00000000000000000000000000000000000000d1', feeMode: 'percentage', feeMargin: '10', feePriorityGwei: '1' }
const report = buildFixtureDeliveryCost(369, FIXTURE_NOW)

function panel(overrides: { values?: Values; priced?: boolean; report?: typeof report; transferValue?: bigint } = {}): string {
  const used = overrides.values ?? values
  const resolved = resolveDeliveryTarget({
    source: bridgeSourceOf(used, FIXTURE_TOKENS, FIXTURE_PAIR),
    pair: FIXTURE_PAIR,
    tokens: FIXTURE_TOKENS,
    valuations: overrides.priced === false ? {} : { [zkUsdc.address.toLowerCase()]: 400_000_000_000_000n },
  })
  if (resolved.kind !== 'ready') throw new Error(resolved.reason)
  const state = buildDeliveryFeeModel({ values: used, target: resolved.target, report: overrides.report ?? report, transferValue: overrides.transferValue ?? 99_900_000n })
  return deliveryPanelLines({ kind: 'state', state, target: resolved.target }).map(lineText).join('\n')
}

describe('the live panel of the bridge form', () => {
  test('shows the router, the gas with its data source, the base fee, the cost split, and each suggestion with its label', () => {
    expect(panel()).toBe(
      [
        'Delivery cost on PulseChain',
        'Router          0x0000000000000000000000000000000000000Aa2 (the default delivery router)',
        'Gas             210000 gas, measured from 40 recent deliveries, p90',
        'Base fee        7 gwei at block 21000000 (2026-10-25T11:59:48.000Z)',
        'Cost            gas 0.00168 PLS + proof 0.000008 PLS + margin -0.00164804 PLS',
        'Percentage      4.642 zkbUSDC (exact)  (4.6466466466466467 percent of the transfer)',
        'Fixed           4.642 zkbUSDC (exact)  (a fixed amount)',
        "Gas multiplier  about 10.85 zkbUSDC now (estimate, at most 21.7 zkbUSDC)  (the gas that the deliverer's transaction makes available times the gas price, at 0.000000005 token units for each wei (your price and margin), never above the limit. Expect the tip to reach the limit)",
        'Tip mode        percentage of the transfer',
        'Your tip        0.0999 zkbUSDC (exact)',
        'At most         0.0999 zkbUSDC',
      ].join('\n'),
    )
  })

  test('a default data source says that no deliveries are measured', () => {
    const empty = { ...report, kinds: { ...report.kinds, token_callback: { sampleCount: 0, averageGas: null, p90Gas: null, defaultGas: '300000', isDefault: true } } }
    expect(panel({ report: empty })).toContain('Gas             300000 gas, default, no deliveries measured yet')
  })

  test('says that the proof cost is not included when no native coin price is configured', () => {
    const unpriced = { ...report, proofCost: { ...report.proofCost, nativeCoinPriceUsd: null, wei: null } }
    const text = panel({ report: unpriced })
    expect(text).toContain('The proof cost is not included: no native coin price is configured.')
    expect(text).not.toContain('proof 0')
  })

  test('with no price of the token the cost based suggestions say so, and the default tip still stands', () => {
    const text = panel({ priced: false })
    expect(text).toContain('Percentage      unavailable: no value of the token is configured')
    expect(text).toContain('Gas multiplier  unavailable: enter your price of the native coin in this token')
    expect(text).toContain('Your tip        0.0999 zkbUSDC (exact)')
  })

  test('an unavailable suggestion shows its reason', () => {
    expect(panel({ transferValue: 9_990n })).toContain('Percentage      unavailable: the transfer is too small to pay for its delivery')
  })

  test('gas mode on a token that is not the native coin is an estimate, priced from the sender price', () => {
    const text = panel({ values: { ...values, feeMode: 'gas' } })
    expect(text).toMatch(/Your tip {8}about [\d.]+ zkbUSDC now \(estimate, at most [\d.]+ zkbUSDC\)/)
  })

  test('the wrapped native token gets the estimate label with its maximum', () => {
    const weth = FIXTURE_TOKENS[2]!
    const zkWeth = FIXTURE_TOKENS[3]!
    const pair = { ...FIXTURE_PAIR, second: { ...FIXTURE_PAIR.second, contracts: { ...FIXTURE_PAIR.second.contracts, wrappedNative: zkWeth.address } } }
    const used = { ...values, token: `first:${weth.address}`, feeMode: 'gas' }
    const resolved = resolveDeliveryTarget({ source: bridgeSourceOf(used, FIXTURE_TOKENS, pair), pair, tokens: FIXTURE_TOKENS, valuations: {} })
    if (resolved.kind !== 'ready') throw new Error(resolved.reason)
    const state = buildDeliveryFeeModel({ values: used, target: resolved.target, report, transferValue: 10n ** 18n })
    const text = deliveryPanelLines({ kind: 'state', state, target: resolved.target }).map(lineText).join('\n')
    expect(text).toMatch(/Your tip {8}about [\d.]+ zkbWETH now \(estimate, at most [\d.]+ zkbWETH\)/)
  })

  test('loading, failed and missing amount are stated plainly', () => {
    expect(deliveryPanelLines({ kind: 'loading', chainName: 'PulseChain' }).map(lineText)).toContain('Reading the delivery cost of PulseChain from the indexer…')
    expect(deliveryPanelLines({ kind: 'failed', chainName: 'PulseChain', reason: 'boom' }).map(lineText).join('\n')).toContain('could not be read: boom')
  })
})

describe('words for the terms of a director', () => {
  const director = { recipient: '0x00000000000000000000000000000000000000d1' as const, limit: 2_500_000n }
  test('flags, multiplier and limit are written out', () => {
    expect(feeFlagsInWords(0n)).toBe('none (gas based fee, paid in the token)')
    expect(feeFlagsInWords(settingsOf({ mode: 'fixed', payout: 'native' }))).toBe('fixed fee, paid in the native coin')
    expect(feeFlagsInWords(settingsOf({ mode: 'gas', gasPrice: 'base-fee-only' }))).toBe('gas priced at the base fee only')
    expect(multiplierInWords({ ...director, settings: 0n, multiplier: 3_600_000_000n })).toBe('0.0000000036 token units for each wei of gas cost (your price and margin are folded in)')
    expect(multiplierInWords({ ...director, settings: settingsOf({ mode: 'share' }), multiplier: 5n * 10n ** 15n })).toBe('0.5% of the transfer')
    expect(limitInWords({ ...director, settings: 0n, multiplier: 1n }, { symbol: 'USDC', decimals: 6 })).toBe('2.5 USDC (price ceiling: the most the tip can be)')
  })
})
