import { getAddress } from 'viem'
import { describe, expect, test } from 'bun:test'
import { PairConfigError, buildPairConfig, knownPairIds } from '../../src/config/pairs'

describe('buildPairConfig input guard', () => {
  test('refuses a deployment file that is not a JSON object, because it is parsed from outside', () => {
    for (const deployment of [null, 'text', 7, undefined]) {
      expect(() => buildPairConfig('eth-pls', deployment)).toThrow(new PairConfigError('The deployment file must be a JSON object.'))
    }
  })

  test('refuses an unknown pair and lists the known ones', () => {
    expect(() => buildPairConfig('nope', {})).toThrow('Unknown pair "nope". Known pairs: eth-pls, sepolia-pls943.')
  })

  test('refuses a file with no section for a chain, and reports how many it found', () => {
    expect(() => buildPairConfig('eth-pls', {})).toThrow('The deployment file must hold exactly one section for chain 1, found 0.')
  })
})

describe('the sepolia-pls943 pair', () => {
  const section = (chainId: number, seed: string) => {
    const address = `0x${seed.repeat(40)}`
    return {
      chain_id: chainId,
      bridge: address,
      mediator: address,
      token_factory: address,
      native_router: address,
      wrapped_native: address,
      gate: address,
      light_client: address,
      start_block: 3,
    }
  }
  const sepolia = section(11155111, '3')
  const testnet = section(943, '4')

  test('is known beside eth-pls', () => {
    expect(knownPairIds()).toEqual(['eth-pls', 'sepolia-pls943'])
  })

  test('names both chains with their chain ids and native coins, in either section order', () => {
    for (const deployment of [{ chain_a: sepolia, chain_b: testnet }, { chain_a: testnet, chain_b: sepolia }]) {
      const config = buildPairConfig('sepolia-pls943', deployment)
      expect(config.label).toBe('Sepolia and PulseChain testnet v4')
      expect([config.first.name, config.first.chainId, config.first.nativeSymbol]).toEqual(['Sepolia', 11155111, 'ETH'])
      expect([config.second.name, config.second.chainId, config.second.nativeSymbol]).toEqual(['PulseChain testnet v4', 943, 'tPLS'])
      expect(config.first.contracts.messageBridge).toBe(getAddress(`0x${'3'.repeat(40)}`))
      expect(config.second.contracts.messageBridge).toBe(getAddress(`0x${'4'.repeat(40)}`))
    }
  })

  test('asks for the section of chain 11155111 first', () => {
    expect(() => buildPairConfig('sepolia-pls943', {})).toThrow('exactly one section for chain 11155111, found 0.')
  })
})
