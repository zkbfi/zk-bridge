/**
 * Startup of the dashboard: reads the environment and the deployment file and builds the services. The entry point
 * `main.tsx` only starts the renderer with the result, so every decision of startup is here and has tests.
 *
 * Environment variables:
 * - `EXPLORER_DATA=fixture` runs on built-in sample data with no network. Anything else reads the indexer, and reads
 *   the chains by RPC when the indexer cannot answer.
 * - `EXPLORER_INDEXER_URL` the indexer API (default `http://localhost:42069`). A URL that the user sets in the
 *   Connections view wins over it.
 * - `EXPLORER_PAIR` the pair (default `eth-pls`) and `EXPLORER_DEPLOYMENT_FILE` the deployment JSON.
 * - `EXPLORER_RPC_URL_<chainId>` the RPC URL of each chain (keyed URLs: never committed). A URL that the user sets in
 *   the Connections view wins over it. The `rpc_url` of the deployment file is the default behind it.
 * - `EXPLORER_BACKEND_URL`, `EXPLORER_MSGBOARD_INDEXER_URL`, `EXPLORER_ARCHIVE_URL` and `EXPLORER_MSGBOARD_URL` the backend, the
 *   msgboard indexer, the archive and the msgboard node. None has a default. A URL that the user sets in the Connections
 *   view wins over it.
 * - `EXPLORER_FINALITY_SECONDS_<chainId>` the finality time of a chain, for the RPC data source.
 * - Signers: `EXPLORER_PRIVATE_KEY`, `EXPLORER_PRIVATE_KEY_FILE`, `EXPLORER_KEYSTORE_FILE`, `EXPLORER_MNEMONIC`,
 *   `EXPLORER_MNEMONIC_FILE`, `EXPLORER_MNEMONIC_PASSPHRASE`, `EXPLORER_TREZOR_CONTACT`.
 * - Operator files: `EXPLORER_HANDOFF_FILE`, `EXPLORER_EVIDENCE_FILE`.
 * - `EXPLORER_TOKEN_VALUATIONS_WEI` prices of tokens in wei, for delivery fee suggestions (see `config/token-valuations.ts`).
 * - `EXPLORER_CONFIG_DIR` the configuration directory: the Prover setup file, and in `fork-schedules/` the last fork
 *   schedule of each chain that the fork cutover read, for when the beacon node does not answer.
 *
 * The secrets in that list are removed from the environment as soon as they are read.
 */
import { resolve } from 'node:path'
import { createFixtureChainAccess } from '../chain/fixture-chain-access'
import { DEFAULT_PAIR_ID, buildPairConfig } from '../config/pairs'
import { TOKEN_VALUATIONS_VARIABLE, parseTokenValuations } from '../config/token-valuations'
import { FIXTURE_PAIR, createFixtureDataSource } from '../data/fixtures'
import { createConnectionRuntime } from '../data/connection-runtime'
import type { PairConfig } from '../model/types'
import type { Signer } from '../signing/signer'
import {
  EMPTY_CONNECTION_SETTINGS,
  finalityVariableName,
  loadPair,
  type ConnectionLayer,
  type ConnectionSettings,
} from '@zk-bridge/shared'
import { createForkScheduleStore } from '@zk-bridge/shared'
import { fileForkScheduleText, forkScheduleDirectory } from '@zk-bridge/shared/config'
import { loadUserSettings } from './connections-model'
import {
  createDefaultProverSetupServices,
  createDefaultSigningServices,
  type AppServices,
  type ProverSetupServices,
  type SigningServices,
} from './services'

/** The part of the machine that startup touches. Tests replace it. */
export interface BootstrapMachine {
  /** The environment. Startup removes the secrets from it. */
  readonly environment: Record<string, string | undefined>
  /** The folder that a relative deployment file path starts from. */
  readonly workingDirectory: string
  /** Reads a text file. */
  readonly readTextFile: (path: string) => Promise<string>
  /** The clock, in unix seconds. */
  readonly now: () => number
  /** Replaces the Prover setup services, which open the secret store. A test passes a store that it controls. */
  readonly proverSetup?: ProverSetupServices
  /** The platform that picks the secret store. Default: the platform that runs the program. */
  readonly platform?: NodeJS.Platform
}

/** The services of the dashboard, except `quit`, which the renderer provides, and the signer that startup opened. */
export interface BootstrapResult {
  readonly services: Omit<AppServices, 'quit'>
  readonly initialSigner: Signer | null
}

/**
 * Builds the services from the environment.
 *
 * @throws Error when the deployment file cannot be read, or when a setting is malformed.
 */
