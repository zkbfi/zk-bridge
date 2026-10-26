import { describe, expect, test } from 'bun:test'
import { DEFAULT_INDEXER_URL, EMPTY_CONNECTION_SETTINGS, type HttpClient } from '@zk-bridge/shared'
import { createConnectionRuntime, describeSetting, registryLayer } from '../../src/data/connection-runtime'
import { REGISTRY_RPC_URL, fakeChainAccesses, fakeConnections, fallbackStatus, livePair } from '../support/live-support'

// Made-up values. The key text is fake on purpose.
const USER_RPC = 'https://user.example.test/v1/FAKEKEY1234567890'
const ENVIRONMENT_RPC = 'https://env.example.test/v1/ENVKEY0987654321'
const USER_INDEXER = 'https://indexer-user.example.test/FAKEKEY1234567890'
const ENVIRONMENT_INDEXER = 'https://indexer-env.example.test'

function build(input: { user?: Parameters<typeof createConnectionRuntime>[0]['user']; environment?: Parameters<typeof createConnectionRuntime>[0]['environment'] } = {}) {
  const { pair, sharedPair } = livePair()
  const connections = fakeConnections()
  const accesses = fakeChainAccesses()
  const runtime = createConnectionRuntime({
    pair,
    sharedPair,
    environment: input.environment ?? {},
    user: input.user ?? EMPTY_CONNECTION_SETTINGS,
    createConnection: connections.createConnection,
    createChainAccess: accesses.createChainAccess,
  })
  return { runtime, connections, accesses }
}

describe('precedence of a URL: the user, then the environment, then the default', () => {
  test('the indexer URL names its source at each level', () => {
    expect(build().runtime.resolved().indexerUrl).toEqual({ value: DEFAULT_INDEXER_URL, source: 'default' })
    expect(build({ environment: { indexerUrl: ENVIRONMENT_INDEXER } }).runtime.resolved().indexerUrl).toEqual({ value: ENVIRONMENT_INDEXER, source: 'environment' })
    const both = build({ environment: { indexerUrl: ENVIRONMENT_INDEXER }, user: { indexerUrl: USER_INDEXER, rpcUrls: {} } })
    expect(both.runtime.resolved().indexerUrl).toEqual({ value: USER_INDEXER, source: 'user' })
  })

  test('the RPC URL of each chain names its source at each level, and chains do not share a setting', () => {
    const none = build().runtime.resolved().rpcUrls
    expect(none[1]).toEqual({ value: REGISTRY_RPC_URL, source: 'default' })
    expect(none[369]).toBeNull()
    const environment = build({ environment: { rpcUrls: { 1: ENVIRONMENT_RPC, 369: ENVIRONMENT_RPC } } }).runtime.resolved().rpcUrls
    expect(environment[1]).toEqual({ value: ENVIRONMENT_RPC, source: 'environment' })
    expect(environment[369]).toEqual({ value: ENVIRONMENT_RPC, source: 'environment' })
    const user = build({ environment: { rpcUrls: { 1: ENVIRONMENT_RPC, 369: ENVIRONMENT_RPC } }, user: { indexerUrl: null, rpcUrls: { 369: USER_RPC } } }).runtime.resolved().rpcUrls
    expect(user[1]).toEqual({ value: ENVIRONMENT_RPC, source: 'environment' })
    expect(user[369]).toEqual({ value: USER_RPC, source: 'user' })
  })

  test('the connection and the chain access get the URLs in force, under the variable name of each chain', () => {
    const { connections, accesses } = build({ user: { indexerUrl: USER_INDEXER, rpcUrls: { 1: USER_RPC } } })
    expect(connections.latest().input.resolved.indexerUrl).toEqual({ value: USER_INDEXER, source: 'user' })
    expect(connections.latest().baseUrl).toBe(USER_INDEXER)
    expect(accesses.environments[0]).toEqual({ EXPLORER_RPC_URL_1: USER_RPC, EXPLORER_RPC_URL_369: undefined })
  })

  test('the registry layer offers the deployment URL and the standard indexer address, and no URL for a chain without one', () => {
    expect(registryLayer(livePair().sharedPair)).toEqual({ indexerUrl: DEFAULT_INDEXER_URL, rpcUrls: { 1: REGISTRY_RPC_URL, 369: null } })
  })
})

