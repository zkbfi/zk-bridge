import { afterEach, describe, expect, test } from 'bun:test'
import { testRender } from '@opentui/react/test-utils'
import { act } from 'react'
import { ServicesProvider } from '../../src/app/services'
import { SessionProvider } from '../../src/app/session'
import { KeyRouterProvider } from '../../src/ui/key-router'
import { ReviewModal } from '../../src/ui/modals'
import { createFixtureChainAccess } from '../../src/chain/fixture-chain-access'
import type { ChainAccess } from '../../src/chain/chain-access'
import type { ChainSnapshotResult } from '../../src/chain/live-reads'
import { FIXTURE_PAIR } from '../../src/data/fixtures'
import { signerFromPrivateKeyText } from '../../src/signing/key-sources'
import type { AddressSource, DerivedAddress } from '../../src/signing/signer'
import { emptyProverSetup, type SecretStore } from '@zk-bridge/shared/config'
import { TEST_ADDRESS, TEST_KEY, memoryStore, renderApp } from './harness'

type App = Awaited<ReturnType<typeof renderApp>>
let app: App | null = null
afterEach(() => {
  app?.destroy()
  app = null
})

const signer = () => signerFromPrivateKeyText(TEST_KEY)

async function openAction(target: App, downs: number) {
  for (let step = 0; step < downs; step += 1) await target.press('ARROW_DOWN')
  await target.press('RETURN')
}

/** Fixture chain access whose gas estimate fails on the listed calls (counted from 1). */
function chainAccessFailingEstimates(failingCalls: readonly number[]): ChainAccess & { readonly estimateCalls: () => number } {
  const base = createFixtureChainAccess(FIXTURE_PAIR)
  let calls = 0
  const client = base.flowClient(1)
  return {
    ...base,
    estimateCalls: () => calls,
    flowClient: () => ({
      ...client,
      estimateGas: async (...parameters: Parameters<typeof client.estimateGas>) => {
        calls += 1
        if (failingCalls.includes(calls)) throw new Error('node refused the estimate')
        return client.estimateGas(...parameters)
      },
    }),
  }
}

/** Opens the review of a message to the other chain: a one-step review that needs no balance. */
async function openMessageReview(target: App) {
  await openAction(target, 2)
  await target.press('TAB')
  await target.type('0x0000000000000000000000000000000000000abc')
  await target.press('TAB')
  await target.type('0x1234')
  await target.press('RETURN')
  await target.settle(80)
}

describe('keys of the review modal', () => {
  test('d switches the calldata between the digest and every byte, and back', async () => {
    app = await renderApp({ width: 120, height: 40, initialSigner: signer() })
    await openMessageReview(app)
    expect(app.frame()).toMatch(/\d+ bytes, keccak256 0x/)
    await app.press('d')
    expect(app.frame()).toMatch(/Calldata \(\d+ bytes\)/)
    expect(app.frame()).not.toContain('keccak256')
    await app.press('d')
    expect(app.frame()).toMatch(/\d+ bytes, keccak256 0x/)
  })

  test('s does nothing on a step that is required: the review stays and nothing is sent', async () => {
    const chainAccess = createFixtureChainAccess(FIXTURE_PAIR)
    app = await renderApp({ width: 120, height: 40, initialSigner: signer(), chainAccess })
    await openMessageReview(app)
    await app.press('s')
    expect(app.frame()).toContain('requireToPassMessage(address,bytes,uint256)')
    expect(app.frame()).toContain('y sign and send')
    expect(chainAccess.sentTransactions).toHaveLength(0)
  })

  test('a failed estimate shows the error, and r prepares the same step again', async () => {
    const chainAccess = chainAccessFailingEstimates([1])
    app = await renderApp({ width: 120, height: 40, initialSigner: signer(), chainAccess })
    await openMessageReview(app)
    expect(app.frame()).toContain('node refused the estimate')
    expect(app.frame()).toContain('r retry')
    expect(chainAccess.estimateCalls()).toBe(1)
    await app.press('r')
    await app.settle(80)
    expect(chainAccess.estimateCalls()).toBe(2)
    expect(app.frame()).toContain('requireToPassMessage(address,bytes,uint256)')
    expect(app.frame()).not.toContain('node refused the estimate')
  })

  test('s cannot skip a required step after an error, and Esc closes the error', async () => {
    const chainAccess = chainAccessFailingEstimates([1])
    app = await renderApp({ width: 120, height: 40, initialSigner: signer(), chainAccess })
    await openMessageReview(app)
    await app.press('s') // the message step is required, so the error stays
    expect(app.frame()).toContain('node refused the estimate')
    await app.press('ESCAPE')
    expect(app.frame()).not.toContain('node refused the estimate')
  })

  test('Enter closes a finished sequence', async () => {
    const chainAccess = createFixtureChainAccess(FIXTURE_PAIR)
    app = await renderApp({ width: 120, height: 40, initialSigner: signer(), chainAccess })
    await openMessageReview(app)
    await app.press('y')
    await app.settle(200)
    expect(chainAccess.sentTransactions).toHaveLength(1)
    expect(app.frame()).toContain('All transactions are mined.')
    await app.press('RETURN')
    expect(app.frame()).not.toContain('All transactions are mined.')
  })

  test('Enter does not close a review that waits for a decision', async () => {
    app = await renderApp({ width: 120, height: 40, initialSigner: signer() })
    await openMessageReview(app)
    await app.press('RETURN')
    expect(app.frame()).toContain('y sign and send')
  })
})

