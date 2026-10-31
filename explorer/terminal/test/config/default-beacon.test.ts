import { describe, expect, test } from 'bun:test'
import { DEFAULT_BEACON_CHAIN_IDS, GENESIS_VALIDATORS_ROOTS, defaultBeaconUrl, defaultBeaconUrls } from '../../src/config/default-beacon'

describe('defaultBeaconUrls', () => {
  test('puts the valve.city demo beacon route first and the public keyless node next (owner: valve.city is the default)', () => {
    expect(defaultBeaconUrls(11155111)).toEqual(['https://one.valve.city/beacon/vk_demo/11155111', 'https://lodestar-sepolia.chainsafe.io'])
    expect(defaultBeaconUrls(943)).toEqual(['https://one.valve.city/beacon/vk_demo/943', 'https://rpc-testnet-pulsechain.g4mm4.io/beacon-api'])
    expect(defaultBeaconUrls(369)).toEqual(['https://one.valve.city/beacon/vk_demo/369', 'https://rpc-pulsechain.g4mm4.io/beacon-api'])
    expect(defaultBeaconUrls(1)).toEqual(['https://one.valve.city/beacon/vk_demo/1', 'https://ethereum-beacon-api.publicnode.com'])
  })

  test('the first default is valve.city, and a chain without defaults has none', () => {
    expect(defaultBeaconUrl(943)).toBe('https://one.valve.city/beacon/vk_demo/943')
    expect(defaultBeaconUrls(5)).toEqual([])
    expect(defaultBeaconUrl(5)).toBeNull()
  })

  test('every chain with a default has a known genesis validators root', () => {
    for (const chainId of DEFAULT_BEACON_CHAIN_IDS) expect(GENESIS_VALIDATORS_ROOTS[chainId]).toMatch(/^0x[0-9a-f]{64}$/)
  })
})
