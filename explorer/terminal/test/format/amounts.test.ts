import { describe, expect, test } from 'bun:test'
import {
  AmountParseError,
  RATE_SCALE,
  feeOf,
  formatRateAsPercent,
  formatUnits,
  parsePercentAsRate,
  parseUnits,
} from '../../src/format/amounts'

describe('formatUnits', () => {
  test('formats base units without losing a digit beyond 2^53', () => {
    // 2^53 + 1 cannot be held by a number. A bigint path must keep every digit.
    const value = 9_007_199_254_740_993n
    expect(formatUnits(value, 0)).toBe('9007199254740993')
    expect(formatUnits(value, 6)).toBe('9007199254.740993')
  })

  test('removes trailing zeros of the fraction and keeps a whole number whole', () => {
    expect(formatUnits(1_500_000n, 6)).toBe('1.5')
    expect(formatUnits(2_000_000n, 6)).toBe('2')
    expect(formatUnits(5n, 6)).toBe('0.000005')
  })

  test('cuts toward zero when a digit limit is set, so the display never exceeds the stored value', () => {
    expect(formatUnits(1_999_999n, 6, { maximumFractionDigits: 2 })).toBe('1.99')
    expect(formatUnits(999_999_999_999_999_999n, 18, { maximumFractionDigits: 4 })).toBe('0.9999')
  })

  test('formats negative values and groups thousands', () => {
    expect(formatUnits(-1_250_000n, 6)).toBe('-1.25')
    expect(formatUnits(-1n, 6, { maximumFractionDigits: 2 })).toBe('0')
    expect(formatUnits(1_234_567_890_000n, 6, { groupThousands: true })).toBe('1,234,567.89')
  })

  test('rejects decimals outside 0 to 255', () => {
    expect(() => formatUnits(1n, -1)).toThrow(RangeError)
    expect(() => formatUnits(1n, 256)).toThrow(RangeError)
    expect(() => formatUnits(1n, 1.5)).toThrow(RangeError)
  })
})

describe('parseUnits', () => {
  test('is the exact inverse of formatUnits', () => {
    for (const value of [0n, 1n, 999_999n, 10n ** 18n + 1n, 2n ** 200n]) {
      expect(parseUnits(formatUnits(value, 18), 18)).toBe(value)
    }
  })

  test('accepts a leading or trailing point and refuses extra digits, signs and exponents', () => {
    expect(parseUnits('.5', 6)).toBe(500_000n)
    expect(parseUnits('5.', 6)).toBe(5_000_000n)
    expect(() => parseUnits('1.0000001', 6)).toThrow(AmountParseError)
    expect(() => parseUnits('-1', 6)).toThrow(AmountParseError)
    expect(() => parseUnits('1e3', 6)).toThrow(AmountParseError)
    expect(() => parseUnits('', 6)).toThrow(AmountParseError)
    expect(() => parseUnits('1,000', 6)).toThrow(AmountParseError)
  })
})

describe('rates', () => {
  test('1e18 is 100 percent and the scale shifts the point by sixteen places', () => {
    expect(formatRateAsPercent(RATE_SCALE)).toBe('100%')
    expect(formatRateAsPercent(10n ** 16n)).toBe('1%')
    expect(formatRateAsPercent(10n ** 15n)).toBe('0.1%')
    expect(formatRateAsPercent(0n)).toBe('0%')
  })

  test('loses nothing on a rate of one unit', () => {
    expect(formatRateAsPercent(1n)).toBe('0.0000000000000001%')
    expect(formatRateAsPercent(123_456_789_012_345_678n)).toBe('12.3456789012345678%')
  })

  test('parsePercentAsRate reads what formatRateAsPercent writes', () => {
    for (const rate of [0n, 1n, 10n ** 15n, 10n ** 16n, 123_456_789_012_345_678n]) {
      expect(parsePercentAsRate(formatRateAsPercent(rate))).toBe(rate)
    }
    expect(() => parsePercentAsRate('0.12345678901234567')).toThrow(AmountParseError)
  })

  test('feeOf cuts toward zero as the mediator does', () => {
    expect(feeOf(1_000_000n, 10n ** 15n)).toBe(1_000n)
    expect(feeOf(999n, 10n ** 15n)).toBe(0n)
    expect(feeOf(10n ** 30n + 1n, 10n ** 16n)).toBe(10n ** 28n)
  })
})
