import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildServices, type BootstrapMachine } from '../../src/app/bootstrap'
import { FIXTURE_PAIR } from '../../src/data/fixtures'
import { PasswordRequiredError, type ProverSetupServices } from '../../src/app/services'
import { CONNECTION_SECRET_NAMES } from '@zk-bridge/shared/config'
import { memoryStore } from '../ui/harness'

// The first public Anvil development key, and the address it owns.
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

const section = (chainId: number, tag: string) => ({
  chain_id: chainId,
  bridge: `0x${tag}1`.padEnd(42, '0'),
  mediator: `0x${tag}2`.padEnd(42, '0'),
  light_client: `0x${tag}3`.padEnd(42, '0'),
  native_router: `0x${tag}4`.padEnd(42, '0'),
  wrapped_native: `0x${tag}5`.padEnd(42, '0'),
  gate: `0x${tag}6`.padEnd(42, '0'),
  // The shared registry (explorer/shared) checks these two fields too, so a live start needs them.
  token_factory: `0x${tag}7`.padEnd(42, '0'),
  start_block: 10,
})
const DEPLOYMENT = JSON.stringify({ ethereum: section(1, 'a'), pulsechain: section(369, 'b') })

const scratch: string[] = []
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

/** A machine with an environment, a clock fixed at 1000 and a read function that serves the given files. */
function machineWith(environment: Record<string, string>, files: Record<string, string> = {}): BootstrapMachine & { readonly paths: string[] } {
  const paths: string[] = []
  return {
    environment: { ...environment },
    workingDirectory: '/work/terminal',
    now: () => 1000,
    paths,
    readTextFile: async (path) => {
      paths.push(path)
      const text = files[path]
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return text
    },
  }
}

describe('buildServices with fixture data', () => {
  test('uses the sample pair and sample chains, reads no deployment file and opens no signer', async () => {
    const machine = machineWith({ EXPLORER_DATA: 'fixture' })
    const { services, initialSigner } = await buildServices(machine)
    expect(services.pair).toBe(FIXTURE_PAIR)
    expect(services.defaultPairId).toBe(FIXTURE_PAIR.id)
    expect(services.chainAccess.mode).toBe('fixture')
    expect(services.connection).toBeNull()
    expect(machine.paths).toEqual([])
    expect(initialSigner).toBeNull()
  })

  test('gives the clock and the file reader of the machine to the services', async () => {
    const machine = machineWith({ EXPLORER_DATA: 'fixture' }, { '/some/file': 'text' })
    const { services } = await buildServices(machine)
    expect(services.now()).toBe(1000)
    expect(await services.readTextFile('/some/file')).toBe('text')
  })

  test('reads the token prices from the environment, and refuses a malformed setting', async () => {
    const price = '0x3333333333333333333333333333333333333333'
    const { services } = await buildServices(
      machineWith({ EXPLORER_DATA: 'fixture', EXPLORER_TOKEN_VALUATIONS_WEI: JSON.stringify({ [price]: '400000000000000' }) }),
    )
    expect(services.tokenValuationsWei).toEqual({ [price]: 400000000000000n })
    await expect(buildServices(machineWith({ EXPLORER_DATA: 'fixture', EXPLORER_TOKEN_VALUATIONS_WEI: '[]' }))).rejects.toThrow(
      'EXPLORER_TOKEN_VALUATIONS_WEI must be a JSON object',
    )
  })
})

describe('buildServices with the indexer and RPC endpoints', () => {
  test('reads the deployment file of the pair from the default place, relative to the working directory', async () => {
    const expected = resolve('/work/terminal', '../deployments/eth-pls.json')
    const machine = machineWith({}, { [expected]: DEPLOYMENT })
    const { services } = await buildServices(machine)
    expect(machine.paths).toEqual([expected])
    expect(services.pair.first.chainId).toBe(1)
    expect(services.pair.second.chainId).toBe(369)
    expect(services.chainAccess.mode).toBe('rpc')
  })

  test('takes the deployment file and the pair from the environment', async () => {
    const machine = machineWith({ EXPLORER_DEPLOYMENT_FILE: 'custom/deployment.json', EXPLORER_PAIR: 'eth-pls' }, {
      [resolve('/work/terminal', 'custom/deployment.json')]: DEPLOYMENT,
    })
    const { services } = await buildServices(machine)
    expect(machine.paths).toEqual([resolve('/work/terminal', 'custom/deployment.json')])
    expect(services.pair.id).toBe('eth-pls')
  })

  test('names the path and the way out when the deployment file cannot be read', async () => {
    const machine = machineWith({})
    const path = resolve('/work/terminal', '../deployments/eth-pls.json')
    await expect(buildServices(machine)).rejects.toThrow(
      `Cannot read the deployment file ${path} (set EXPLORER_DEPLOYMENT_FILE, or EXPLORER_DATA=fixture): ENOENT: ${path}`,
    )
  })

  test('names the path when the deployment file is not JSON', async () => {
    const path = resolve('/work/terminal', '../deployments/eth-pls.json')
    await expect(buildServices(machineWith({}, { [path]: 'not json' }))).rejects.toThrow(`Cannot read the deployment file ${path}`)
  })
})

