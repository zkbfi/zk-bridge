import { describe, expect, test } from 'bun:test'
import { formatAge } from '../../src/format/text'

describe('formatAge', () => {
  test('picks the largest whole unit and cuts the rest', () => {
    expect(formatAge(1_000, 988)).toBe('12s ago')
    expect(formatAge(1_000, 1_000 - 59)).toBe('59s ago')
    expect(formatAge(10_000, 10_000 - 60)).toBe('1m ago')
    expect(formatAge(10_000, 10_000 - 3_599)).toBe('59m ago')
    expect(formatAge(100_000, 100_000 - 3_600)).toBe('1h ago')
    expect(formatAge(100_000, 100_000 - 86_399)).toBe('23h ago')
    expect(formatAge(1_000_000, 1_000_000 - 86_400)).toBe('1d ago')
    expect(formatAge(1_000_000, 1_000_000 - 3 * 86_400 - 5_000)).toBe('3d ago')
  })

  test('an event in the future counts as zero seconds old', () => {
    expect(formatAge(1_000, 2_000)).toBe('0s ago')
  })
})
