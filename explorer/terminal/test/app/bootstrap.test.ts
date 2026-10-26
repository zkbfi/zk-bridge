import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildServices, type BootstrapMachine } from '../../src/app/bootstrap'
import { FIXTURE_PAIR } from '../../src/data/fixtures'

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
