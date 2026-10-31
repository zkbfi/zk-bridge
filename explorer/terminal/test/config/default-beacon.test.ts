import { describe, expect, test } from 'bun:test'
import { DEFAULT_BEACON_CHAIN_IDS, GENESIS_VALIDATORS_ROOTS, defaultBeaconUrl, defaultBeaconUrls } from '../../src/config/default-beacon'

describe('defaultBeaconUrls', () => {
  test('puts the public keyless node first and the valve.city demo beacon route next, while valve.city refuses its demo key for beacon', () => {
    expect(defaultBeaconUrls(11155111)).toEqual(['https://lodestar-sepolia.chainsafe.io', 'https://one.valve.city/beacon/vk_demo/11155111'])
    expect(defaultBeaconUrls(943)).toEqual(['https://rpc-testnet-pulsechain.g4mm4.io/beacon-api', 'https://one.valve.city/beacon/vk_demo/943'])
    expect(defaultBeaconUrls(369)).toEqual(['https://rpc-pulsechain.g4mm4.io/beacon-api', 'https://one.valve.city/beacon/vk_demo/369'])
    expect(defaultBeaconUrls(1)).toEqual(['https://ethereum-beacon-api.publicnode.com', 'https://one.valve.city/beacon/vk_demo/1'])
  })

  test('the first default is the public node, and a chain without defaults has none', () => {
    expect(defaultBeaconUrl(943)).toBe('https://rpc-testnet-pulsechain.g4mm4.io/beacon-api')
    expect(defaultBeaconUrls(5)).toEqual([])
    expect(defaultBeaconUrl(5)).toBeNull()
  })

  test('every chain with a default has a known genesis validators root', () => {
    for (const chainId of DEFAULT_BEACON_CHAIN_IDS) expect(GENESIS_VALIDATORS_ROOTS[chainId]).toMatch(/^0x[0-9a-f]{64}$/)
  })
})
