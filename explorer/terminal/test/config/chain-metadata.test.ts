import { describe, expect, test } from 'bun:test'
import { buildPairConfig } from '../../src/config/pairs'
import { CHAIN_METADATA, explorerLinks, nativeSymbolOfChain } from '../../src/config/chain-metadata'

describe('the native coin of each chain', () => {
  test('is the coin of the chain where the gas is paid', () => {
    expect(nativeSymbolOfChain(1)).toBe('ETH')
    expect(nativeSymbolOfChain(11155111)).toBe('SepETH')
    expect(nativeSymbolOfChain(369)).toBe('PLS')
    expect(nativeSymbolOfChain(943)).toBe('v4tPLS')
  })

  test('is what the pair configuration carries', () => {
    const section = (chainId: number) => ({ chain_id: chainId, bridge: `0x${'1'.repeat(40)}`, mediator: `0x${'2'.repeat(40)}`, light_client: `0x${'3'.repeat(40)}` })
    const config = buildPairConfig('sepolia-pls943', [section(11155111), section(943)])
    expect([config.first.nativeSymbol, config.second.nativeSymbol]).toEqual(['SepETH', 'v4tPLS'])
  })

  test('is undefined for a chain the metadata does not know', () => {
    expect(nativeSymbolOfChain(5)).toBeUndefined()
  })
})

describe('the block explorer links of each chain', () => {
  const hash = `0x${'ab'.repeat(32)}`
  const account = `0x${'cd'.repeat(20)}`
  const urls = (chainId: number, kind: 'tx' | 'block' | 'address', id: string) => explorerLinks(chainId, kind, id).map((link) => link.url)

  test('Ethereum and Sepolia use path URLs', () => {
    expect(urls(1, 'tx', hash)).toEqual([`https://etherscan.io/tx/${hash}`])
    expect(urls(11155111, 'block', '7')).toEqual(['https://sepolia.etherscan.io/block/7'])
    expect(urls(11155111, 'address', account)).toEqual([`https://sepolia.etherscan.io/address/${account}`])
  })

  test('PulseChain explorers use the hash router', () => {
    expect(urls(369, 'tx', hash)).toEqual([`https://scan.pulsechain.com/#/tx/${hash}`])
    expect(urls(943, 'block', '25767883')[0]).toBe('https://scan.v4.testnet.pulsechain.com/#/block/25767883')
  })

  test('PulseChain testnet v4 has a second explorer (Otterscan, path URLs)', () => {
    expect(explorerLinks(943, 'address', account).map((link) => [link.name, link.url])).toEqual([
      ['PulseChain testnet scan', `https://scan.v4.testnet.pulsechain.com/#/address/${account}`],
      ['Otterscan', `https://otter-testnet-pulsechain.g4mm4.io/address/${account}`],
    ])
  })

  test('is empty for an unknown chain', () => {
    expect(explorerLinks(5, 'tx', hash)).toEqual([])
    expect(Object.keys(CHAIN_METADATA).map(Number).sort((a, b) => a - b)).toEqual([1, 369, 943, 11155111])
  })
})
