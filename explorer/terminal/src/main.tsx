/**
 * Entry point: `bun run src/main.tsx`.
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
 * The secrets in that list are removed from the process environment as soon as they are read.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createCliRenderer } from '@opentui/core'
import { createRoot } from '@opentui/react'
import { App } from './app/App'
import {
  createDefaultProverSetupServices,
  createDefaultSigningServices,
  type AppServices,
} from './app/services'
import { createRpcChainAccess } from './chain/chain-access'
import { createFixtureChainAccess } from './chain/fixture-chain-access'
import { DEFAULT_PAIR_ID, buildPairConfig } from './config/pairs'
import { parseTokenValuations, TOKEN_VALUATIONS_VARIABLE } from './config/token-valuations'
import { createFixtureDataSource, FIXTURE_PAIR } from './data/fixtures'
import { createIndexerDataSource } from './data/indexer-data-source'
import type { Signer } from './signing/signer'

async function buildServices(environment: Record<string, string | undefined>): Promise<{ services: Omit<AppServices, 'quit'>; initialSigner: Signer | null }> {
  const signing = createDefaultSigningServices(environment)
  const useFixture = environment.EXPLORER_DATA === 'fixture'
  const pairId = environment.EXPLORER_PAIR ?? DEFAULT_PAIR_ID
  const pair = useFixture ? FIXTURE_PAIR : buildPairConfig(pairId, await readDeployment(environment, pairId))
  const initialSigner = await startupSigner(signing)
  return {
    initialSigner,
    services: {
      pair,
      dataSource: useFixture
        ? createFixtureDataSource({ now: () => Math.floor(Date.now() / 1000) })
        : createIndexerDataSource({ baseUrl: environment.EXPLORER_INDEXER_URL ?? 'http://localhost:42069', pair }),
      chainAccess: useFixture ? createFixtureChainAccess(pair) : createRpcChainAccess(pair, environment),
      signing,
      proverSetup: createDefaultProverSetupServices(environment),
      now: () => Math.floor(Date.now() / 1000),
      readTextFile: (path) => readFile(path, 'utf8'),
      defaultPairId: pair.id,
      tokenValuationsWei: parseTokenValuations(environment[TOKEN_VALUATIONS_VARIABLE]),
    },
  }
}

async function readDeployment(environment: Record<string, string | undefined>, pairId: string): Promise<unknown> {
  const path = resolve(process.cwd(), environment.EXPLORER_DEPLOYMENT_FILE ?? `../deployments/${pairId}.json`)
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot read the deployment file ${path} (set EXPLORER_DEPLOYMENT_FILE, or EXPLORER_DATA=fixture): ${(error as Error).message}`)
  }
}

/** A signer from a startup variable or file, when one is set. */
async function startupSigner(signing: ReturnType<typeof createDefaultSigningServices>): Promise<Signer | null> {
  if (signing.startupSecrets.privateKey !== undefined) return signing.signerFromPrivateKeyText(signing.startupSecrets.privateKey)
  if (process.env.EXPLORER_PRIVATE_KEY_FILE) return signing.signerFromPrivateKeyFile(process.env.EXPLORER_PRIVATE_KEY_FILE)
  return null
}

try {
  const { services, initialSigner } = await buildServices(process.env)
  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  createRoot(renderer).render(<App services={{ ...services, quit: () => renderer.destroy() }} initialSigner={initialSigner} />)
} catch (error) {
  // The renderer is not running here, so a plain message on standard error is safe. The exit code tells scripts.
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
