import { afterEach, describe, expect, test } from 'bun:test'
import { EMPTY_CONNECTION_SETTINGS, type ConnectionSettings, type HttpClient } from '@zk-bridge/shared'
import { CONNECTION_SECRET_NAMES } from '@zk-bridge/shared/config'
import { VIEWS, VIEW_LABELS } from '../../src/app/app-state'
import { PasswordRequiredError } from '../../src/app/services'
import { createConnectionRuntime } from '../../src/data/connection-runtime'
import { viewTabsTitle } from '../../src/ui/views'
import { REGISTRY_RPC_URL, fakeChainAccesses, fakeConnections, fallbackStatus, livePair } from '../support/live-support'
import { memoryStore, renderApp } from './harness'

type App = Awaited<ReturnType<typeof renderApp>>
let app: App | null = null
afterEach(() => {
  app?.destroy()
  app = null
})

// Made-up values. The key text is fake on purpose.
const KEY = 'FAKEKEY1234567890'
const RPC = `https://user.example.test/v1/${KEY}`
const INDEXER = `https://indexer.example.test/${KEY}`
const OTHER_CHAIN = `https://wrong.example.test/${KEY}/other-chain`

/** A node that reports chain 1 for every URL, except a URL that holds `other-chain`, which reports chain 2. */
const nodes: HttpClient = async (request) => {
  if (request.body?.includes('eth_chainId') !== true) return { status: 200, text: JSON.stringify({ heads: [] }) }
  return { status: 200, text: JSON.stringify({ result: request.url.includes('other-chain') ? '0x2' : '0x1' }) }
}

function setUp(options: { user?: ConnectionSettings; environment?: Parameters<typeof createConnectionRuntime>[0]['environment']; checkNow?: () => Promise<void> } = {}) {
  const { pair, sharedPair } = livePair()
  const connections = fakeConnections(options.checkNow === undefined ? {} : { checkNow: options.checkNow })
  const runtime = createConnectionRuntime({
    pair,
    sharedPair,
    environment: options.environment ?? {},
    user: options.user ?? EMPTY_CONNECTION_SETTINGS,
    createConnection: connections.createConnection,
    createChainAccess: fakeChainAccesses().createChainAccess,
  })
  return { pair, runtime, connections }
}

async function open(parts: ReturnType<typeof setUp>, extra: Partial<Parameters<typeof renderApp>[0]> = {}) {
  app = await renderApp({ width: 120, height: 40, pair: parts.pair, connection: parts.runtime, http: nodes, ...extra })
  await app.press('5')
  return app
}

async function selectRow(target: App, index: number) {
  for (let step = 0; step < index; step += 1) await target.press('ARROW_DOWN')
}

/** Records every frame so a test can check that no frame held a secret. */
function recorder(target: App) {
  const frames: string[] = []
  return {
    record: async () => {
      await target.settle(10)
      frames.push(target.frame())
    },
    neverContains: (text: string) => frames.every((frame) => !frame.includes(text)),
    count: () => frames.length,
  }
}

describe('the views are in order, with Prover setup last', () => {
  test('Connections comes just before Prover setup, which stays the last entry everywhere', () => {
    expect(VIEWS).toEqual(['global', 'pair', 'audit', 'prover', 'connections', 'setup'])
    expect(VIEWS[VIEWS.length - 1]).toBe('setup')
    expect(VIEW_LABELS.connections).toBe('Connections')
    expect(viewTabsTitle('pair', 120)).toContain('5 Connections  6 Prover setup')
    expect(viewTabsTitle('pair', 80)).toContain('5 Conn  6 Setup')
  })

  test('the help lists the keys in the same order with setup last', async () => {
    app = await renderApp({ width: 120, height: 40 })
    await app.press('?')
    const frame = app.frame()
    expect(frame).toContain('1 2 3 4 5')
    expect(frame.indexOf('connections views')).toBeLessThan(frame.lastIndexOf('Prover setup'))
  })

  test('the key 5 opens Connections and the key 6 opens Prover setup', async () => {
    const parts = setUp()
    await open(parts)
    expect(app!.frame()).toContain('[5 Connections]')
    await app!.press('6')
    expect(app!.frame()).toContain('[6 Prover setup]')
  })
})

