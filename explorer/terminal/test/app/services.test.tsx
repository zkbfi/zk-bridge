import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Component, type ReactNode } from 'react'
import { testRender } from '@opentui/react/test-utils'
import {
  PasswordRequiredError,
  ServicesProvider,
  createDefaultProverSetupServices,
  createDefaultSigningServices,
  readFileHints,
  takeStartupSecrets,
  useServices,
} from '../../src/app/services'
import { emptyProverSetup, encryptedSecretsPath, setupFilePath } from '@zk-bridge/shared/config'
import { TEST_KEY } from '../ui/harness'
import { createFixtureChainAccess } from '../../src/chain/fixture-chain-access'
import { FIXTURE_PAIR, createFixtureDataSource } from '../../src/data/fixtures'
import { fetchClient } from '../../src/config/connection-tests'
import type { AppServices } from '../../src/app/services'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryEnvironment(extra: Record<string, string | undefined> = {}): Promise<Record<string, string | undefined>> {
  const directory = await mkdtemp(join(tmpdir(), 'terminal-services-'))
  directories.push(directory)
  return { EXPLORER_CONFIG_DIR: directory, ...extra }
}

describe('takeStartupSecrets', () => {
  test('returns each secret and removes it from the environment, so a child process cannot inherit it', () => {
    const environment: Record<string, string | undefined> = {
      EXPLORER_PRIVATE_KEY: 'key-text',
      EXPLORER_MNEMONIC: 'word word',
      EXPLORER_MNEMONIC_PASSPHRASE: 'phrase',
      EXPLORER_KEYSTORE_FILE: '/not/a/secret',
    }
    expect(takeStartupSecrets(environment)).toEqual({ privateKey: 'key-text', mnemonic: 'word word', mnemonicPassphrase: 'phrase' })
    expect(environment).toEqual({ EXPLORER_KEYSTORE_FILE: '/not/a/secret' })
  })

  test('an empty or missing variable is undefined', () => {
    expect(takeStartupSecrets({ EXPLORER_PRIVATE_KEY: '' })).toEqual({ privateKey: undefined, mnemonic: undefined, mnemonicPassphrase: undefined })
  })
})

describe('readFileHints', () => {
  test('reads the file paths and leaves them in the environment', () => {
    const environment = {
      EXPLORER_PRIVATE_KEY_FILE: '/k',
      EXPLORER_KEYSTORE_FILE: '/s',
      EXPLORER_MNEMONIC_FILE: '/m',
      EXPLORER_HANDOFF_FILE: '/h',
      EXPLORER_EVIDENCE_FILE: '/e',
    }
    expect(readFileHints(environment)).toEqual({ privateKeyFile: '/k', keystoreFile: '/s', mnemonicFile: '/m', handoffFile: '/h', evidenceFile: '/e' })
    expect(environment.EXPLORER_HANDOFF_FILE).toBe('/h')
    expect(readFileHints({})).toEqual({ privateKeyFile: undefined, keystoreFile: undefined, mnemonicFile: undefined, handoffFile: undefined, evidenceFile: undefined })
  })
})