/** A machine on a platform with no operating system store, so a store opens only with a password. */
const NO_SYSTEM_STORE = { platform: 'win32' as const }
const KEY = 'FAKEKEY1234567890'
const USER_RPC = `https://user.example.test/v1/${KEY}`
const ENVIRONMENT_RPC = 'https://env.example.test/v1/ENVKEY0987654321'
const ENVIRONMENT_INDEXER = 'https://indexer-env.example.test/ENVKEY0987654321'
const LIVE_PATH = resolve('/work/terminal', '../deployments/eth-pls.json')

/** Prover setup services whose store holds the given entries. A null store behaves like a store that needs a password. */
function setupWithStore(entries: Record<string, string> | null): ProverSetupServices {
  const store = memoryStore()
  for (const [name, value] of Object.entries(entries ?? {})) store.values.set(name, value)
  return {
    environment: {},
    run: async () => ({ code: 1, stdout: '', stderr: '' }),
    http: async () => ({ status: 200, text: '{}' }),
    load: async () => {
      throw new Error('not used')
    },
    save: async () => undefined,
    openSecretStore: async () => (entries === null ? Promise.reject(new PasswordRequiredError()) : store),
  }
}

describe('buildServices builds the live connections', () => {
  test('live mode builds a runtime, and the data source and the chain access are the proxies of that runtime', async () => {
    const { services } = await buildServices({ ...machineWith({}, { [LIVE_PATH]: DEPLOYMENT }), ...NO_SYSTEM_STORE })
    expect(services.connection).not.toBeNull()
    expect(services.dataSource).toBe(services.connection!.dataSource)
    expect(services.chainAccess).toBe(services.connection!.chainAccess)
    expect(services.chainAccess.mode).toBe('rpc')
    expect(services.dataSource.label).toBe('indexer')
  })

  test('with no user setting the environment URLs are used, and the sources say so', async () => {
    const machine = machineWith({ EXPLORER_INDEXER_URL: ENVIRONMENT_INDEXER, EXPLORER_RPC_URL_1: ENVIRONMENT_RPC }, { [LIVE_PATH]: DEPLOYMENT })
    const { services } = await buildServices({ ...machine, ...NO_SYSTEM_STORE })
    const resolved = services.connection!.resolved()
    expect(resolved.indexerUrl).toEqual({ value: ENVIRONMENT_INDEXER, source: 'environment' })
    expect(resolved.rpcUrls[1]).toEqual({ value: ENVIRONMENT_RPC, source: 'environment' })
    expect(resolved.rpcUrls[369]).toBeNull()
  })

  test('with nothing set, the indexer address is the default one', async () => {
    const { services } = await buildServices({ ...machineWith({}, { [LIVE_PATH]: DEPLOYMENT }), ...NO_SYSTEM_STORE })
    expect(services.connection!.resolved().indexerUrl).toEqual({ value: 'http://localhost:42069', source: 'default' })
  })

  test('the rpc_url of the deployment file is the default behind the environment', async () => {
    const withRpc = JSON.stringify({ ethereum: { ...section(1, 'a'), rpc_url: 'https://registry.example.test/one' }, pulsechain: section(369, 'b') })
    const { services } = await buildServices({ ...machineWith({}, { [LIVE_PATH]: withRpc }), ...NO_SYSTEM_STORE })
    expect(services.connection!.resolved().rpcUrls[1]).toEqual({ value: 'https://registry.example.test/one', source: 'default' })
    expect(services.pair.first.registryRpcUrl).toBe('https://registry.example.test/one')
    const { services: beaten } = await buildServices({ ...machineWith({ EXPLORER_RPC_URL_1: ENVIRONMENT_RPC }, { [LIVE_PATH]: withRpc }), ...NO_SYSTEM_STORE })
    expect(beaten.connection!.resolved().rpcUrls[1]?.source).toBe('environment')
  })

  test('a setting of the user in the secret store wins over the environment', async () => {
    const proverSetup = setupWithStore({ [CONNECTION_SECRET_NAMES.rpcUrl(1)]: USER_RPC })
    const machine = machineWith({ EXPLORER_RPC_URL_1: ENVIRONMENT_RPC, EXPLORER_RPC_URL_369: ENVIRONMENT_RPC }, { [LIVE_PATH]: DEPLOYMENT })
    const { services } = await buildServices({ ...machine, proverSetup })
    const resolved = services.connection!.resolved()
    expect(resolved.rpcUrls[1]).toEqual({ value: USER_RPC, source: 'user' })
    expect(resolved.rpcUrls[369]).toEqual({ value: ENVIRONMENT_RPC, source: 'environment' })
  })

  test('a store that needs a password counts as locked: startup asks for nothing and has no user setting', async () => {
    const machine = machineWith({ EXPLORER_RPC_URL_1: ENVIRONMENT_RPC }, { [LIVE_PATH]: DEPLOYMENT })
    const { services } = await buildServices({ ...machine, proverSetup: setupWithStore(null) })
    expect(services.connection!.user()).toEqual({ indexerUrl: null, rpcUrls: {} })
    expect(services.connection!.resolved().rpcUrls[1]?.source).toBe('environment')
  })

  test('a store that fails to open or to read does not stop the start', async () => {
    const broken: ProverSetupServices = { ...setupWithStore({}), openSecretStore: async () => Promise.reject(new Error(`keychain broke at ${ENVIRONMENT_RPC}`)) }
    const { services } = await buildServices({ ...machineWith({}, { [LIVE_PATH]: DEPLOYMENT }), proverSetup: broken })
    expect(services.connection!.user()).toEqual({ indexerUrl: null, rpcUrls: {} })
    const unreadable: ProverSetupServices = {
      ...setupWithStore({}),
      openSecretStore: async () => ({ ...memoryStore(), get: async () => Promise.reject(new Error('unreadable')) }),
    }
    const { services: second } = await buildServices({ ...machineWith({}, { [LIVE_PATH]: DEPLOYMENT }), proverSetup: unreadable })
    expect(second.connection!.user()).toEqual({ indexerUrl: null, rpcUrls: {} })
  })

  test('the services keep the same proverSetup that opens the store for the view', async () => {
    const proverSetup = setupWithStore({})
    const { services } = await buildServices({ ...machineWith({}, { [LIVE_PATH]: DEPLOYMENT }), proverSetup })
    expect(services.proverSetup).toBe(proverSetup)
  })

  test('the default Prover setup services are used when a test passes none, on the platform of the machine', async () => {
    const { services } = await buildServices({ ...machineWith({}, { [LIVE_PATH]: DEPLOYMENT }), ...NO_SYSTEM_STORE })
    await expect(services.proverSetup.openSecretStore({ password: null })).rejects.toBeInstanceOf(PasswordRequiredError)
  })

  test('the finality variables reach the shared registry, and a malformed one is refused without any URL in the message', async () => {
    const machine = machineWith({ EXPLORER_FINALITY_SECONDS_1: 'soon', EXPLORER_RPC_URL_1: ENVIRONMENT_RPC, EXPLORER_INDEXER_URL: ENVIRONMENT_INDEXER }, { [LIVE_PATH]: DEPLOYMENT })
    const failure = await buildServices({ ...machine, ...NO_SYSTEM_STORE }).then(
      () => null,
      (error: unknown) => error as Error,
    )
    expect(failure?.message).toContain('EXPLORER_FINALITY_SECONDS_1 must be a whole number')
    expect(failure?.message).not.toContain('ENVKEY0987654321')
    expect(failure?.message).not.toContain('env.example.test')
  })

  test('no error of startup holds a URL from the environment, even when the deployment file is wrong', async () => {
    const machine = machineWith({ EXPLORER_RPC_URL_1: ENVIRONMENT_RPC, EXPLORER_INDEXER_URL: ENVIRONMENT_INDEXER }, { [LIVE_PATH]: JSON.stringify({ ethereum: section(1, 'a') }) })
    const failure = await buildServices({ ...machine, ...NO_SYSTEM_STORE }).then(
      () => null,
      (error: unknown) => error as Error,
    )
    expect(failure).not.toBeNull()
    expect(failure?.message).not.toContain('ENVKEY0987654321')
  })
})

