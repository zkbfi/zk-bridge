import { describe, expect, test } from 'bun:test'
import { DEFAULT_RPC_CHAIN_IDS, defaultRpcUrl, defaultRpcUrls } from '../../src/config/default-rpc'

describe('default RPCs', () => {
  test('every chain with a default starts with its valve.city demo URL, then the public RPCs', () => {
    for (const chainId of DEFAULT_RPC_CHAIN_IDS) {
      const urls = defaultRpcUrls(chainId)
      expect(urls[0]).toBe(`https://one.valve.city/rpc/vk_demo/evm/${chainId}`)
      expect(urls.length).toBeGreaterThan(1)
    }
  })

  test('the first default of a chain is its valve.city URL', () => {
    expect(defaultRpcUrl(369)).toBe('https://one.valve.city/rpc/vk_demo/evm/369')
  })

  test('a chain with no default has no URLs and no first URL', () => {
    expect(defaultRpcUrls(10)).toEqual([])
    expect(defaultRpcUrl(10)).toBeNull()
  })
})
