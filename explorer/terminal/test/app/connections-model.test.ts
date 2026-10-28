import { describe, expect, test } from 'bun:test'
import { EMPTY_CONNECTION_SETTINGS, type HttpClient } from '@zk-bridge/shared'
import { CONNECTION_SECRET_NAMES } from '@zk-bridge/shared/config'
import {
  checkIndexerNow,
  connectionRows,
  forgetUrlSetting,
  hasUserSettings,
  runUrlTest,
  safeMessage,
  sameSettings,
  saveUrlSetting,
  settingKeyOfRow,
  withSetting,
} from '../../src/app/connections-model'
import { createConnectionRuntime, type ConnectionRuntime } from '../../src/data/connection-runtime'
import { fakeChainAccesses, fakeConnections, livePair } from '../support/live-support'
import { memoryStore } from '../ui/harness'

const KEY = 'FAKEKEY1234567890'
const RPC = `https://user.example.test/v1/${KEY}`
const INDEXER = `https://indexer.example.test/${KEY}`

function buildRuntime(user = EMPTY_CONNECTION_SETTINGS) {
  const { pair, sharedPair } = livePair()
  const connections = fakeConnections()
  const runtime = createConnectionRuntime({
    pair,
    sharedPair,
    environment: {},
    user,
    createConnection: connections.createConnection,
    createChainAccess: fakeChainAccesses().createChainAccess,
  })
  return { runtime, connections, pair }
}

const chainIdAnswer = (hex: string): HttpClient => async () => ({ status: 200, text: JSON.stringify({ result: hex }) })
const heads: HttpClient = async () => ({ status: 200, text: JSON.stringify({ heads: [] }) })

describe('connectionRows', () => {
  test('lists the URLs, then the tests, then the check, with one row per chain name', () => {
    const { pair } = buildRuntime()
    expect(connectionRows(pair).map((row) => [row.id, row.label, row.kind])).toEqual([
      ['indexer', 'Indexer URL', 'url'],
      ['rpc:1', 'Ethereum RPC URL', 'url'],
      ['rpc:369', 'PulseChain RPC URL', 'url'],
      ['test:indexer', 'Test: indexer', 'test'],
      ['test:rpc:1', 'Test: Ethereum RPC chain id', 'test'],
      ['test:rpc:369', 'Test: PulseChain RPC chain id', 'test'],
      ['check', 'Check the indexer now', 'check'],
    ])
  })

  test('a URL row maps to the setting that the secret store names, and the indexer row to the indexer', () => {
    const rows = connectionRows(buildRuntime().pair)
    expect(settingKeyOfRow(rows[0]!)).toEqual({ kind: 'indexer' })
    expect(settingKeyOfRow(rows[2]!)).toEqual({ kind: 'rpc', chainId: 369 })
  })
})

describe('settings helpers', () => {
  test('withSetting replaces one URL and keeps the others, and null removes it', () => {
    const start = { indexerUrl: INDEXER, rpcUrls: { 1: RPC, 369: 'https://other.example.test' } }
    expect(withSetting(start, { kind: 'rpc', chainId: 1 }, 'https://new.example.test').rpcUrls).toEqual({ 1: 'https://new.example.test', 369: 'https://other.example.test' })
    expect(withSetting(start, { kind: 'rpc', chainId: 1 }, null).rpcUrls).toEqual({ 369: 'https://other.example.test' })
    expect(withSetting(start, { kind: 'indexer' }, null)).toEqual({ indexerUrl: null, rpcUrls: start.rpcUrls })
  })

  test('sameSettings compares the indexer and each named chain', () => {
    const base = { indexerUrl: INDEXER, rpcUrls: { 1: RPC } }
    expect(sameSettings(base, { ...base }, [1, 369])).toBe(true)
    expect(sameSettings(base, { ...base, indexerUrl: null }, [1, 369])).toBe(false)
    expect(sameSettings(base, { ...base, rpcUrls: { 1: RPC, 369: 'https://x.example.test' } }, [1, 369])).toBe(false)
  })

  test('hasUserSettings is true for an indexer URL or for any chain URL, and false for none', () => {
    expect(hasUserSettings(EMPTY_CONNECTION_SETTINGS)).toBe(false)
    expect(hasUserSettings({ indexerUrl: INDEXER, rpcUrls: {} })).toBe(true)
    expect(hasUserSettings({ indexerUrl: null, rpcUrls: { 369: RPC } })).toBe(true)
  })

  test('safeMessage removes the URL given and the URLs in force', () => {
    const { runtime } = buildRuntime({ indexerUrl: INDEXER, rpcUrls: {} })
    const text = safeMessage(runtime, new Error(`bad ${RPC} and ${INDEXER}`), [RPC])
    expect(text).not.toContain(KEY)
  })
})