describe('the message form', () => {
  test('a target that is not an address is refused on the form with the reason', async () => {
    app = await renderApp({ width: 120, height: 40, initialSigner: signer() })
    await openAction(app, 2)
    await app.press('TAB')
    await app.type('not-an-address')
    await app.press('TAB')
    await app.type('0x1234')
    await app.press('RETURN')
    await app.settle(40)
    expect(app.frame()).toContain('Send a message (requireToPassMessage)')
    expect(app.frame()).toMatch(/target/i)
    expect(app.frame()).not.toContain('requireToPassMessage(address,bytes,uint256)')
  })
})

/** A store whose calls fail on demand. Each method names its failure, so a test sees which one ran. */
function failingStore(failures: { readonly get?: string; readonly set?: string; readonly delete?: string }): SecretStore & { readonly values: Map<string, string> } {
  const base = memoryStore()
  return {
    ...base,
    values: base.values,
    get: async (name) => {
      if (failures.get !== undefined) throw new Error(failures.get)
      return base.get(name)
    },
    set: async (name, value) => {
      if (failures.set !== undefined) throw new Error(`${failures.set} ${value}`)
      return base.set(name, value)
    },
    delete: async (name) => {
      if (failures.delete !== undefined) throw new Error(failures.delete)
      return base.delete(name)
    },
  }
}

const RUNPOD_KEY = 'rpa_TESTONLY1234567890abcdefghijkl'
const keyReference = { source: 'store' as const, name: 'explorer.prover.runpod-api-key' }

describe('the prover setup when the secret store fails', () => {
  test('a value that cannot be read shows that and nothing of the value', async () => {
    const store = failingStore({ get: 'keychain locked' })
    app = await renderApp({ width: 120, height: 40, store, savedSetup: { ...emptyProverSetup(), runpodApiKey: keyReference } })
    await app.press('6')
    await app.settle(80)
    expect(app.frame()).toContain('stored (cannot read)')
  })

  test('d keeps the reference and shows the reason when the store cannot delete', async () => {
    const store = failingStore({ delete: 'keychain refused the delete' })
    app = await renderApp({ width: 120, height: 40, store, savedSetup: { ...emptyProverSetup(), runpodApiKey: keyReference } })
    await app.press('6')
    await app.settle(60)
    await app.press('ARROW_DOWN')
    await app.press('d')
    await app.settle(60)
    expect(app.frame()).toContain('keychain refused the delete')
    expect(app.saved).toHaveLength(0)
  })

  test('a failed save shows the reason without the secret, keeps the editor open and lets the user try again', async () => {
    const store = failingStore({ set: 'keychain refused' })
    app = await renderApp({ width: 120, height: 40, store })
    await app.press('6')
    await app.press('ARROW_DOWN')
    await app.press('RETURN')
    await app.type(RUNPOD_KEY)
    await app.press('RETURN')
    await app.settle(60)
    const shown = app.frame()
    expect(shown).toContain('keychain refused')
    expect(shown).not.toContain(RUNPOD_KEY)
    expect(app.saved).toHaveLength(0)
    expect(store.values.size).toBe(0)
    // The form takes keys again: Escape closes the editor.
    await app.press('ESCAPE')
    expect(app.frame()).not.toContain('Enter saves.')
  })
})

