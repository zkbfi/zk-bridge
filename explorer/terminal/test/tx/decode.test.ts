import { describe, expect, test } from 'bun:test'
import { encodeFunctionData, keccak256, parseAbi, type Hex } from 'viem'
import { decodeKnownCall, selectorOf } from '../../src/tx/decode'

const bytesAbi = parseAbi(['function store(bytes data)'])

describe('selectorOf', () => {
  test('is the first four bytes, and null for data that is shorter', () => {
    expect(selectorOf('0x12345678abcd')).toBe('0x12345678')
    expect(selectorOf('0x12345678')).toBe('0x12345678')
    expect(selectorOf('0x123456')).toBeNull()
  })
})

describe('decodeKnownCall', () => {
  test('a long byte string shows its start, its length and its digest', () => {
    const payload: Hex = `0x${'ab'.repeat(40)}`
    const data = encodeFunctionData({ abi: bytesAbi, functionName: 'store', args: [payload] })
    const decoded = decodeKnownCall(data, [bytesAbi])
    expect(decoded?.arguments).toEqual([
      { name: 'data', type: 'bytes', meaning: '40 bytes', value: `${payload.slice(0, 34)}… keccak256 ${keccak256(payload)}` },
    ])
  })

  test('a short byte string shows in full with its length', () => {
    const data = encodeFunctionData({ abi: bytesAbi, functionName: 'store', args: ['0xabcdef'] })
    expect(decodeKnownCall(data, [bytesAbi])?.arguments).toEqual([{ name: 'data', type: 'bytes', meaning: '3 bytes', value: '0xabcdef' }])
  })

  test('a byte string of exactly the display limit shows in full', () => {
    const payload: Hex = `0x${'cd'.repeat(32)}`
    const data = encodeFunctionData({ abi: bytesAbi, functionName: 'store', args: [payload] })
    expect(decodeKnownCall(data, [bytesAbi])?.arguments[0]?.value).toBe(payload)
  })

  test('a known selector with arguments that do not decode gives null, not a wrong reading', () => {
    const data = encodeFunctionData({ abi: bytesAbi, functionName: 'store', args: ['0xabcdef'] })
    expect(decodeKnownCall(data.slice(0, 20) as Hex, [bytesAbi])).toBeNull()
  })

  test('an unknown selector and data shorter than a selector give null', () => {
    expect(decodeKnownCall('0xdeadbeef', [bytesAbi])).toBeNull()
    expect(decodeKnownCall('0x1234', [bytesAbi])).toBeNull()
  })
})
