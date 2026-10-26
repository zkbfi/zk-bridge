/**
 * Startup of the dashboard: reads the environment and the deployment file and builds the services. The entry point
 * `main.tsx` only starts the renderer with the result, so every decision of startup is here and has tests.
 *
 * Environment variables:
 * - `EXPLORER_DATA=fixture` runs on built-in sample data with no network. Anything else reads the indexer.
 * - `EXPLORER_INDEXER_URL` the indexer API (default `http://localhost:42069`).
 * - `EXPLORER_PAIR` the pair (default `eth-pls`) and `EXPLORER_DEPLOYMENT_FILE` the deployment JSON.
 * - `EXPLORER_RPC_URL_<chainId>` the RPC URL of each chain (keyed URLs: never committed).
 * - Signers: `EXPLORER_PRIVATE_KEY`, `EXPLORER_PRIVATE_KEY_FILE`, `EXPLORER_KEYSTORE_FILE`, `EXPLORER_MNEMONIC`,
 *   `EXPLORER_MNEMONIC_FILE`, `EXPLORER_MNEMONIC_PASSPHRASE`, `EXPLORER_TREZOR_CONTACT`.
 * - Operator files: `EXPLORER_HANDOFF_FILE`, `EXPLORER_EVIDENCE_FILE`.
 * - `EXPLORER_TOKEN_VALUATIONS_WEI` prices of tokens in wei, for delivery fee suggestions (see `config/token-valuations.ts`).
 *
 * The secrets in that list are removed from the environment as soon as they are read.
 */
import { resolve } from 'node:path'
import { createRpcChainAccess } from '../chain/chain-access'
import { createFixtureChainAccess } from '../chain/fixture-chain-access'
import { DEFAULT_PAIR_ID, buildPairConfig } from '../config/pairs'
import { TOKEN_VALUATIONS_VARIABLE, parseTokenValuations } from '../config/token-valuations'
import { FIXTURE_PAIR, createFixtureDataSource } from '../data/fixtures'
import { createIndexerDataSource } from '../data/indexer-data-source'
import type { Signer } from '../signing/signer'
import { createDefaultProverSetupServices, createDefaultSigningServices, type AppServices, type SigningServices } from './services'

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
  const pair = useFixture ? FIXTURE_PAIR : buildPairConfig(pairId, await readDeployment(machine, pairId))
  return {
    initialSigner: await startupSigner(signing),
    services: {
      pair,
      dataSource: useFixture
        ? createFixtureDataSource({ now: machine.now })
        : createIndexerDataSource({ baseUrl: environment.EXPLORER_INDEXER_URL ?? 'http://localhost:42069', pair }),
      chainAccess: useFixture ? createFixtureChainAccess(pair) : createRpcChainAccess(pair, environment),
      signing,
      proverSetup: createDefaultProverSetupServices(environment),
      now: machine.now,
      readTextFile: machine.readTextFile,
      defaultPairId: pair.id,
      tokenValuationsWei: parseTokenValuations(environment[TOKEN_VALUATIONS_VARIABLE]),
    },
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
