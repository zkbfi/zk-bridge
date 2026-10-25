/**
 * Test harness for the dashboard: renders the whole app on the OpenTUI test renderer with fixture services, a pinned
 * clock, a software signer with a published test key, and in-memory setup services. No network, no real device.
 */
import { testRender } from '@opentui/react/test-utils'
import { act } from 'react'
import { App } from '../../src/app/App'
import type { AppServices, ProverSetupServices, SigningServices } from '../../src/app/services'
import { createFixtureChainAccess } from '../../src/chain/fixture-chain-access'
import type { ChainAccess } from '../../src/chain/chain-access'
import type { HttpClient } from '../../src/config/connection-tests'
import type { ProverSetup } from '../../src/config/prover-setup'
import { emptyProverSetup } from '../../src/config/prover-setup'
import type { SecretStore } from '../../src/config/secret-store'
import { FIXTURE_NOW, FIXTURE_PAIR, createFixtureDataSource } from '../../src/data/fixtures'
import type { DataSource } from '../../src/data/data-source'
import { signerFromPrivateKeyText } from '../../src/signing/key-sources'
import { createMnemonicSource } from '../../src/signing/mnemonic'
import type { Signer } from '../../src/signing/signer'

/** The first public Anvil development key. It is a published test value. */
export const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

/** An in-memory secret store that records what is written. */
export function memoryStore(): SecretStore & { readonly values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    kind: 'encrypted-file',
    values,
    async get(name) {
      return values.get(name) ?? null
    },
    async set(name, value) {
      values.set(name, value)
    },
    async delete(name) {
      values.delete(name)
    },
  }
}

export interface HarnessOptions {
  readonly width: number
  readonly height: number
  readonly dataSource?: DataSource
  readonly chainAccess?: ChainAccess
  readonly signing?: Partial<SigningServices>
  readonly initialSigner?: Signer | null
  readonly files?: Readonly<Record<string, string>>
  readonly http?: HttpClient
  readonly store?: SecretStore
  readonly savedSetup?: ProverSetup
  readonly environment?: Record<string, string | undefined>
  readonly openSecretStore?: ProverSetupServices['openSecretStore']
}

const noStartupSecrets = { privateKey: undefined, mnemonic: undefined, mnemonicPassphrase: undefined }
const noHints = { privateKeyFile: undefined, keystoreFile: undefined, mnemonicFile: undefined, handoffFile: undefined, evidenceFile: undefined }

/** Renders the app and returns helpers to drive it. */
export async function renderApp(options: HarnessOptions) {
  const chainAccess = options.chainAccess ?? createFixtureChainAccess(FIXTURE_PAIR)
  const store = options.store ?? memoryStore()
  const saved: ProverSetup[] = []
  let current = options.savedSetup ?? emptyProverSetup()
  const proverSetup: ProverSetupServices = {
    environment: options.environment ?? {},
    run: async () => ({ code: 1, stdout: '', stderr: 'no commands in tests' }),
    http: options.http ?? (async () => ({ status: 200, text: '{}' })),
    load: async () => current,
    save: async (setup) => {
      current = setup
      saved.push(setup)
    },
    openSecretStore: options.openSecretStore ?? (async () => store),
  }
  const signing: SigningServices = {
    startupSecrets: noStartupSecrets,
    fileHints: noHints,
    signerFromPrivateKeyText,
    signerFromPrivateKeyFile: async () => signerFromPrivateKeyText(TEST_KEY),
    signerFromKeystoreFile: async () => signerFromPrivateKeyText(TEST_KEY),
    readSecretText: async () => TEST_KEY,
    mnemonicSource: (mnemonic, passphrase) => createMnemonicSource({ mnemonic, passphrase }),
    ledgerSource: () => {
      throw new Error('no Ledger in this test')
    },
    trezorSource: () => {
      throw new Error('no Trezor in this test')
    },
    ...options.signing,
  }
  let quitCount = 0
  const services: AppServices = {
    pair: FIXTURE_PAIR,
    dataSource: options.dataSource ?? createFixtureDataSource({ now: () => FIXTURE_NOW }),
    chainAccess,
    signing,
    proverSetup,
    now: () => FIXTURE_NOW,
    readTextFile: async (path) => {
      const text = options.files?.[path]
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return text
    },
    quit: () => {
      quitCount += 1
    },
    defaultPairId: FIXTURE_PAIR.id,
  }
  const setup = await testRender(<App services={services} initialSigner={options.initialSigner ?? null} />, {
    width: options.width,
    height: options.height,
  })

  const settle = async (milliseconds = 40) => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, milliseconds))
    })
    await act(async () => {
      await setup.renderOnce()
    })
    await act(async () => {
      await setup.renderOnce()
    })
  }
  await settle()

  return {
    setup,
    services,
    chainAccess,
    store,
    saved,
    quits: () => quitCount,
    frame: () => setup.captureCharFrame(),
    settle,
    async press(name: Parameters<typeof setup.mockInput.pressKey>[0], modifiers?: Parameters<typeof setup.mockInput.pressKey>[1]) {
      await act(async () => {
        if (name === 'ESCAPE') setup.mockInput.pressEscape(modifiers)
        else setup.mockInput.pressKey(name, modifiers)
      })
      // A lone Escape waits for a short timeout in the key parser, so it needs more time than other keys.
      await settle(name === 'ESCAPE' ? 120 : 10)
    },
    async type(text: string) {
      await act(async () => {
        await setup.mockInput.typeText(text)
      })
      await settle(10)
    },
    async paste(text: string) {
      await act(async () => {
        await setup.mockInput.pasteBracketedText(text)
      })
      await settle(10)
    },
    async resize(width: number, height: number) {
      await act(async () => {
        setup.resize(width, height)
      })
      await settle(10)
    },
    destroy() {
      setup.renderer.destroy()
    },
  }
}

/** The text of a signer-less address of the test key, for assertions. */
export const TEST_ADDRESS = signerFromPrivateKeyText(TEST_KEY).address