describe('buildServices startup signer', () => {
  test('opens a signer from the private key variable, and removes the variable from the environment', async () => {
    const machine = machineWith({ EXPLORER_DATA: 'fixture', EXPLORER_PRIVATE_KEY: TEST_KEY })
    const { initialSigner } = await buildServices(machine)
    expect(initialSigner?.address).toBe(TEST_ADDRESS)
    expect(machine.environment.EXPLORER_PRIVATE_KEY).toBeUndefined()
  })

  test('opens a signer from the private key file when no variable is set', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'explorer-bootstrap-test-'))
    scratch.push(directory)
    const file = join(directory, 'key')
    await writeFile(file, TEST_KEY)
    await chmod(file, 0o600)
    const { initialSigner } = await buildServices(machineWith({ EXPLORER_DATA: 'fixture', EXPLORER_PRIVATE_KEY_FILE: file }))
    expect(initialSigner?.address).toBe(TEST_ADDRESS)
  })

  test('prefers the variable to the file, so a file that nobody can read is not opened', async () => {
    const { initialSigner } = await buildServices(
      machineWith({ EXPLORER_DATA: 'fixture', EXPLORER_PRIVATE_KEY: TEST_KEY, EXPLORER_PRIVATE_KEY_FILE: '/does/not/exist' }),
    )
    expect(initialSigner?.address).toBe(TEST_ADDRESS)
  })
})
