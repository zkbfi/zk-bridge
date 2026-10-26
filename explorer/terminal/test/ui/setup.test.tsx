import { afterEach, describe, expect, test } from 'bun:test'
import { VIEWS, VIEW_LABELS, createAppState } from '../../src/app/app-state'
import { PasswordRequiredError } from '../../src/app/services'
import type { HttpClient } from '../../src/config/connection-tests'
import { emptyProverSetup } from '@zk-bridge/shared/config'
import { viewTabsTitle } from '../../src/ui/views'
import { memoryStore, renderApp } from './harness'

type App = Awaited<ReturnType<typeof renderApp>>
let app: App | null = null
afterEach(() => {
  app?.destroy()
  app = null
})

// Made-up values with the real shapes. None is a live key.
const RUNPOD_KEY = 'rpa_TESTONLY1234567890abcdefghijkl'
const VALVE_URL = 'https://one.valve.city/rpc/vk_TESTONLY0987654321zyxwvu/evm/369'

/** Records frames so a test can check that no frame ever held a secret. */
function recorder(target: App) {
  const frames: string[] = []
  return {
    record: async () => {
      await target.settle(10)
      frames.push(target.frame())
    },
    neverContains: (secret: string) => frames.every((frame) => !frame.includes(secret)),
    count: () => frames.length,
  }
}

async function openSetup(target: App) {
  await target.press('6')
}

async function selectRow(target: App, index: number) {
  for (let step = 0; step < index; step += 1) await target.press('ARROW_DOWN')
}

describe('the Prover setup view is tucked away', () => {
  test('it is the last view in the switcher, and no other view comes after it', () => {
    expect(VIEWS[VIEWS.length - 1]).toBe('setup')
    expect(Object.keys(VIEW_LABELS).pop()).toBe('setup')
    expect(VIEWS.indexOf('setup')).toBe(VIEWS.length - 1)
  })

  test('the tab line lists it last at both widths', () => {
    expect(viewTabsTitle('pair', 120).endsWith('6 Prover setup')).toBe(true)
    expect(viewTabsTitle('pair', 80).endsWith('6 Setup')).toBe(true)
    expect(viewTabsTitle('setup', 120).endsWith('[6 Prover setup]')).toBe(true)
  })

  test('it is never the default: the dashboard opens on the pair view', () => {
    expect(createAppState('eth-pls').view).toBe('pair')
  })

  test('the help lists it as its last row, after quit', async () => {
    app = await renderApp({ width: 120, height: 40 })
    await app.press('?')
    const rows = app
      .frame()
      .split('\n')
      .map((line) => /║([^║]*)║/.exec(line)?.[1]?.trim() ?? '')
      .filter((text) => text !== '' && !text.includes('Press any key') && !text.includes('═'))
    expect(rows[rows.length - 1]).toContain('Prover setup')
    expect(rows[rows.length - 2]).toContain('Quit')
  })

  test('the key bar of the main views does not offer it', async () => {
    app = await renderApp({ width: 120, height: 40 })
    expect(app.frame()).toContain('1-5 views')
    expect(app.frame()).not.toMatch(/1-6 views/)
  })

  test('the number 6 opens it, and the main views stay one key away', async () => {
    app = await renderApp({ width: 120, height: 40 })
    await openSetup(app)
    expect(app.frame()).toContain('[6 Prover setup]')
    expect(app.frame()).toContain('Test: endpoint /ping')
    await app.press('2')
    expect(app.frame()).toContain('[2 Pair]')
  })
})