describe('apply', () => {
  test('the next read uses the new URL: a new connection and a new chain access are built', () => {
    const { runtime, connections, accesses } = build({ environment: { rpcUrls: { 1: ENVIRONMENT_RPC } } })
    expect(connections.created).toHaveLength(1)
    expect(() => runtime.chainAccess.flowClient(1)).toThrow('build 1')
    runtime.apply({ indexerUrl: null, rpcUrls: { 1: USER_RPC } })
    expect(connections.created).toHaveLength(2)
    expect(runtime.connection()).toBe(connections.latest())
    expect(runtime.resolved().rpcUrls[1]).toEqual({ value: USER_RPC, source: 'user' })
    expect(accesses.environments[1]?.EXPLORER_RPC_URL_1).toBe(USER_RPC)
    expect(() => runtime.chainAccess.flowClient(1)).toThrow('build 2')
    expect(runtime.user().rpcUrls[1]).toBe(USER_RPC)
  })

  test('the data source answers from the newest connection and keeps its identity', async () => {
    const { runtime, connections } = build()
    const dataSource = runtime.dataSource
    const first = connections.latest()
    await expect(dataSource.getHeads('eth-pls')).rejects.toThrow(`no data from ${DEFAULT_INDEXER_URL}`)
    runtime.apply({ indexerUrl: USER_INDEXER, rpcUrls: {} })
    expect(runtime.dataSource).toBe(dataSource)
    expect(connections.latest()).not.toBe(first)
    expect(connections.latest().baseUrl).toBe(USER_INDEXER)
  })

  test('every method of the data source and of the chain access forwards to the newest connection', async () => {
    const { runtime } = build()
    const calls = (): Promise<unknown>[] => [
      runtime.dataSource.listPairs(),
      runtime.dataSource.getSummary('eth-pls'),
      runtime.dataSource.getFeed('eth-pls', {}, 10),
      runtime.dataSource.getHeads('eth-pls'),
      runtime.dataSource.getAudit('eth-pls'),
      runtime.dataSource.getProver('eth-pls'),
      runtime.dataSource.listTokens('eth-pls'),
      runtime.dataSource.getDeliveryCost(1),
    ]
    for (const settled of await Promise.allSettled(calls())) {
      expect(settled.status).toBe('rejected')
      expect((settled as PromiseRejectedResult).reason.message).toBe(`no data from ${DEFAULT_INDEXER_URL}`)
    }
    runtime.apply({ indexerUrl: USER_INDEXER, rpcUrls: {} })
    for (const settled of await Promise.allSettled(calls())) {
      expect((settled as PromiseRejectedResult).reason.message).toBe(`no data from ${USER_INDEXER}`)
    }
    const access = runtime.chainAccess
    expect(access.mode).toBe('rpc')
    await expect(access.readSnapshots({ account: `0x${'1'.repeat(40)}`, tokens: [] })).rejects.toThrow('build 2')
    await expect(access.nativeBalances([])).rejects.toThrow('build 2')
    await expect(access.readRouterAddresses({ chainId: 1, router: `0x${'2'.repeat(40)}` })).rejects.toThrow('build 2')
    expect(() => access.flowClient(369)).toThrow('build 2')
  })

  test('forgetting a user setting returns the URL to the weaker source', () => {
    const { runtime } = build({ environment: { rpcUrls: { 1: ENVIRONMENT_RPC } }, user: { indexerUrl: null, rpcUrls: { 1: USER_RPC } } })
    runtime.apply(EMPTY_CONNECTION_SETTINGS)
    expect(runtime.resolved().rpcUrls[1]).toEqual({ value: ENVIRONMENT_RPC, source: 'environment' })
  })

  test('a listener hears each apply and stops hearing after it unsubscribes', () => {
    const { runtime } = build()
    let heard = 0
    const stop = runtime.subscribe(() => (heard += 1))
    runtime.apply({ indexerUrl: USER_INDEXER, rpcUrls: {} })
    stop()
    runtime.apply(EMPTY_CONNECTION_SETTINGS)
    expect(heard).toBe(1)
  })

  test('a listener hears a change of the status of the newest connection, and not of an old one', () => {
    const { runtime, connections } = build()
    const old = connections.latest()
    runtime.apply({ indexerUrl: USER_INDEXER, rpcUrls: {} })
    let heard = 0
    runtime.subscribe(() => (heard += 1))
    old.setStatus(fallbackStatus('old one'))
    expect(heard).toBe(0)
    connections.latest().setStatus(fallbackStatus('indexer unreachable'))
    expect(heard).toBe(1)
  })
})

