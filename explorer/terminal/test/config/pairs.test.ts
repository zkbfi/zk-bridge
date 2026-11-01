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
      expect([config.first.name, config.first.chainId, config.first.nativeSymbol]).toEqual(['Sepolia', 11155111, 'SepETH'])
      expect([config.second.name, config.second.chainId, config.second.nativeSymbol]).toEqual(['PulseChain testnet v4', 943, 'v4tPLS'])
      expect(config.first.contracts.messageBridge).toBe(getAddress(`0x${'3'.repeat(40)}`))
      expect(config.second.contracts.messageBridge).toBe(getAddress(`0x${'4'.repeat(40)}`))
    }
  })

  test('asks for the section of chain 11155111 first', () => {
    expect(() => buildPairConfig('sepolia-pls943', {})).toThrow('exactly one section for chain 11155111, found 0.')
  })
})

describe('the registry RPC URL of a chain', () => {
  const address = `0x${'5'.repeat(40)}`
  const section = (chainId: number, extra: Record<string, unknown> = {}) => ({
    chain_id: chainId,
    bridge: address,
    mediator: address,
    light_client: address,
    ...extra,
  })
  const build = (firstExtra: Record<string, unknown>) => buildPairConfig('eth-pls', { a: section(1, firstExtra), b: section(369) })

  test('is the rpc_url of the deployment section when it is a non-empty http or https URL', () => {
    expect(build({ rpc_url: 'https://rpc.example.test/path' }).first.registryRpcUrl).toBe('https://rpc.example.test/path')
    expect(build({ rpc_url: 'http://127.0.0.1:8545' }).first.registryRpcUrl).toBe('http://127.0.0.1:8545')
    expect(build({ rpc_url: '  https://rpc.example.test  ' }).first.registryRpcUrl).toBe('https://rpc.example.test')
  })

  test('belongs to its own chain: the other chain has none when its section names none', () => {
    const config = build({ rpc_url: 'https://rpc.example.test/path' })
    expect('registryRpcUrl' in config.second).toBe(false)
  })

  test('is absent for an empty value, a blank value, another scheme, a number or no field', () => {
    for (const rpc_url of ['', '   ', 'ftp://rpc.example.test', 'wss://rpc.example.test', 'rpc.example.test', 'https://', 42, null]) {
      expect('registryRpcUrl' in build({ rpc_url }).first).toBe(false)
    }
    expect('registryRpcUrl' in build({}).first).toBe(false)
  })
})
