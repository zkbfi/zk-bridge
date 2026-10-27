import { describe, expect, test } from 'bun:test'
import { getAddress, type Address } from 'viem'
import { createRpcChainAccess, FIXTURE_TRANSACTION_HASH, MissingRpcError, type RpcClient, type RpcClientFactory } from '../../src/chain/chain-access'
import { FIXTURE_PAIR, FIXTURE_TOKENS } from '../../src/data/fixtures'
import type { ChainConfig } from '../../src/model/types'

const account: Address = '0x00000000000000000000000000000000000000a9'
const router: Address = '0x00000000000000000000000000000000000000a2'
const urls = { EXPLORER_RPC_URL_1: 'http://first.rpc.test', EXPLORER_RPC_URL_369: 'http://second.rpc.test' }

interface FakeChain {
  readonly balance?: (address: Address) => bigint
  readonly contract?: (functionName: string) => unknown
}

/** A factory that builds a fake client per chain and records each creation. */
function fakeFactory(behaviour: Readonly<Record<number, FakeChain>> = {}) {
  const created: Array<{ chain: ChainConfig; url: string; client: RpcClient }> = []
  const factory: RpcClientFactory = (chain, url) => {
    const fake = behaviour[chain.chainId] ?? {}
    const client = {
      async getBalance({ address }: { address: Address }) {
        return (fake.balance ?? (() => BigInt(chain.chainId)))(address)
      },
      async readContract({ functionName }: { functionName: string }) {
        return (fake.contract ?? (() => 1n))(functionName)
      },
    } as unknown as RpcClient
    created.push({ chain, url, client })
    return client
  }
  return { factory, created }
}