describe('the address list of a mnemonic', () => {
  const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

  function sourceWith(overrides: Partial<AddressSource>): AddressSource & { readonly opened: string[] } {
    const opened: string[] = []
    const listed: DerivedAddress[] = [{ index: 0, path: "m/44'/60'/0'/0/0", address: TEST_ADDRESS }]
    return {
      kind: 'mnemonic',
      opened,
      listAddresses: async () => listed,
      openSigner: async (path) => {
        opened.push(path)
        return signer()
      },
      dispose: async () => undefined,
      ...overrides,
    }
  }

  async function openPicker(source: AddressSource) {
    app = await renderApp({ width: 120, height: 40, signing: { mnemonicSource: () => source } })
    await app.press('RETURN')
    for (let step = 0; step < 3; step += 1) await app.press('ARROW_DOWN')
    await app.press('RETURN')
    await app.paste(MNEMONIC)
    await app.press('RETURN')
    await app.settle(80)
    return app
  }

  test('a list that fails shows the reason', async () => {
    const source = sourceWith({ listAddresses: async () => Promise.reject(new Error('derivation failed')) })
    await openPicker(source)
    expect(app!.frame()).toContain('derivation failed')
  })

  test('an address that fails to open shows the reason, and Enter tries it again', async () => {
    let attempts = 0
    const source = sourceWith({
      openSigner: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('device said no')
        return signer()
      },
    })
    await openPicker(source)
    await app!.press('RETURN')
    await app!.settle(60)
    expect(app!.frame()).toContain('device said no')
    expect(attempts).toBe(1)
    await app!.press('RETURN')
    await app!.settle(60)
    expect(attempts).toBe(2)
    expect(app!.frame()).toContain('0xf39F')
  })
})

describe('focus and number keys in the pair view', () => {
  test('Esc in the filters returns to the feed', async () => {
    app = await renderApp({ width: 120, height: 40 })
    await app.press('TAB')
    expect(app.frame()).toContain('Left/Right field')
    await app.press('ESCAPE')
    expect(app.frame()).toContain('Enter details')
  })

  test('a number key that the filters do not use switches the view', async () => {
    app = await renderApp({ width: 120, height: 40 })
    await app.press('TAB')
    await app.press('3')
    expect(app.frame()).toContain('[3 Audit]')
  })

  test('a number key that the feed does not use switches the view', async () => {
    app = await renderApp({ width: 120, height: 40 })
    await app.press('TAB')
    await app.press('TAB')
    expect(app.frame()).toContain('Enter details')
    await app.press('3')
    expect(app.frame()).toContain('[3 Audit]')
  })

  test('a number key that the global list does not use switches the view', async () => {
    app = await renderApp({ width: 120, height: 40 })
    await app.press('1')
    expect(app.frame()).toContain('[1 Global]')
    await app.press('4')
    expect(app.frame()).toContain('[4 Prover and costs]')
  })
})

describe('forms and reviews', () => {
  test('a key that the focused choice field does not use changes nothing', async () => {
    app = await renderApp({ width: 120, height: 40, initialSigner: signer() })
    await openAction(app, 2)
    const before = app.frame()
    expect(before).toContain('Send from')
    await app.press('x')
    expect(app.frame()).toBe(before)
  })
})

describe('the review modal without a signer', () => {
  test('says that no signer is connected and offers no way to sign', async () => {
    app = await renderApp({ width: 120, height: 40 })
    const closed: string[] = []
    const setup = await testRender(
      <ServicesProvider services={app.services}>
        <KeyRouterProvider>
          <SessionProvider pairId={app.services.defaultPairId} initialSigner={null}>
            <ReviewModal title="Review" steps={[]} onClose={() => closed.push('closed')} />
          </SessionProvider>
        </KeyRouterProvider>
      </ServicesProvider>,
      { width: 120, height: 40 },
    )
    try {
      await act(async () => {
        await setup.renderOnce()
      })
      const frame = setup.captureCharFrame()
      expect(frame).toContain('No signer is connected.')
      expect(frame).toContain('r retry')
      expect(frame).not.toContain('y sign and send')
    } finally {
      setup.renderer.destroy()
    }
  })
})