describe('saveUrlSetting', () => {
  test('saves an RPC URL that reports its chain: the store holds it and the runtime uses it', async () => {
    const { runtime } = buildRuntime()
    const store = memoryStore()
    const result = await saveUrlSetting({ runtime, store, key: { kind: 'rpc', chainId: 1 }, text: `  ${RPC}  `, http: chainIdAnswer('0x1') })
    expect(result).toEqual({ ok: true })
    expect(store.values.get(CONNECTION_SECRET_NAMES.rpcUrl(1))).toBe(RPC)
    expect(runtime.resolved().rpcUrls[1]).toEqual({ value: RPC, source: 'user' })
  })

  test('refuses an RPC URL of another chain: nothing is stored and the runtime does not change', async () => {
    const { runtime, connections } = buildRuntime()
    const store = memoryStore()
    const result = await saveUrlSetting({ runtime, store, key: { kind: 'rpc', chainId: 1 }, text: RPC, http: chainIdAnswer('0x171') })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toContain('Not saved.')
    expect(result.ok === false && result.message).toContain('chain 369')
    expect(JSON.stringify(result)).not.toContain(KEY)
    expect(store.values.size).toBe(0)
    expect(connections.created).toHaveLength(1)
  })

  test('refuses a malformed URL with a message that does not repeat it', async () => {
    const { runtime } = buildRuntime()
    const store = memoryStore()
    const result = await saveUrlSetting({ runtime, store, key: { kind: 'indexer' }, text: `ftp://x/${KEY}`, http: heads })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(KEY)
    expect(store.values.size).toBe(0)
  })

  test('saves an indexer URL with no chain test, and drops the trailing slash', async () => {
    const { runtime } = buildRuntime()
    const store = memoryStore()
    const neverCalled: HttpClient = async () => {
      throw new Error('the indexer URL needs no request to save')
    }
    expect(await saveUrlSetting({ runtime, store, key: { kind: 'indexer' }, text: `${INDEXER}/`, http: neverCalled })).toEqual({ ok: true })
    expect(store.values.get(CONNECTION_SECRET_NAMES.indexerUrl)).toBe(INDEXER)
    expect(runtime.resolved().indexerUrl).toEqual({ value: INDEXER, source: 'user' })
  })

  test('a store that fails gives a message with no URL, and the runtime does not change', async () => {
    const { runtime, connections } = buildRuntime()
    const store = { ...memoryStore(), set: async () => Promise.reject(new Error(`keychain refused ${RPC}`)) }
    const result = await saveUrlSetting({ runtime, store, key: { kind: 'rpc', chainId: 1 }, text: RPC, http: chainIdAnswer('0x1') })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toContain('keychain refused')
    expect(JSON.stringify(result)).not.toContain(KEY)
    expect(connections.created).toHaveLength(1)
  })
})

describe('forgetUrlSetting', () => {
  test('removes the setting from the store and the runtime, and the row falls back to the default', async () => {
    const { runtime } = buildRuntime({ indexerUrl: null, rpcUrls: { 1: RPC } })
    const store = memoryStore()
    store.values.set(CONNECTION_SECRET_NAMES.rpcUrl(1), RPC)
    expect(await forgetUrlSetting({ runtime, store, key: { kind: 'rpc', chainId: 1 } })).toEqual({ ok: true })
    expect(store.values.size).toBe(0)
    expect(runtime.resolved().rpcUrls[1]?.source).toBe('default')
  })

  test('says so when the user set nothing, for the indexer and for a chain, and touches nothing', async () => {
    const { runtime, connections } = buildRuntime()
    const store = memoryStore()
    for (const key of [{ kind: 'indexer' }, { kind: 'rpc', chainId: 369 }] as const) {
      const result = await forgetUrlSetting({ runtime, store, key })
      expect(result).toEqual({ ok: false, message: 'You set no value here, so nothing is forgotten.' })
    }
    expect(connections.created).toHaveLength(1)
  })

  test('forgets the indexer setting', async () => {
    const { runtime } = buildRuntime({ indexerUrl: INDEXER, rpcUrls: {} })
    expect(await forgetUrlSetting({ runtime, store: memoryStore(), key: { kind: 'indexer' } })).toEqual({ ok: true })
    expect(runtime.resolved().indexerUrl?.source).toBe('default')
  })

  test('a store that fails keeps the setting and gives a message with no URL', async () => {
    const { runtime } = buildRuntime({ indexerUrl: null, rpcUrls: { 1: RPC } })
    const store = { ...memoryStore(), delete: async () => Promise.reject(new Error(`keychain locked for ${RPC}`)) }
    const result = await forgetUrlSetting({ runtime, store, key: { kind: 'rpc', chainId: 1 } })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toContain('Not forgotten.')
    expect(JSON.stringify(result)).not.toContain(KEY)
    expect(runtime.user().rpcUrls[1]).toBe(RPC)
  })
})

