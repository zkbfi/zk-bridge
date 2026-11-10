import { describe, expect, test } from 'bun:test'
import { buildPairConfig } from '../../src/config/pairs'

const section = (chainId: number, startBlock: unknown) => {
  const address = `0x${String(chainId % 10).repeat(40)}`
  return { chain_id: chainId, bridge: address, mediator: address, light_client: address, start_block: startBlock }
}

describe('the start block of a chain', () => {
  test('comes from start_block of the deployment file', () => {
    const pair = buildPairConfig('eth-pls', { a: section(1, 19_000_000), b: section(369, 17_500_000) })
    expect([pair.first.startBlock, pair.second.startBlock]).toEqual([19_000_000, 17_500_000])
  })

  test('carries light_client_start_block when the file names one, and nothing otherwise', () => {
    const pair = buildPairConfig('eth-pls', { a: { ...section(1, 900), light_client_start_block: 100 }, b: section(369, 17_500_000) })
    expect(pair.first.lightClientStartBlock).toBe(100)
    expect(pair.second.lightClientStartBlock).toBeUndefined()
  })

  test('is absent when the file gives no whole non-negative number, so nothing guesses a block', () => {
    for (const value of [undefined, 'x', -1, 1.5]) {
      const pair = buildPairConfig('eth-pls', { a: section(1, value), b: section(369, value) })
      expect(pair.first.startBlock).toBeUndefined()
    }
  })
})
