import { describe, expect, test } from 'bun:test'
import { DEFAULT_BEACON_CHAIN_IDS, GENESIS_VALIDATORS_ROOTS, beaconUrlsFor, defaultBeaconUrl, defaultBeaconUrls } from '../../src/config/default-beacon'

describe('defaultBeaconUrls', () => {
  test('is the public keyless node of each chain; the valve.city demo key is gone', () => {
    expect(defaultBeaconUrls(11155111)).toEqual(['https://lodestar-sepolia.chainsafe.io'])
    expect(defaultBeaconUrls(943)).toEqual(['https://rpc-testnet-pulsechain.g4mm4.io/beacon-api'])
    expect(defaultBeaconUrls(369)).toEqual(['https://rpc-pulsechain.g4mm4.io/beacon-api'])
    expect(defaultBeaconUrls(1)).toEqual(['https://ethereum-beacon-api.publicnode.com'])
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

describe('beaconUrlsFor: the beacon APIs a chain is read from', () => {
  test("are the chain's whole default list when the setting in force is the default", () => {
    expect(beaconUrlsFor({ beaconUrls: { 943: { value: defaultBeaconUrls(943)[0] as string, source: 'default' } } }, 943)).toEqual(defaultBeaconUrls(943))
  })

  test('are the one URL the user or the build chose, alone', () => {
    expect(beaconUrlsFor({ beaconUrls: { 943: { value: 'https://mine.example.org', source: 'user' } } }, 943)).toEqual(['https://mine.example.org'])
    expect(beaconUrlsFor({ beaconUrls: { 943: { value: 'https://build.example.org', source: 'environment' } } }, 943)).toEqual(['https://build.example.org'])
  })

  test('fall back to the default list when the connection has no beacon setting, and are empty for a chain with none', () => {
    expect(beaconUrlsFor({}, 11155111)).toEqual(defaultBeaconUrls(11155111))
    expect(beaconUrlsFor({ beaconUrls: { 5: null } }, 5)).toEqual([])
  })
})