describe('the Connections view shows each URL masked, with its source', () => {
  test('shows the line Using: indexer, the rows, the masked default and not set', async () => {
    const parts = setUp()
    await open(parts)
    const frame = app!.frame()
    expect(frame).toContain('Using: indexer')
    for (const label of ['Indexer URL', 'Ethereum RPC URL', 'PulseChain RPC URL', 'Test: indexer', 'Test: Ethereum RPC chain id', 'Test: PulseChain RPC chain id', 'Check the indexer now']) {
      expect(frame).toContain(label)
    }
    expect(frame).toContain('http://localhost:42069 (default)')
    expect(frame).toContain('https://registry.example.test/')
    expect(frame).toContain('(default)')
    expect(frame).not.toContain(REGISTRY_RPC_URL)
    expect(frame).toMatch(/PulseChain RPC URL\s+not set/)
  })

  test('names each source: set by you, from the environment, default', async () => {
    const parts = setUp({ user: { indexerUrl: INDEXER, rpcUrls: {} }, environment: { rpcUrls: { 369: 'https://env.example.test/ENVKEY0987654321' } } })
    await open(parts)
    const frame = app!.frame()
    expect(frame).toMatch(/Indexer URL\s+https:\/\/indexer\.example\.test\/\S+ \(set by you\)/)
    expect(frame).toMatch(/Ethereum RPC URL\s+https:\/\/registry\.example\.test\/\S+ \(default\)/)
    expect(frame).toMatch(/PulseChain RPC URL\s+https:\/\/env\.example\.test\/\S+ \(from the environment\)/)
    expect(frame).not.toContain(KEY)
    expect(frame).not.toContain('ENVKEY0987654321')
  })

  test('shows the line Using: RPC fallback with the reason, and follows a change of the status', async () => {
    const parts = setUp()
    await open(parts)
    parts.connections.latest().setStatus(fallbackStatus('indexer unreachable'))
    await app!.settle(20)
    expect(app!.frame()).toContain('Using: RPC fallback: indexer unreachable')
  })

  test('says that fixture data uses no connections, in fixture mode', async () => {
    app = await renderApp({ width: 120, height: 40 })
    await app.press('5')
    expect(app.frame()).toContain('[5 Connections]')
    expect(app.frame()).toContain('Fixture data uses no connections')
    expect(app.frame()).not.toContain('Indexer URL')
  })
})