describe('entering configuration', () => {
  test('saves the endpoint URL and refuses an insecure one', async () => {
    app = await renderApp({ width: 120, height: 40 })
    await openSetup(app)
    await app.press('RETURN')
    await app.type('http://remote.example.com')
    await app.press('RETURN')
    expect(app.frame()).toContain('must use https')
    for (let count = 0; count < 40; count += 1) await app.press('BACKSPACE')
    await app.type('https://abc123.api.runpod.ai')
    await app.press('RETURN')
    await app.settle(40)
    expect(app.frame()).toContain('https://abc123.api.runpod.ai')
    expect(app.saved.at(-1)?.endpointUrl).toBe('https://abc123.api.runpod.ai')
  })

  test('a secret is masked while typed, stored in the secret store, shown only by its last four characters, and absent from the file', async () => {
    const store = memoryStore()
    app = await renderApp({ width: 120, height: 40, store })
    const seen = recorder(app)
    await openSetup(app)
    await selectRow(app, 1) // RunPod API key
    await app.press('RETURN')
    await app.type(RUNPOD_KEY)
    await seen.record()
    expect(app.frame()).toContain(`(${RUNPOD_KEY.length} characters)`)
    await app.press('RETURN')
    await app.settle(60)
    await seen.record()
    const shown = app.frame()
    expect(shown).toContain(`********${RUNPOD_KEY.slice(-4)}`)
    expect(store.values.get('explorer.prover.runpod-api-key')).toBe(RUNPOD_KEY)
    expect(JSON.stringify(app.saved)).not.toContain(RUNPOD_KEY)
    expect(JSON.stringify(app.saved)).not.toContain('rpa_')
    expect(app.saved.at(-1)?.runpodApiKey).toEqual({ source: 'store', name: 'explorer.prover.runpod-api-key' })
    expect(seen.neverContains(RUNPOD_KEY)).toBe(true)
    expect(seen.neverContains(RUNPOD_KEY.slice(0, 20))).toBe(true)
    expect(seen.count()).toBeGreaterThan(1)
  })

  test('a reference stores nothing: an environment variable shows its masked tail, and 1Password shows the reference', async () => {
    const store = memoryStore()
    app = await renderApp({ width: 120, height: 40, store, environment: { MSGBOARD_URL_FOR_TEST: VALVE_URL } })
    const seen = recorder(app)
    await openSetup(app)
    await selectRow(app, 6) // msgboard
    await app.press('RETURN')
    await app.press('TAB')
    await app.type('env:MSGBOARD_URL_FOR_TEST')
    await app.press('RETURN')
    await app.settle(60)
    await seen.record()
    expect(app.frame()).toContain('env:MSGBOARD_URL_FOR_TEST')
    expect(app.frame()).toContain(`********${VALVE_URL.slice(-4)}`)
    expect(store.values.size).toBe(0)
    await app.press('RETURN')
    await app.press('TAB')
    for (let count = 0; count < 40; count += 1) await app.press('BACKSPACE')
    await app.type('op://vault/item/field')
    await app.press('RETURN')
    await app.settle(60)
    expect(app.frame()).toContain('op://vault/item/field')
    expect(seen.neverContains(VALVE_URL)).toBe(true)
    expect(seen.neverContains('vk_TESTONLY')).toBe(true)
  })

  test('refuses both a secret and a reference at once, and a reference that is really a literal secret', async () => {
    app = await renderApp({ width: 120, height: 40 })
    await openSetup(app)
    await selectRow(app, 1)
    await app.press('RETURN')
    await app.type('some-secret-value-123')
    await app.press('TAB')
    await app.type('env:SOMETHING')
    await app.press('RETURN')
    expect(app.frame()).toContain('Fill one of the two fields, not both.')
    await app.press('ESCAPE')
    await app.press('RETURN')
    await app.press('TAB')
    await app.type(RUNPOD_KEY)
    await app.press('RETURN')
    expect(app.frame()).toContain('A reference is env:NAME or op://vault/item/field')
  })

  test('toggles the directions and the policy, and saves the interval', async () => {
    app = await renderApp({ width: 120, height: 40 })
    await openSetup(app)
    await selectRow(app, 7)
    await app.press('RETURN')
    expect(app.frame()).toContain('ETH>PLS')
    expect(app.saved.at(-1)?.directions).toEqual(['first-to-second'])
    await app.press('ARROW_DOWN')
    await app.press('RETURN')
    expect(app.saved.at(-1)?.policy.proveWhenTransferWaits).toBe(false)
    await app.press('ARROW_DOWN')
    await app.press('RETURN')
    for (let count = 0; count < 8; count += 1) await app.press('BACKSPACE')
    await app.type('900')
    await app.press('RETURN')
    expect(app.saved.at(-1)?.policy.intervalSeconds).toBe(900)
  })

  test('d forgets a stored secret and deletes it from the store', async () => {
    const store = memoryStore()
    await store.set('explorer.prover.runpod-api-key', RUNPOD_KEY)
    app = await renderApp({
      width: 120,
      height: 40,
      store,
      savedSetup: { ...emptyProverSetup(), runpodApiKey: { source: 'store', name: 'explorer.prover.runpod-api-key' } },
    })
    await openSetup(app)
    await app.settle(60)
    expect(app.frame()).toContain(`********${RUNPOD_KEY.slice(-4)}`)
    await selectRow(app, 1)
    await app.press('d')
    await app.settle(60)
    expect(store.values.size).toBe(0)
    expect(app.saved.at(-1)?.runpodApiKey).toBeNull()
  })

  test('asks for a password when the platform has no secret store, without echoing it', async () => {
    const store = memoryStore()
    const passwords: Array<string | null> = []
    app = await renderApp({
      width: 120,
      height: 40,
      openSecretStore: async ({ password }) => {
        passwords.push(password)
        if (password === null) throw new PasswordRequiredError()
        return store
      },
    })
    const seen = recorder(app)
    await openSetup(app)
    await app.settle(60)
    expect(app.frame()).toContain('Secrets file password')
    await app.type('my-file-password')
    await seen.record()
    expect(app.frame()).toContain('(16 characters)')
    await app.press('RETURN')
    await app.settle(60)
    await seen.record()
    expect(passwords).toEqual([null, 'my-file-password'])
    expect(app.frame()).not.toContain('Secrets file password')
    expect(seen.neverContains('my-file-password')).toBe(true)
  })
})

