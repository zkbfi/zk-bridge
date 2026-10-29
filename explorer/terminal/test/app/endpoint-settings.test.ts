import { describe, expect, test } from 'bun:test'
import { EMPTY_CONNECTION_SETTINGS, ENDPOINT_KEYS, type HttpClient } from '@zk-bridge/shared'
import {
  ENDPOINT_LABELS,
  ENDPOINT_STORE_NAMES,
  connectionRows,
  forgetUrlSetting,
  hasUserSettings,
  loadEndpointSettings,
  loadUserSettings,
  sameSettings,
  saveUrlSetting,
  settingKeyOfRow,
  userUrlOfKey,
  withSetting,
} from '../../src/app/connections-model'
import { createConnectionRuntime } from '../../src/data/connection-runtime'
import { fakeChainAccesses, fakeConnections, livePair } from '../support/live-support'
import { memoryStore } from '../ui/harness'

const KEY = 'FAKEKEY1234567890'
const BACKEND = `https://backend.example.test/api/${KEY}`
const noRequest: HttpClient = async () => Promise.reject(new Error('an endpoint is saved without a request'))

function buildRuntime(user = EMPTY_CONNECTION_SETTINGS) {
  const { pair, sharedPair } = livePair()
  const runtime = createConnectionRuntime({
    pair,
    sharedPair,
    environment: {},
    user,
    createConnection: fakeConnections().createConnection,
    createChainAccess: fakeChainAccesses().createChainAccess,
  })
  return { runtime, pair }
}

describe('the endpoint rows', () => {
  test('the four endpoints follow the RPC rows, each row names its endpoint, and the words match the dapp', () => {
    const { pair } = buildRuntime()
    const endpointRows = connectionRows(pair).filter((row) => row.id.startsWith('endpoint:'))
    expect(endpointRows.map((row) => settingKeyOfRow(row))).toEqual(ENDPOINT_KEYS.map((key) => ({ kind: 'endpoint', key })))
    expect(endpointRows.map((row) => row.label)).toEqual(['Backend URL', 'Msgboard indexer URL', 'Archive URL', 'Msgboard node URL'])
    expect(ENDPOINT_KEYS.map((key) => ENDPOINT_LABELS[key])).toEqual(endpointRows.map((row) => row.label))
    expect(new Set(Object.values(ENDPOINT_STORE_NAMES)).size).toBe(4)
  })
})

describe('the settings of an endpoint', () => {
  test('a row key reads, sets and removes its own endpoint and leaves the others', () => {
    const key = { kind: 'endpoint', key: 'archiveUrl' } as const
    const start = { ...EMPTY_CONNECTION_SETTINGS, backendUrl: BACKEND }
    expect(userUrlOfKey(start, key)).toBeNull()
    const set = withSetting(start, key, 'https://archive.example.test')
    expect(userUrlOfKey(set, key)).toBe('https://archive.example.test')
    expect(set.backendUrl).toBe(BACKEND)
    expect(userUrlOfKey(withSetting(set, key, null), key)).toBeNull()
    expect(userUrlOfKey(start, { kind: 'indexer' })).toBeNull()
    expect(userUrlOfKey({ ...start, rpcUrls: { 1: 'https://rpc.example.test' } }, { kind: 'rpc', chainId: 1 })).toBe('https://rpc.example.test')
  })

  test('an endpoint counts as a setting of the user, and two settings differ when one endpoint differs', () => {
    const base = { ...EMPTY_CONNECTION_SETTINGS, msgboardUrl: 'https://node.example.test' }
    expect(hasUserSettings(base)).toBe(true)
    expect(hasUserSettings({ ...EMPTY_CONNECTION_SETTINGS, msgboardUrl: null })).toBe(false)
    expect(sameSettings(base, { ...base }, [1])).toBe(true)
    expect(sameSettings(base, { ...base, msgboardUrl: null }, [1])).toBe(false)
    expect(sameSettings(EMPTY_CONNECTION_SETTINGS, { ...EMPTY_CONNECTION_SETTINGS, backendUrl: null }, [1])).toBe(true)
  })
})

describe('keeping the endpoints', () => {
  test('saves a valid endpoint with no request, without its trailing slash, and the runtime resolves it as set by the user', async () => {
    const { runtime } = buildRuntime()
    const store = memoryStore()
    const result = await saveUrlSetting({ runtime, store, key: { kind: 'endpoint', key: 'backendUrl' }, text: `  ${BACKEND}/  `, http: noRequest })
    expect(result).toEqual({ ok: true })
    expect(store.values.get(ENDPOINT_STORE_NAMES.backendUrl)).toBe(BACKEND)
    expect(runtime.resolved().backendUrl).toEqual({ value: BACKEND, source: 'user' })
  })

  test('refuses an endpoint with a query, and the message does not repeat the text', async () => {
    const { runtime } = buildRuntime()
    const store = memoryStore()
    const result = await saveUrlSetting({ runtime, store, key: { kind: 'endpoint', key: 'archiveUrl' }, text: `https://archive.example.test/?token=${KEY}`, http: noRequest })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(KEY)
    expect(store.values.size).toBe(0)
    expect(runtime.resolved().archiveUrl).toBeNull()
  })

  test('forgets an endpoint, and says so when there is none to forget', async () => {
    const { runtime } = buildRuntime({ ...EMPTY_CONNECTION_SETTINGS, backendUrl: BACKEND })
    const store = memoryStore()
    store.values.set(ENDPOINT_STORE_NAMES.backendUrl, BACKEND)
    const key = { kind: 'endpoint', key: 'backendUrl' } as const
    expect(await forgetUrlSetting({ runtime, store, key })).toEqual({ ok: true })
    expect(store.values.size).toBe(0)
    expect(runtime.resolved().backendUrl).toBeNull()
    expect(await forgetUrlSetting({ runtime, store, key })).toEqual({ ok: false, message: 'You set no value here, so nothing is forgotten.' })
  })

  test('loads the saved endpoints, ignores a damaged one, and merges them with the indexer and the RPC URLs', async () => {
    const store = memoryStore()
    store.values.set(ENDPOINT_STORE_NAMES.backendUrl, BACKEND)
    store.values.set(ENDPOINT_STORE_NAMES.archiveUrl, 'not a url')
    expect(await loadEndpointSettings(store)).toEqual({ backendUrl: BACKEND, msgboardIndexerUrl: null, archiveUrl: null, msgboardUrl: null })
    const merged = await loadUserSettings(store, [1, 369])
    expect(merged).toMatchObject({ indexerUrl: null, rpcUrls: {}, backendUrl: BACKEND })
  })
})
