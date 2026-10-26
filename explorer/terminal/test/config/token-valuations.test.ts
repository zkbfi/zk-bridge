import { describe, expect, test } from 'bun:test'
import { TokenValuationsError, parseTokenValuations } from '../../src/config/token-valuations'

describe('parseTokenValuations', () => {
  test('is empty when the variable is not set', () => {
    expect(parseTokenValuations(undefined)).toEqual({})
    expect(parseTokenValuations('  ')).toEqual({})
  })

  test('keys the prices by lowercase address and reads the wei as bigint', () => {
    const prices = parseTokenValuations('{"0x00000000000000000000000000000000000000D1":"400000000000000"}')
    expect(prices).toEqual({ '0x00000000000000000000000000000000000000d1': 400_000_000_000_000n })
  })

  test('refuses text that is not JSON, not an object, a bad address, or a value that is not above zero', () => {
    expect(() => parseTokenValuations('nope')).toThrow(TokenValuationsError)
    expect(() => parseTokenValuations('[]')).toThrow('must be a JSON object')
    expect(() => parseTokenValuations('{"0x12":"1"}')).toThrow('is not an address')
    expect(() => parseTokenValuations('{"0x00000000000000000000000000000000000000d1":"0"}')).toThrow('above zero')
    expect(() => parseTokenValuations('{"0x00000000000000000000000000000000000000d1":5}')).toThrow('decimal text')
  })
})