describe('the tests of the view', () => {
  async function configured(http: HttpClient) {
    const store = memoryStore()
    await store.set('explorer.prover.runpod-api-key', RUNPOD_KEY)
    await store.set('explorer.prover.chain.369.rpc', VALVE_URL)
    await store.set('explorer.prover.msgboard-url', VALVE_URL)
    return renderApp({
      width: 120,
      height: 40,
      store,
      http,
      savedSetup: {
        ...emptyProverSetup(),
        endpointUrl: 'https://abc123.api.runpod.ai',
        runpodApiKey: { source: 'store', name: 'explorer.prover.runpod-api-key' },
        chains: { '369': { rpc: { source: 'store', name: 'explorer.prover.chain.369.rpc' }, beacon: null } },
        msgboardUrl: { source: 'store', name: 'explorer.prover.msgboard-url' },
      },
    })
  }

  test('the ping test sends the key as a bearer header and shows PASS, with no secret on screen', async () => {
    const requests: Array<{ url: string; authorization: string | undefined }> = []
    const http: HttpClient = async (request) => {
      requests.push({ url: request.url, authorization: request.headers?.Authorization })
      return { status: 200, text: '{"status":"ready"}' }
    }
    app = await configured(http)
    const seen = recorder(app)
    await openSetup(app)
    await app.settle(60)
    await selectRow(app, 10)
    await app.press('RETURN')
    await app.settle(60)
    await seen.record()
    expect(app.frame()).toContain('PASS')
    expect(app.frame()).toContain('ready')
    expect(requests).toEqual([{ url: 'https://abc123.api.runpod.ai/ping', authorization: `Bearer ${RUNPOD_KEY}` }])
    expect(seen.neverContains(RUNPOD_KEY)).toBe(true)
  })

  test('the dry proof test passes on 400, the RPC test compares the chain, and msgboard status runs', async () => {
    const methods: string[] = []
    const http: HttpClient = async (request) => {
      if (request.url.endsWith('/prove')) return { status: 400, text: '{"error":"no program"}' }
      const method = (JSON.parse(request.body ?? '{}') as { method: string }).method
      methods.push(method)
      return { status: 200, text: method === 'eth_chainId' ? '{"result":"0x171"}' : '{"result":{"ok":true}}' }
    }
    app = await configured(http)
    await openSetup(app)
    await app.settle(60)
    await selectRow(app, 11)
    await app.press('RETURN')
    await app.press('ARROW_DOWN')
    await app.press('ARROW_DOWN')
    await app.press('RETURN') // chain 369 is row 13
    await app.press('ARROW_DOWN')
    await app.press('RETURN')
    await app.settle(100)
    const frame = app.frame()
    expect(frame).toMatch(/Test: dry proof request +PASS/)
    expect(frame).toMatch(/Test: PulseChain RPC chain id +PASS The node reports chain 369/)
    expect(frame).toMatch(/Test: msgboard status\(\) +PASS/)
    expect(methods).toEqual(['eth_chainId', 'msgboard_status'])
  })

  test('a failure shows the reason with every secret redacted', async () => {
    const http: HttpClient = async (request) => {
      throw new Error(`connect ECONNREFUSED ${request.url} with Bearer ${RUNPOD_KEY}`)
    }
    app = await configured(http)
    const seen = recorder(app)
    await openSetup(app)
    await app.settle(60)
    await selectRow(app, 13)
    await app.press('RETURN')
    await app.settle(100)
    await seen.record()
    expect(app.frame()).toContain('FAIL')
    expect(seen.neverContains('vk_TESTONLY')).toBe(true)
    expect(seen.neverContains(RUNPOD_KEY)).toBe(true)
  })

  test('a test with a missing secret says what is missing and sends nothing', async () => {
    let calls = 0
    app = await renderApp({ width: 120, height: 40, http: async () => { calls += 1; return { status: 200, text: '' } } })
    await openSetup(app)
    await app.settle(60)
    await selectRow(app, 10)
    await app.press('RETURN')
    await app.settle(60)
    expect(app.frame()).toContain('The endpoint URL is not set.')
    expect(calls).toBe(0)
  })
})

describe('snapshots hold no secret', () => {
  test('no snapshot file contains a key, a keyed URL, a mnemonic or a password from these tests', async () => {
    const { readdir, readFile } = await import('node:fs/promises')
    const directory = new URL('./__snapshots__/', import.meta.url)
    const files = (await readdir(directory)).filter((name) => name.endsWith('.snap'))
    expect(files.length).toBeGreaterThan(0)
    for (const name of files) {
      const text = await readFile(new URL(name, directory), 'utf8')
      for (const secret of ['rpa_', 'vk_', 'abandon abandon', 'ac0974bec39a17e3', 'correct horse', 'my-file-password']) {
        expect(text.includes(secret), `${name} holds "${secret}"`).toBe(false)
      }
    }
  })
})
