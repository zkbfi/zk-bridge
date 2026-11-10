/**
 * Exact formatting and parsing of token amounts and rates.
 *
 * Every amount is a `bigint` in base units. These functions never convert to `number`, so no value loses precision.
 */

import { RATE_SCALE } from '@zk-bridge/shared'

// The scale of a rate (`1e18` is 100 percent) lives in `@zk-bridge/shared`.
export { RATE_SCALE }

/** The number of decimal places that a percent needs to show a 1e18-scaled rate exactly (`rate / 1e16`). */
const PERCENT_DECIMALS = 16

/** Options for {@link formatUnits}. */
export interface FormatUnitsOptions {
  /** Keep at most this many fraction digits and cut the rest toward zero. Omit it to keep every digit. */
  readonly maximumFractionDigits?: number
  /** Put a comma between each group of three integer digits. */
  readonly groupThousands?: boolean
}

/** A decimal string was not valid for the requested number of decimals. */
export class AmountParseError extends Error {
  override readonly name = 'AmountParseError'
  constructor(message: string) {
    super(message)
  }
}

/**
 * Turns base units into a decimal string without any loss. Trailing zeros of the fraction are removed.
 *
 * @param value The amount in base units. It may be negative.
 * @param decimals The decimals of the token (0 to 255).
 * @param options Display options. With `maximumFractionDigits` the result is cut toward zero, never rounded up.
 * @returns For example `formatUnits(1500000n, 6)` is `"1.5"`.
 */
export function formatUnits(value: bigint, decimals: number, options: FormatUnitsOptions = {}): string {
  assertDecimals(decimals)
  const negative = value < 0n
  const magnitude = negative ? -value : value
  const divisor = 10n ** BigInt(decimals)
  const integerPart = magnitude / divisor
  const fractionDigits = decimals === 0 ? '' : (magnitude % divisor).toString().padStart(decimals, '0')
  const kept = options.maximumFractionDigits === undefined ? fractionDigits : fractionDigits.slice(0, options.maximumFractionDigits)
  const fraction = kept.replace(/0+$/, '')
  const integerText = options.groupThousands === true ? groupThousands(integerPart.toString()) : integerPart.toString()
  const sign = negative && (integerPart !== 0n || fraction !== '') ? '-' : ''
  return fraction === '' ? `${sign}${integerText}` : `${sign}${integerText}.${fraction}`
}

/**
 * Turns a decimal string into base units.
 *
 * @param text A plain decimal such as `"12"`, `"0.5"` or `".25"`. No sign, no exponent, no separators.
 * @param decimals The decimals of the token.
 * @throws AmountParseError when the text is not a decimal or has more fraction digits than `decimals`.
 */
export function parseUnits(text: string, decimals: number): bigint {
  assertDecimals(decimals)
  const trimmed = text.trim()
  if (!/^(\d+\.?\d*|\.\d+)$/.test(trimmed)) throw new AmountParseError(`"${text}" is not a decimal number`)
  const [integerText = '', fractionText = ''] = trimmed.split('.')
  if (fractionText.length > decimals) {
    throw new AmountParseError(`"${text}" has more than ${decimals} fraction digits`)
  }
  const digits = `${integerText === '' ? '0' : integerText}${fractionText.padEnd(decimals, '0')}`
  return BigInt(digits)
}

/**
 * Shows a 1e18-scaled rate as an exact percentage.
 *
 * A percentage is `rate / 1e16`, so the division is a shift of the decimal point and loses nothing.
 *
 * @example formatRateAsPercent(10n ** 16n) // "1%"
 * @example formatRateAsPercent(5n * 10n ** 15n) // "0.5%"
 */
export function formatRateAsPercent(rate: bigint): string {
  return `${formatUnits(rate, PERCENT_DECIMALS)}%`
}

/**
 * Reads a percentage such as `"0.25"` or `"0.25%"` as a 1e18-scaled rate.
 *
 * @throws AmountParseError when the text is not a percentage with at most 16 fraction digits.
 */
export function parsePercentAsRate(text: string): bigint {
  return parseUnits(text.trim().replace(/%$/, ''), PERCENT_DECIMALS)
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new RangeError(`decimals must be an integer from 0 to 255, got ${decimals}`)
  }
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}