describe('the label of the data source follows the status', () => {
  test('the object stays the same while the label changes with the status of the newest connection', () => {
    const { runtime, connections } = build()
    const dataSource = runtime.dataSource
    expect(dataSource.label).toBe('indexer')
    connections.latest().setStatus(fallbackStatus('indexer unreachable'))
    expect(runtime.dataSource).toBe(dataSource)
    expect(dataSource.label).toBe('RPC fallback: indexer unreachable')
    expect(runtime.source().label).toBe('RPC fallback: indexer unreachable')
  })
})

describe('testing a URL', () => {
  const chainAnswer = (hex: string): HttpClient => async () => ({ status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 1, result: hex }) })

  test('an RPC URL that reports its own chain passes', async () => {
    const { runtime } = build()
    expect((await runtime.testRpcUrl(1, USER_RPC, chainAnswer('0x1'))).ok).toBe('pass')
  })

  test('an RPC URL of another chain is refused, and the message names the chains but not the URL', async () => {
    const { runtime } = build()
    const outcome = await runtime.testRpcUrl(369, USER_RPC, chainAnswer('0x1'))
    expect(outcome.ok).toBe('fail')
    expect(outcome.message).toContain('chain 1')
    expect(outcome.message).toContain('chain 369')
    expect(outcome.message).not.toContain('FAKEKEY1234567890')
  })

  test('a malformed URL is refused before any request, with a message that repeats nothing of it', async () => {
    const { runtime } = build()
    let requests = 0
    const counting: HttpClient = async () => {
      requests += 1
      return { status: 200, text: '{}' }
    }
    const outcome = await runtime.testRpcUrl(1, 'ftp://x.example.test/FAKEKEY1234567890', counting)
    expect(outcome.ok).toBe('fail')
    expect(outcome.message).toContain('http://')
    expect(outcome.message).not.toContain('FAKEKEY1234567890')
    expect(requests).toBe(0)
  })

  test('a failing request gives a message with no part of the URL, even when the error repeats the URL', async () => {
    const { runtime } = build()
    const failing: HttpClient = async (request) => {
      throw new Error(`connect failed for ${request.url}`)
    }
    const outcome = await runtime.testRpcUrl(1, USER_RPC, failing)
    expect(outcome.ok).toBe('fail')
    expect(outcome.message).not.toContain('FAKEKEY1234567890')
    expect(outcome.message).not.toContain('user.example.test/v1')
  })

  test('an indexer URL that does not answer like an indexer is refused, and a malformed one too', async () => {
    const { runtime } = build()
    const wrong: HttpClient = async () => ({ status: 200, text: '{"nothing":true}' })
    const outcome = await runtime.testIndexer(USER_INDEXER, wrong)
    expect(outcome.ok).toBe('fail')
    expect(outcome.message).not.toContain('FAKEKEY1234567890')
    const malformed = await runtime.testIndexer('not a url FAKEKEY1234567890')
    expect(malformed.ok).toBe('fail')
    expect(malformed.message).not.toContain('FAKEKEY1234567890')
  })

  test('an indexer that answers the heads route passes', async () => {
    const { runtime } = build()
    const good: HttpClient = async () => ({ status: 200, text: JSON.stringify({ heads: [] }) })
    expect((await runtime.testIndexer(USER_INDEXER, good)).ok).toBe('pass')
  })
})

describe('redaction and description', () => {
  test('redact removes every URL in force, and the key inside it', () => {
    const { runtime } = build({ user: { indexerUrl: USER_INDEXER, rpcUrls: { 1: USER_RPC } } })
    const text = runtime.redact(`failed ${USER_RPC} and ${USER_INDEXER} and FAKEKEY1234567890`)
    expect(text).not.toContain('FAKEKEY1234567890')
    expect(text).not.toContain(USER_RPC)
  })

  test('a setting is described by its masked form and its source, never its value', () => {
    const text = describeSetting({ value: USER_RPC, source: 'user' })
    expect(text).toContain('https://user.example.test')
    expect(text).toContain('set by you')
    expect(text).not.toContain('FAKEKEY1234567890')
    expect(text).toContain('7890')
    expect(describeSetting(null)).toBe('not set')
  })
})