describe('editing a URL', () => {
  test('saves an RPC URL that reports its chain: the store holds it, the row says set by you, no text holds the URL', async () => {
    const parts = setUp()
    const store = memoryStore()
    await open(parts, { store })
    const frames = recorder(app!)
    await selectRow(app!, 1)
    await app!.press('RETURN')
    await frames.record()
    await app!.type(RPC)
    await frames.record()
    await app!.press('RETURN')
    await app!.settle(60)
    await frames.record()
    expect(store.values.get(CONNECTION_SECRET_NAMES.rpcUrl(1))).toBe(RPC)
    expect(parts.runtime.resolved().rpcUrls[1]).toEqual({ value: RPC, source: 'user' })
    expect(app!.frame()).toMatch(/Ethereum RPC URL\s+https:\/\/user\.example\.test\/\S+ \(set by you\)/)
    expect(app!.frame()).toContain('Saved. The new URL is in use now.')
    expect(frames.count()).toBe(3)
    expect(frames.neverContains(KEY)).toBe(true)
  })

  test('saves an indexer URL with no chain test', async () => {
    const parts = setUp()
    const store = memoryStore()
    await open(parts, { store, http: async () => Promise.reject(new Error('no request expected')) })
    await app!.press('RETURN')
    await app!.type(INDEXER)
    await app!.press('RETURN')
    await app!.settle(60)
    expect(store.values.get(CONNECTION_SECRET_NAMES.indexerUrl)).toBe(INDEXER)
    expect(parts.runtime.resolved().indexerUrl?.source).toBe('user')
    expect(parts.connections.created).toHaveLength(2)
  })

  test('refuses a URL whose node reports another chain: nothing is saved, the editor stays, the message holds no URL', async () => {
    const parts = setUp()
    const store = memoryStore()
    await open(parts, { store })
    const frames = recorder(app!)
    await selectRow(app!, 1)
    await app!.press('RETURN')
    await app!.type(OTHER_CHAIN)
    await app!.press('RETURN')
    await app!.settle(60)
    await frames.record()
    expect(app!.frame()).toContain('Not saved.')
    expect(app!.frame()).toContain('The node is on chain 2, not chain 1.')
    expect(app!.frame()).toContain('Esc cancels')
    expect(store.values.size).toBe(0)
    expect(parts.connections.created).toHaveLength(1)
    expect(frames.neverContains(KEY)).toBe(true)
  })

  test('refuses a malformed URL with a message about the form, and keeps the editor open', async () => {
    const parts = setUp()
    const store = memoryStore()
    await open(parts, { store })
    await selectRow(app!, 1)
    await app!.press('RETURN')
    await app!.type('not a url')
    await app!.press('RETURN')
    await app!.settle(40)
    expect(app!.frame()).toContain('must not hold a space')
    expect(store.values.size).toBe(0)
  })

  test('an empty field and Esc both leave the setting as it was', async () => {
    const parts = setUp()
    const store = memoryStore()
    await open(parts, { store })
    await app!.press('RETURN')
    await app!.press('RETURN')
    expect(app!.frame()).not.toContain('Esc cancels')
    await app!.press('RETURN')
    await app!.type('http://x.example.test')
    await app!.press('ESCAPE')
    expect(app!.frame()).not.toContain('Esc cancels')
    expect(store.values.size).toBe(0)
    expect(parts.connections.created).toHaveLength(1)
  })

  test('the field never echoes what the user types', async () => {
    const parts = setUp()
    await open(parts)
    const frames = recorder(app!)
    await app!.press('RETURN')
    await app!.type('http://typed-host.example.test/SECRETPATH')
    await frames.record()
    expect(frames.neverContains('typed-host')).toBe(true)
    expect(frames.neverContains('SECRETPATH')).toBe(true)
  })

  test('a store that fails to save shows the reason without the URL and keeps the editor open', async () => {
    const parts = setUp()
    const store = { ...memoryStore(), set: async () => Promise.reject(new Error(`keychain refused ${RPC}`)) }
    await open(parts, { store })
    await selectRow(app!, 1)
    await app!.press('RETURN')
    await app!.type(RPC)
    await app!.press('RETURN')
    await app!.settle(60)
    expect(app!.frame()).toContain('keychain refused')
    expect(app!.frame()).not.toContain(KEY)
    expect(app!.frame()).toContain('Esc cancels')
  })
})

describe('forgetting a setting', () => {
  test('d removes the user setting from the store, and the row returns to the weaker source', async () => {
    const parts = setUp({ user: { indexerUrl: null, rpcUrls: { 1: RPC } } })
    const store = memoryStore()
    store.values.set(CONNECTION_SECRET_NAMES.rpcUrl(1), RPC)
    await open(parts, { store })
    await selectRow(app!, 1)
    expect(app!.frame()).toContain('(set by you)')
    await app!.press('d')
    await app!.settle(40)
    expect(store.values.size).toBe(0)
    expect(parts.runtime.resolved().rpcUrls[1]?.source).toBe('default')
    expect(app!.frame()).toContain('Forgotten.')
    expect(app!.frame()).not.toContain('(set by you)')
  })

  test('d on a row with no setting of yours says so, and d on a test row does nothing', async () => {
    const parts = setUp()
    await open(parts)
    await app!.press('d')
    await app!.settle(30)
    expect(app!.frame()).toContain('You set no value here')
    await selectRow(app!, 3)
    await app!.press('d')
    expect(parts.connections.created).toHaveLength(1)
  })

  test('d with no open store says that nothing can be forgotten', async () => {
    const parts = setUp()
    await open(parts, { openSecretStore: async () => Promise.reject(new Error('keychain locked')) })
    await app!.press('d')
    expect(app!.frame()).toContain('No secret store is open, so a setting cannot be forgotten.')
  })
})

