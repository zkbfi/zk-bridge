import { afterEach, describe, expect, test } from 'bun:test'
import { PasswordRequiredError } from '../../src/app/services'
import { signerFromPrivateKeyText } from '../../src/signing/key-sources'
import type { AddressSource, Signer } from '../../src/signing/signer'
import { emptyProverSetup } from '@zk-bridge/shared/config'
import { TEST_ADDRESS, TEST_KEY, memoryStore, renderApp } from './harness'

type App = Awaited<ReturnType<typeof renderApp>>
let app: App | null = null
afterEach(() => {
  app?.destroy()
  app = null
})

/** A ledger source over one fixed address. It records what the app closes. */
function recordingLedger() {
  const closed: string[] = []
  const signer: Signer = {
    ...signerFromPrivateKeyText(TEST_KEY),
    dispose: async () => {
      closed.push('signer')
    },
  }
  const source: AddressSource = {
    kind: 'ledger',
    listAddresses: async () => [{ index: 0, path: "m/44'/60'/0'/0/0", address: TEST_ADDRESS }],
    openSigner: async () => signer,
    dispose: async () => {
      closed.push('source')
    },
  }
  return { closed, source }
}

async function openSignerDialog(target: App) {
  await target.press('RETURN') // the first action is "Account and signer"
}

describe('the signer dialog', () => {
  test('a hardware signer keeps its device open, and disconnecting closes the signer and then the device', async () => {
    const { closed, source } = recordingLedger()
    app = await renderApp({ width: 120, height: 40, signing: { ledgerSource: () => source } })
    await openSignerDialog(app)
    for (let step = 0; step < 4; step += 1) await app.press('ARROW_DOWN')
    await app.press('RETURN')
    await app.settle(60)
    await app.press('RETURN')
    await app.settle(60)
    expect(app.frame()).toContain('0xf39F')
    expect(closed).toEqual([])
    await openSignerDialog(app)
    for (let step = 0; step < 6; step += 1) await app.press('ARROW_DOWN')
    await app.press('RETURN')
    await app.settle(60)
    expect(closed).toEqual(['signer', 'source'])
    expect(app.frame()).toContain('no signer connected')
  })

  test('Esc in the address list closes the device source once and returns to the choices', async () => {
    const { closed, source } = recordingLedger()
    app = await renderApp({ width: 120, height: 40, signing: { ledgerSource: () => source } })
    await openSignerDialog(app)
    for (let step = 0; step < 4; step += 1) await app.press('ARROW_DOWN')
    await app.press('RETURN')
    await app.settle(60)
    await app.press('ESCAPE')
    expect(closed).toEqual(['source'])
    expect(app.frame()).toContain('Private key file')
  })

  test('Esc in a secret form returns to the choices', async () => {
    app = await renderApp({ width: 120, height: 40 })
    await openSignerDialog(app)
    await app.press('RETURN')
    expect(app.frame()).toContain('Connect: private-key')
    await app.press('ESCAPE')
    expect(app.frame()).toContain('Private key file')
    expect(app.frame()).not.toContain('Connect: private-key')
  })

  test('Esc in the path form of the address list keeps the old path and shows the list again', async () => {
    const { source } = recordingLedger()
    app = await renderApp({ width: 120, height: 40, signing: { ledgerSource: () => source } })
    await openSignerDialog(app)
    for (let step = 0; step < 4; step += 1) await app.press('ARROW_DOWN')
    await app.press('RETURN')
    await app.settle(60)
    await app.press('t')
    expect(app.frame()).not.toContain(TEST_ADDRESS)
    await app.press('ESCAPE')
    await app.settle(40)
    expect(app.frame()).toContain(TEST_ADDRESS)
  })
})

describe('the prover setup when loading, saving and opening the store fail', () => {
  test('a setup that cannot load shows the reason', async () => {
    app = await renderApp({ width: 120, height: 40, proverSetupOverrides: { load: async () => Promise.reject(new Error('setup file is damaged')) } })
    await app.press('5')
    await app.settle(60)
    expect(app.frame()).toContain('setup file is damaged')
  })

  test('a setup that cannot be saved says so, and the change stays on screen', async () => {
    app = await renderApp({ width: 120, height: 40, proverSetupOverrides: { save: async () => Promise.reject(new Error('disk is full')) } })
    await app.press('5')
    for (let step = 0; step < 7; step += 1) await app.press('ARROW_DOWN')
    await app.press('RETURN') // directions
    await app.settle(60)
    expect(app.frame()).toContain('Not saved: disk is full')
    expect(app.frame()).toContain('ETH>PLS')
  })

  test('a store that fails to open shows the reason and never the password', async () => {
    app = await renderApp({
      width: 120,
      height: 40,
      openSecretStore: async ({ password }) => {
        if (password === null) throw new PasswordRequiredError()
        throw new Error(`cannot decrypt with ${password}`)
      },
    })
    await app.press('5')
    await app.settle(60)
    await app.type('my-file-password')
    await app.press('RETURN')
    await app.settle(60)
    expect(app.frame()).toContain('cannot decrypt')
    expect(app.frame()).not.toContain('my-file-password')
  })

  test('Esc at the password prompt leaves the store closed and says secrets cannot be saved', async () => {
    app = await renderApp({
      width: 120,
      height: 40,
      store: memoryStore(),
      openSecretStore: async () => Promise.reject(new PasswordRequiredError()),
    })
    await app.press('5')
    await app.settle(60)
    expect(app.frame()).toContain('Secrets file password')
    await app.press('ESCAPE')
    expect(app.frame()).not.toContain('Secrets file password')
    expect(app.frame()).toContain('No secret store is open. Secrets cannot be saved.')
  })

  test('Esc in the text editor closes it and saves nothing', async () => {
    app = await renderApp({ width: 120, height: 40 })
    await app.press('5')
    await app.press('RETURN')
    await app.type('https://abc123.api.runpod.ai')
    await app.press('ESCAPE')
    expect(app.saved).toHaveLength(0)
    expect(app.frame()).not.toContain('For example https://')
  })
})

describe('the tests of the prover setup view', () => {
  test('a test that needs a value which is not set fails with that reason and sends no request', async () => {
    const requests: string[] = []
    app = await renderApp({
      width: 120,
      height: 40,
      http: async (request) => {
        requests.push(request.url)
        return { status: 200, text: '{}' }
      },
      savedSetup: { ...emptyProverSetup(), endpointUrl: 'https://abc123.api.runpod.ai' },
    })
    await app.press('5')
    await app.settle(60)
    for (let step = 0; step < 10; step += 1) await app.press('ARROW_DOWN')
    await app.press('RETURN') // the ping test
    await app.settle(60)
    expect(app.frame()).toContain('The RunPod API key is not set.')
    expect(requests).toEqual([])
  })
})
