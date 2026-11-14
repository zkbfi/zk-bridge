import { describe, expect, test } from 'bun:test'
import { DEFAULT_RPC_CHAIN_IDS, defaultRpcUrl, defaultRpcUrls, publicRpcUrls } from '../../src/config/default-rpc'

describe('default RPCs', () => {
  test('every chain with a default starts with rpc.zkb.fi, then the public RPCs, and no list holds a valve.city key', () => {
    for (const chainId of DEFAULT_RPC_CHAIN_IDS) {
      const urls = defaultRpcUrls(chainId)
      expect(urls[0]).toBe(`https://rpc.zkb.fi/${chainId}`)
      expect(urls.slice(1)).toEqual([...publicRpcUrls(chainId)])
      expect(urls.length).toBeGreaterThan(1)
      expect(urls.join(' ')).not.toMatch(/valve\.city|vk_/)
    }
  })

  test('the first default of a chain is rpc.zkb.fi', () => {
    expect(defaultRpcUrl(369)).toBe('https://rpc.zkb.fi/369')
  })

  test('a chain with no default has no URLs and no first URL', () => {
    expect(defaultRpcUrls(10)).toEqual([])
    expect(defaultRpcUrl(10)).toBeNull()
    expect(publicRpcUrls(10)).toEqual([])
  })
})