describe('createDefaultSigningServices', () => {
  test('takes the secrets and the hints from the environment', () => {
    const environment: Record<string, string | undefined> = { EXPLORER_PRIVATE_KEY: TEST_KEY, EXPLORER_HANDOFF_FILE: '/h' }
    const services = createDefaultSigningServices(environment)
    expect(services.startupSecrets.privateKey).toBe(TEST_KEY)
    expect(services.fileHints.handoffFile).toBe('/h')
    expect(environment.EXPLORER_PRIVATE_KEY).toBeUndefined()
  })

  test('builds signers and sources of the right kind from the real libraries', async () => {
    const services = createDefaultSigningServices({})
    const signer = services.signerFromPrivateKeyText(TEST_KEY)
    expect(signer.kind).toBe('private-key')
    expect(signer.address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
    const mnemonic = services.mnemonicSource('test test test test test test test test test test test junk', '')
    expect(mnemonic.kind).toBe('mnemonic')
    const listed = await mnemonic.listAddresses({ pathTemplate: "m/44'/60'/0'/0/{index}", start: 0, count: 1 })
    expect(listed[0]?.address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
    expect(services.ledgerSource({}).kind).toBe('ledger')
    expect(services.trezorSource({}).kind).toBe('trezor')
  })

  test('reads a secret file and refuses a key file that others can read', async () => {
    const services = createDefaultSigningServices({})
    const environment = await temporaryEnvironment()
    const path = join(environment.EXPLORER_CONFIG_DIR!, 'key.txt')
    await Bun.write(path, `${TEST_KEY}\n`)
    await expect(services.readSecretText(path)).rejects.toThrow()
    await expect(services.signerFromPrivateKeyFile(path)).rejects.toThrow()
  })
})

describe('createDefaultProverSetupServices', () => {
  test('keeps the environment and the real command runner and HTTP client', () => {
    const environment = { EXPLORER_CONFIG_DIR: '/nowhere' }
    const services = createDefaultProverSetupServices(environment)
    expect(services.environment).toBe(environment)
    expect(services.http).toBe(fetchClient)
  })

  test('loads the empty setup when no file exists, and saves to and reloads from the setup file of the environment', async () => {
    const environment = await temporaryEnvironment()
    const services = createDefaultProverSetupServices(environment)
    expect(await services.load()).toEqual(emptyProverSetup())
    const setup = { ...emptyProverSetup(), endpointUrl: 'https://abc.example.test' }
    await services.save(setup)
    expect(JSON.parse(await readFile(setupFilePath(environment), 'utf8'))).toMatchObject({ endpointUrl: 'https://abc.example.test' })
    expect(await services.load()).toEqual(setup)
  })

  test('the command runner runs a real command', async () => {
    const services = createDefaultProverSetupServices({})
    const result = await services.run('echo', ['ok'])
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('ok')
  })
})

describe('openSecretStore', () => {
  // No test uses the real Keychain or Secret Service: the platform is whatever runs the test, so these tests
  // check the file path only on a platform that has neither, and otherwise check the shared choice by name.
  const noSystemStore = { platform: 'freebsd' } as const

  test('without a password the encrypted file fails with PasswordRequiredError and creates no file', async () => {
    const environment = await temporaryEnvironment()
    const services = createDefaultProverSetupServices(environment, noSystemStore)
    await expect(services.openSecretStore({ password: null })).rejects.toBeInstanceOf(PasswordRequiredError)
    await expect(stat(encryptedSecretsPath(environment))).rejects.toThrow()
  })

  test('with a password the encrypted file keeps a secret across stores, and the file holds no clear text', async () => {
    const environment = await temporaryEnvironment()
    const services = createDefaultProverSetupServices(environment, noSystemStore)
    const store = await services.openSecretStore({ password: 'correct horse' })
    expect(store.kind).toBe('encrypted-file')
    await store.set('api-key', 'secret-value-123')
    const again = await createDefaultProverSetupServices(environment, noSystemStore).openSecretStore({ password: 'correct horse' })
    expect(await again.get('api-key')).toBe('secret-value-123')
    expect(await readFile(encryptedSecretsPath(environment), 'utf8')).not.toContain('secret-value-123')
  })

  test('a wrong password fails when the store opens, not at the first save', async () => {
    const environment = await temporaryEnvironment()
    const services = createDefaultProverSetupServices(environment, noSystemStore)
    await (await services.openSecretStore({ password: 'right' })).set('a', 'b')
    await expect(services.openSecretStore({ password: 'wrong' })).rejects.toThrow()
  })

  test('PasswordRequiredError has its own name and message', () => {
    const error = new PasswordRequiredError()
    expect(error.name).toBe('PasswordRequiredError')
    expect(error.message).toBe('The secrets file needs a password.')
  })
})

/** Shows the message of an error that a child throws. A test needs this because the renderer swallows render errors. */
class CatchesErrors extends Component<{ readonly children: ReactNode }, { readonly message: string | null }> {
  override state = { message: null as string | null }
  static getDerivedStateFromError(error: Error) {
    return { message: error.message }
  }
  override render() {
    return this.state.message === null ? this.props.children : <text>{this.state.message}</text>
  }
}

describe('services context', () => {
  const services = {
    pair: FIXTURE_PAIR,
    dataSource: createFixtureDataSource(),
    chainAccess: createFixtureChainAccess(FIXTURE_PAIR),
    defaultPairId: 'eth-pls',
  } as unknown as AppServices

  function Reader() {
    return <text>{useServices().defaultPairId}</text>
  }

  test('useServices gives the services that the provider holds', async () => {
    const setup = await testRender(<ServicesProvider services={services}><Reader /></ServicesProvider>, { width: 20, height: 3 })
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain('eth-pls')
    setup.renderer.destroy()
  })

  test('useServices throws a clear error with no provider', async () => {
    const setup = await testRender(<CatchesErrors><Reader /></CatchesErrors>, { width: 60, height: 3 })
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain('useServices needs a ServicesProvider above it.')
    setup.renderer.destroy()
  })
})