describe('the secret store', () => {
  test('a locked store asks for a password, and the settings in it apply after the password', async () => {
    const parts = setUp()
    const store = memoryStore()
    store.values.set(CONNECTION_SECRET_NAMES.rpcUrl(1), RPC)
    const passwords: (string | null)[] = []
    await open(parts, {
      openSecretStore: async ({ password }) => {
        passwords.push(password)
        if (password === null) throw new PasswordRequiredError()
        return store
      },
    })
    expect(app!.frame()).toContain('Secrets file password')
    expect(app!.frame()).toContain('The secret file needs a password.')
    expect(parts.runtime.resolved().rpcUrls[1]?.source).toBe('default')
    await app!.type('FAKEPASSWORD')
    expect(app!.frame()).not.toContain('FAKEPASSWORD')
    await app!.press('RETURN')
    await app!.settle(80)
    expect(passwords).toEqual([null, 'FAKEPASSWORD'])
    expect(parts.runtime.resolved().rpcUrls[1]).toEqual({ value: RPC, source: 'user' })
    expect(app!.frame()).toContain('Settings are kept in an encrypted file.')
    expect(app!.frame()).not.toContain(KEY)
  })

  test('Esc on the prompt leaves the store closed, and editing then says why', async () => {
    const parts = setUp()
    await open(parts, { openSecretStore: async () => Promise.reject(new PasswordRequiredError()) })
    await app!.press('ESCAPE')
    expect(app!.frame()).toContain('No secret store is open. Secrets cannot be saved.')
    await app!.press('RETURN')
    expect(app!.frame()).toContain('No secret store is open, so a setting cannot be saved.')
    expect(app!.frame()).not.toContain('Esc cancels')
  })

  test('a store that fails to open shows a reason with the password removed', async () => {
    const parts = setUp()
    await open(parts, { openSecretStore: async () => Promise.reject(new Error('keychain locked')) })
    expect(app!.frame()).toContain('keychain locked')
  })

  test('a store with settings that cannot be read shows the reason and keeps the dashboard running', async () => {
    const parts = setUp()
    const store = { ...memoryStore(), get: async () => Promise.reject(new Error(`unreadable ${RPC}`)) }
    await open(parts, { store })
    expect(app!.frame()).toContain('unreadable')
    expect(app!.frame()).not.toContain(KEY)
  })
})

describe('the test rows test the URL in force now', () => {
  test('the indexer and the chain tests pass for a good URL and show PASS', async () => {
    const parts = setUp({ user: { indexerUrl: INDEXER, rpcUrls: { 1: RPC } } })
    await open(parts)
    await selectRow(app!, 3)
    await app!.press('RETURN')
    await app!.settle(40)
    expect(app!.frame()).toMatch(/Test: indexer\s+PASS/)
    await app!.press('ARROW_DOWN')
    await app!.press('RETURN')
    await app!.settle(40)
    expect(app!.frame()).toContain('PASS The node reports chain 1.')
  })

  test('a chain with no URL fails with a plain sentence', async () => {
    const parts = setUp()
    await open(parts)
    await selectRow(app!, 5)
    await app!.press('RETURN')
    await app!.settle(40)
    expect(app!.frame()).toContain('FAIL No RPC URL is set for chain 369.')
  })

  test('a failing test shows FAIL and a redacted message', async () => {
    const parts = setUp({ user: { indexerUrl: null, rpcUrls: { 1: RPC } } })
    const failing: HttpClient = async (request) => Promise.reject(new Error(`connect failed ${request.url}`))
    await open(parts, { http: failing })
    const frames = recorder(app!)
    await selectRow(app!, 4)
    await app!.press('RETURN')
    await app!.settle(40)
    await frames.record()
    expect(app!.frame()).toContain('FAIL')
    expect(frames.neverContains(KEY)).toBe(true)
  })

  test('a saved URL clears the old results, because they tested the old URL', async () => {
    const parts = setUp()
    await open(parts, { store: memoryStore() })
    await selectRow(app!, 5)
    await app!.press('RETURN')
    await app!.settle(40)
    expect(app!.frame()).toContain('FAIL')
    await app!.press('ARROW_UP')
    await app!.press('ARROW_UP')
    await app!.press('ARROW_UP')
    await app!.press('ARROW_UP')
    await app!.press('RETURN')
    await app!.type(RPC)
    await app!.press('RETURN')
    await app!.settle(60)
    expect(app!.frame()).not.toContain('FAIL')
  })

  test('the check row asks the indexer now and names the source in use', async () => {
    const parts = setUp()
    await open(parts)
    await selectRow(app!, 6)
    await app!.press('RETURN')
    await app!.settle(40)
    expect(parts.connections.latest().checks()).toBe(1)
    expect(app!.frame()).toContain('Checked. Using: indexer')
  })
})