export async function buildServices(machine: BootstrapMachine): Promise<BootstrapResult> {
  const { environment } = machine
  const signing = createDefaultSigningServices(environment)
  const useFixture = environment.EXPLORER_DATA === 'fixture'
  const pairId = environment.EXPLORER_PAIR ?? DEFAULT_PAIR_ID
  const deployment = useFixture ? null : await readDeployment(machine, pairId)
  const pair = useFixture ? FIXTURE_PAIR : buildPairConfig(pairId, deployment)
  const proverSetup = machine.proverSetup ?? createDefaultProverSetupServices(environment, machine.platform === undefined ? {} : { platform: machine.platform })
  const connection = useFixture ? null : createLiveConnection({ pairId, pair, deployment, environment, user: await startupSettings(proverSetup, pair) })
  return {
    initialSigner: await startupSigner(signing),
    services: {
      pair,
      dataSource: connection === null ? createFixtureDataSource({ now: machine.now }) : connection.dataSource,
      chainAccess: connection === null ? createFixtureChainAccess(pair) : connection.chainAccess,
      connection,
      signing,
      proverSetup,
      now: machine.now,
      readTextFile: machine.readTextFile,
      defaultPairId: pair.id,
      tokenValuationsWei: parseTokenValuations(environment[TOKEN_VALUATIONS_VARIABLE]),
      forkSchedules: createForkScheduleStore(fileForkScheduleText(forkScheduleDirectory(environment))),
    },
  }
}

/** The finality variables of the environment, which `loadPair` reads. No URL goes to `loadPair`. */
function finalityEnvironment(pair: PairConfig, environment: BootstrapMachine['environment']): Record<string, string | undefined> {
  const names = [pair.first.chainId, pair.second.chainId].map(finalityVariableName)
  return Object.fromEntries(names.map((name) => [name, environment[name]]))
}

/** The URLs that the environment names, as the lowest layer above the registry defaults. */
function environmentLayer(pair: PairConfig, environment: BootstrapMachine['environment']): ConnectionLayer {
  return {
    indexerUrl: environment.EXPLORER_INDEXER_URL,
    backendUrl: environment.EXPLORER_BACKEND_URL,
    msgboardIndexerUrl: environment.EXPLORER_MSGBOARD_INDEXER_URL,
    archiveUrl: environment.EXPLORER_ARCHIVE_URL,
    msgboardUrl: environment.EXPLORER_MSGBOARD_URL,
    rpcUrls: Object.fromEntries([pair.first, pair.second].map((chain) => [chain.chainId, environment[chain.rpcEnvironmentVariable]])),
  }
}

/** The live connections: the indexer first, the RPC source behind it. A URL never enters an error message here. */
function createLiveConnection(input: {
  readonly pairId: string
  readonly pair: PairConfig
  readonly deployment: unknown
  readonly environment: BootstrapMachine['environment']
  readonly user: ConnectionSettings
}) {
  const sharedPair = loadPair({
    pairName: input.pairId,
    environment: finalityEnvironment(input.pair, input.environment),
    deployment: input.deployment,
    requireRpcUrl: false,
  })
  return createConnectionRuntime({ pair: input.pair, sharedPair, environment: environmentLayer(input.pair, input.environment), user: input.user })
}

/**
 * What the user set before. It opens the secret store with no password and never asks for one: a store that needs a
 * password counts as locked, and the dashboard starts with no user setting. The Connections view unlocks it later.
 */
async function startupSettings(proverSetup: ProverSetupServices, pair: PairConfig): Promise<ConnectionSettings> {
  try {
    const store = await proverSetup.openSecretStore({ password: null })
    return await loadUserSettings(store, [pair.first.chainId, pair.second.chainId])
  } catch {
    return EMPTY_CONNECTION_SETTINGS
  }
}

async function readDeployment(machine: BootstrapMachine, pairId: string): Promise<unknown> {
  const path = resolve(machine.workingDirectory, machine.environment.EXPLORER_DEPLOYMENT_FILE ?? `../deployments/${pairId}.json`)
  try {
    return JSON.parse(await machine.readTextFile(path))
  } catch (error) {
    throw new Error(`Cannot read the deployment file ${path} (set EXPLORER_DEPLOYMENT_FILE, or EXPLORER_DATA=fixture): ${(error as Error).message}`)
  }
}

/** A signer from a startup variable or file, when one is set. The variable wins over the file. */
async function startupSigner(signing: SigningServices): Promise<Signer | null> {
  if (signing.startupSecrets.privateKey !== undefined) return signing.signerFromPrivateKeyText(signing.startupSecrets.privateKey)
  if (signing.fileHints.privateKeyFile) return signing.signerFromPrivateKeyFile(signing.fileHints.privateKeyFile)
  return null
}