describe('createRpcChainAccess', () => {
  test('reports the rpc mode, so the screen does not claim fixture data', () => {
    expect(createRpcChainAccess(FIXTURE_PAIR, urls, fakeFactory().factory).mode).toBe('rpc')
  })

  test('reads the snapshot of each chain with the client of that chain and its URL, in the order first then second', async () => {
    const { factory, created } = fakeFactory({
      1: { balance: () => 100n, contract: () => 1n },
      369: { balance: () => 200n, contract: () => 2n },
    })
    const results = await createRpcChainAccess(FIXTURE_PAIR, urls, factory).readSnapshots({ account, tokens: FIXTURE_TOKENS })
    expect(results.map((result) => (result.status === 'ok' ? [result.snapshot.chain.chainId, result.snapshot.nativeBalance] : null))).toEqual([
      [1, 100n],
      [369, 200n],
    ])
    expect(created.map((entry) => [entry.chain.chainId, entry.url])).toEqual([
      [1, 'http://first.rpc.test'],
      [369, 'http://second.rpc.test'],
    ])
  })

  test('one chain with no URL gives an error result for that chain only, and the other chain still reads', async () => {
    const access = createRpcChainAccess(FIXTURE_PAIR, { EXPLORER_RPC_URL_369: urls.EXPLORER_RPC_URL_369 }, fakeFactory().factory)
    const [first, second] = await access.readSnapshots({ account, tokens: [] })
    expect(first).toEqual({ status: 'error', chain: FIXTURE_PAIR.first, message: 'Set EXPLORER_RPC_URL_1 to the RPC URL of Ethereum.' })
    expect(second?.status).toBe('ok')
  })

  test('an empty URL counts as not set', async () => {
    const access = createRpcChainAccess(FIXTURE_PAIR, { ...urls, EXPLORER_RPC_URL_1: '' }, fakeFactory().factory)
    const [first] = await access.readSnapshots({ account, tokens: [] })
    expect(first).toEqual({ status: 'error', chain: FIXTURE_PAIR.first, message: 'Set EXPLORER_RPC_URL_1 to the RPC URL of Ethereum.' })
  })

  test('a read that throws something that is not an Error becomes an error result with its text', async () => {
    const access = createRpcChainAccess(
      FIXTURE_PAIR,
      urls,
      fakeFactory({
        1: {
          balance: () => {
            throw 'socket closed'
          },
        },
      }).factory,
    )
    const [first, second] = await access.readSnapshots({ account, tokens: [] })
    expect(first).toEqual({ status: 'error', chain: FIXTURE_PAIR.first, message: 'socket closed' })
    expect(second?.status).toBe('ok')
  })

  test('creates one client per chain and reuses it for every later call', async () => {
    const { factory, created } = fakeFactory()
    const access = createRpcChainAccess(FIXTURE_PAIR, urls, factory)
    await access.readSnapshots({ account, tokens: [] })
    await access.readSnapshots({ account, tokens: [] })
    await access.nativeBalances([account])
    expect(created).toHaveLength(2)
    expect(access.flowClient(369)).toBe(created[1]!.client)
    expect(access.flowClient(1)).toBe(created[0]!.client)
  })

  test('nativeBalances gives the balance of each address on each chain, and null for a chain that fails', async () => {
    const other: Address = '0x00000000000000000000000000000000000000b9'
    const { factory } = fakeFactory({
      1: { balance: (address) => (address === account ? 10n : 20n) },
      369: {
        balance: () => {
          throw new Error('timeout')
        },
      },
    })
    const balances = await createRpcChainAccess(FIXTURE_PAIR, urls, factory).nativeBalances([account, other])
    expect(balances).toEqual([
      { first: 10n, second: null },
      { first: 20n, second: null },
    ])
  })

  test('nativeBalances gives null for a chain with no URL', async () => {
    const access = createRpcChainAccess(FIXTURE_PAIR, {}, fakeFactory().factory)
    expect(await access.nativeBalances([account])).toEqual([{ first: null, second: null }])
  })

  test('readRouterAddresses asks the router on the named chain for both addresses and returns what it answers', async () => {
    const reward = '0x00000000000000000000000000000000000000f1'
    const failedDelivery = '0x00000000000000000000000000000000000000f2'
    const asked: string[] = []
    const { factory } = fakeFactory({ 369: { contract: (name) => (asked.push(name), name === 'rewardAddress' ? reward : failedDelivery) } })
    const reading = await createRpcChainAccess(FIXTURE_PAIR, urls, factory).readRouterAddresses({ chainId: 369, router })
    expect(reading).toEqual({ kind: 'read', rewardAddress: getAddress(reward), failedDeliveryAddress: getAddress(failedDelivery) })
    expect(asked).toEqual(['rewardAddress', 'failedDeliveryAddress'])
  })

  test('readRouterAddresses is unreadable, with the reason, for a chain with no URL', async () => {
    const reading = await createRpcChainAccess(FIXTURE_PAIR, {}, fakeFactory().factory).readRouterAddresses({ chainId: 369, router })
    expect(reading).toEqual({ kind: 'unreadable', reason: 'Set EXPLORER_RPC_URL_369 to the RPC URL of PulseChain.' })
  })

  test('readRouterAddresses is unreadable for a chain that is not in the pair, and creates no client', async () => {
    const { factory, created } = fakeFactory()
    const reading = await createRpcChainAccess(FIXTURE_PAIR, urls, factory).readRouterAddresses({ chainId: 5, router })
    expect(reading).toEqual({ kind: 'unreadable', reason: 'Chain 5 is not in pair eth-pls.' })
    expect(created).toHaveLength(0)
  })

  test('readRouterAddresses keeps the text of a failure that is not an Error', async () => {
    const access = createRpcChainAccess(FIXTURE_PAIR, urls, () => {
      throw 'factory broke'
    })
    expect(await access.readRouterAddresses({ chainId: 1, router })).toEqual({ kind: 'unreadable', reason: 'factory broke' })
  })

  test('flowClient throws MissingRpcError for a chain with no URL, and a plain error for a chain outside the pair', () => {
    const access = createRpcChainAccess(FIXTURE_PAIR, {}, fakeFactory().factory)
    expect(() => access.flowClient(1)).toThrow(MissingRpcError)
    expect(() => access.flowClient(1)).toThrow('Set EXPLORER_RPC_URL_1 to the RPC URL of Ethereum.')
    expect(() => access.flowClient(5)).toThrow('Chain 5 is not in pair eth-pls.')
  })

  test('the missing URL error has its own name, so callers can tell it from other errors', () => {
    expect(new MissingRpcError('x').name).toBe('MissingRpcError')
  })

  test('the default client factory builds a viem client for the chain, with its id, name and native symbol, and sends nothing', () => {
    const access = createRpcChainAccess(FIXTURE_PAIR, urls)
    const client = access.flowClient(369) as unknown as {
      chain: { id: number; name: string; nativeCurrency: { name: string; symbol: string; decimals: number }; rpcUrls: { default: { http: string[] } } }
    }
    expect(client.chain.id).toBe(369)
    expect(client.chain.name).toBe('PulseChain')
    expect(client.chain.nativeCurrency).toEqual({ name: 'PLS', symbol: 'PLS', decimals: 18 })
    expect(client.chain.rpcUrls.default.http).toEqual(['http://second.rpc.test'])
    expect(access.flowClient(369) as unknown).toBe(client)
  })

  test('the fixture transaction hash is a 32 byte hash', () => {
    expect(FIXTURE_TRANSACTION_HASH).toBe(`0x${'f1'.repeat(32)}`)
  })
})