describe('no screen text ever holds the URL', () => {
  test('after saving a URL with a key, no frame of any view holds the key', async () => {
    const parts = setUp()
    const store = memoryStore()
    await open(parts, { store })
    const frames = recorder(app!)
    for (const url of [INDEXER, RPC]) {
      await app!.press('RETURN')
      await frames.record()
      await app!.type(url)
      await frames.record()
      await app!.press('RETURN')
      await app!.settle(60)
      await frames.record()
      await app!.press('ARROW_DOWN')
    }
    for (let test = 0; test < 3; test += 1) {
      await app!.press('ARROW_DOWN')
      await app!.press('RETURN')
      await app!.settle(40)
      await frames.record()
    }
    for (const key of ['1', '2', '3', '4', '6', '?', '5']) {
      await app!.press(key)
      await frames.record()
      if (key === '?') await app!.press('ESCAPE')
    }
    expect(frames.count()).toBeGreaterThan(12)
    expect(frames.neverContains(KEY)).toBe(true)
    expect(frames.neverContains('user.example.test/v1')).toBe(true)
  })
})

describe('the footer shows the source and redraws when it changes', () => {
  test('shows indexer, then the RPC fallback with the reason, then indexer again', async () => {
    const parts = setUp()
    app = await renderApp({ width: 140, height: 40, pair: parts.pair, connection: parts.runtime, http: nodes })
    expect(app.frame()).toMatch(/ indexer\s*\n?/)
    expect(app.frame()).not.toContain('RPC fallback')
    parts.connections.latest().setStatus(fallbackStatus('indexer unreachable'))
    await app.settle(30)
    expect(app.frame()).toContain('RPC fallback: indexer unreachable')
    parts.connections.latest().setStatus({ kind: 'indexer', reason: null, label: 'indexer' })
    await app.settle(30)
    expect(app.frame()).not.toContain('RPC fallback')
  })

  test('follows a status change after a setting is applied, because the newest connection is listened to', async () => {
    const parts = setUp()
    app = await renderApp({ width: 140, height: 40, pair: parts.pair, connection: parts.runtime, http: nodes })
    parts.runtime.apply({ indexerUrl: INDEXER, rpcUrls: {} })
    parts.connections.latest().setStatus(fallbackStatus('indexer answered 500'))
    await app.settle(30)
    expect(app.frame()).toContain('RPC fallback: indexer answered 500')
  })

  test('cuts a long reason to the width, on one line, with an ellipsis', async () => {
    const parts = setUp()
    app = await renderApp({ width: 80, height: 24, pair: parts.pair, connection: parts.runtime, http: nodes })
    parts.connections.latest().setStatus(fallbackStatus('indexer is far behind the chain head and the reason text is very long indeed'))
    await app.settle(30)
    const lines = app.frame().split('\n')
    const footer = lines.filter((line) => line.includes('RPC fallback'))
    expect(footer).toHaveLength(1)
    expect(footer[0]).toContain('…')
    expect(footer[0]!.length).toBeLessThanOrEqual(80)
  })

  test('the fixed label shows in fixture mode', async () => {
    app = await renderApp({ width: 120, height: 40 })
    expect(app.frame()).toContain('fixture')
  })
})
