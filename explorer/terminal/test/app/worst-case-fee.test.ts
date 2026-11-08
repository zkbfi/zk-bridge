import { describe, expect, test } from 'bun:test'
import { EXCLUDE_PRIORITY, describeFee, settingsOf, worstCaseFee, type DescribeFeeInput, type FeeDirector } from '@zk-bridge/shared'
import { describeFeeAtWorstCase } from '../../src/app/worst-case-fee'

const recipient = '0x00000000000000000000000000000000000000d1'
const token = { symbol: 'USDC', decimals: 6, valueInWei: 10n ** 15n }
const input: DescribeFeeInput = {
  transferValue: 1_000_000_000n,
  token,
  gasUsed: 400_000n,
  baseFeeWei: 10n ** 9n,
  priorityFeeWei: 2n * 10n ** 9n,
  cost: null,
}
const gasDirector = (extra: Partial<FeeDirector> = {}): FeeDirector => ({
  recipient,
  settings: settingsOf({ mode: 'gas' }),
  limit: 900_000_000n,
  multiplier: 10n ** 9n,
  callGas: 0n,
  ...extra,
})

describe('describeFeeAtWorstCase', () => {
  test('a fixed fee and a share are exact, so the description is the one of describeFee', () => {
    const fixed: FeeDirector = { recipient, settings: settingsOf({ mode: 'fixed' }), limit: 5_000_000n, multiplier: 0n, callGas: 0n }
    const share: FeeDirector = { recipient, settings: settingsOf({ mode: 'share' }), limit: 0n, multiplier: 10n ** 15n, callGas: 0n }
    for (const director of [fixed, share]) {
      const described = describeFeeAtWorstCase(director, input)
      expect(described).toEqual({ ...describeFee(director, input), expectedUnits: described.maximumUnits })
    }
  })

  test('a gas based fee takes its expected tip from worstCaseFee at the gas price now, keeps the limit as the maximum, and says both in the label', () => {
    const director = gasDirector()
    const described = describeFeeAtWorstCase(director, input)
    const expected = worstCaseFee(director, { value: input.transferValue, deliveryGas: 400_000n, gasPrice: 3n * 10n ** 9n, payout: 'token', withCall: false })
    expect(described.expectedUnits).toBe(expected)
    expect(described.maximumUnits).toBe(director.limit)
    expect(described.expectedUnits).toBeGreaterThanOrEqual(described.nowUnits)
    expect(described.certaintyLabel).toBe(`estimate, expected about ${Number(expected) / 1e6} USDC, at most ${Number(director.limit) / 1e6} USDC`)
    expect(described.summary).toBe(`${described.amountText} (${described.certaintyLabel})`)
  })

  test('the call gas counts: a director with a call has a higher expected tip than the same one with none', () => {
    const without = describeFeeAtWorstCase(gasDirector(), input)
    const withCall = describeFeeAtWorstCase(gasDirector({ callGas: 200_000n }), input)
    expect(withCall.expectedUnits).toBeGreaterThan(without.expectedUnits)
  })

  test('the base fee only flag leaves the priority fee out of the gas price, and the native payout adds its own overhead', () => {
    const baseOnly = gasDirector({ settings: settingsOf({ mode: 'gas', gasPrice: 'base-fee-only' }) })
    expect(baseOnly.settings & EXCLUDE_PRIORITY).toBe(EXCLUDE_PRIORITY)
    const cheap = describeFeeAtWorstCase(baseOnly, input)
    const full = describeFeeAtWorstCase(gasDirector(), input)
    expect(cheap.expectedUnits).toBeLessThan(full.expectedUnits)
    const native = describeFeeAtWorstCase(gasDirector({ settings: settingsOf({ mode: 'gas', payout: 'native' }) }), { ...input, payout: 'native' })
    expect(native.expectedUnits).toBe(worstCaseFee(gasDirector({ settings: settingsOf({ mode: 'gas', payout: 'native' }) }), { value: input.transferValue, deliveryGas: 400_000n, gasPrice: 3n * 10n ** 9n, payout: 'native', withCall: false }))
  })

  test('the limit is the ceiling of both the expected tip and the maximum', () => {
    const tight = describeFeeAtWorstCase(gasDirector({ limit: 1_000n }), input)
    expect(tight.expectedUnits).toBe(1_000n)
    expect(tight.maximumUnits).toBe(1_000n)
  })
})