describe('runUrlTest', () => {
  const rowOf = (id: string) => ({ id, label: id, kind: 'test' as const })

  test('tests the URL in force now, which is the user URL when one is set', async () => {
    const { runtime } = buildRuntime({ indexerUrl: INDEXER, rpcUrls: { 1: RPC } })
    const urls: string[] = []
    const recording: HttpClient = async (request) => {
      urls.push(request.url)
      return { status: 200, text: JSON.stringify({ result: '0x1', heads: [] }) }
    }
    expect((await runUrlTest({ runtime, row: rowOf('test:rpc:1'), http: recording })).ok).toBe('pass')
    expect((await runUrlTest({ runtime, row: rowOf('test:indexer'), http: recording })).ok).toBe('pass')
    expect(urls[0]).toBe(RPC)
    expect(urls[1]?.startsWith(INDEXER)).toBe(true)
  })

  test('a chain with no URL fails with a plain sentence, and so does a missing indexer', async () => {
    const { runtime } = buildRuntime()
    expect(await runUrlTest({ runtime, row: rowOf('test:rpc:369'), http: heads })).toEqual({ ok: 'fail', message: 'No RPC URL is set for chain 369.' })
    runtime.apply({ indexerUrl: null, rpcUrls: {} })
    const bare: ConnectionRuntime = {
      ...runtime,
      resolved: () => ({ ...runtime.resolved(), indexerUrl: null, rpcUrls: {} }),
    }
    expect(await runUrlTest({ runtime: bare, row: rowOf('test:indexer'), http: heads })).toEqual({ ok: 'fail', message: 'No indexer URL is set.' })
  })

  test('a node of another chain fails', async () => {
    const { runtime } = buildRuntime({ indexerUrl: null, rpcUrls: { 1: RPC } })
    const outcome = await runUrlTest({ runtime, row: rowOf('test:rpc:1'), http: chainIdAnswer('0x171') })
    expect(outcome.ok).toBe('fail')
    expect(outcome.message).toContain('chain 369')
  })

  test('a runtime that throws gives a failure with no URL in it, for an RPC row and for the indexer row', async () => {
    const { runtime } = buildRuntime({ indexerUrl: INDEXER, rpcUrls: { 1: RPC } })
    const throwing: ConnectionRuntime = {
      ...runtime,
      testRpcUrl: async (_chainId, url) => Promise.reject(new Error(`broke on ${url}`)),
      testIndexer: async (url) => Promise.reject(new Error(`broke on ${url}`)),
    }
    for (const id of ['test:rpc:1', 'test:indexer']) {
      const outcome = await runUrlTest({ runtime: throwing, row: rowOf(id), http: heads })
      expect(outcome.ok).toBe('fail')
      expect(outcome.message).toContain('broke on')
      expect(outcome.message).not.toContain(KEY)
    }
  })
})

describe('checkIndexerNow', () => {
  test('asks the connection and then names the source in use', async () => {
    const { runtime, connections } = buildRuntime()
    expect(await checkIndexerNow(runtime)).toBe('Checked. Using: indexer')
    expect(connections.latest().checks()).toBe(1)
  })

  test('a check that fails gives a message with no URL', async () => {
    const { pair, sharedPair } = livePair()
    const connections = fakeConnections({ checkNow: async () => Promise.reject(new Error(`probe failed at ${INDEXER}`)) })
    const runtime = createConnectionRuntime({
      pair,
      sharedPair,
      environment: {},
      user: { indexerUrl: INDEXER, rpcUrls: {} },
      createConnection: connections.createConnection,
      createChainAccess: fakeChainAccesses().createChainAccess,
    })
    const message = await checkIndexerNow(runtime)
    expect(message).toContain('The check failed: probe failed at')
    expect(message).not.toContain(KEY)
  })
})
