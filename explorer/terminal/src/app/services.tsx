/**
 * The services that the views use, passed down by context so tests can replace every one of them.
 */
import { createContext, useCallback, useContext, useSyncExternalStore, type ReactNode } from 'react'
import type { ChainAccess } from '../chain/chain-access'
import type { ConnectionRuntime } from '../data/connection-runtime'
import type { DataSource } from '../data/data-source'
import type { PairConfig } from '../model/types'
import type { ForkScheduleStore } from '@zk-bridge/shared'
import { fetchClient, type HttpClient } from '../config/connection-tests'
import {
  chooseSecretStore,
  type CommandRunner,
  createEncryptedFileStore,
  encryptedSecretsPath,
  loadProverSetup,
  type ProverSetup,
  saveProverSetup,
  type SecretStore,
  setupFilePath,
  spawnRunner,
} from '@zk-bridge/shared/config'
import { readSecretFile, signerFromKeystoreFile, signerFromPrivateKeyFile, signerFromPrivateKeyText, takeEnvironmentSecret, SECRET_VARIABLES, type Environment } from '../signing/key-sources'
import { createLedgerSource, type LedgerSourceInput } from '../signing/ledger'
import { createMnemonicSource } from '../signing/mnemonic'
import type { AddressSource, Signer } from '../signing/signer'
import { createTrezorSource, type TrezorSourceInput } from '../signing/trezor'

/** Secrets that the program took from the environment at startup. The variables are gone from the environment. */
export interface StartupSecrets {
  readonly privateKey: string | undefined
  readonly mnemonic: string | undefined
  readonly mnemonicPassphrase: string | undefined
}

/** File paths that the environment may name. They are not secrets. */
export interface FileHints {
  readonly privateKeyFile: string | undefined
  readonly keystoreFile: string | undefined
  readonly mnemonicFile: string | undefined
  readonly handoffFile: string | undefined
  readonly evidenceFile: string | undefined
}

/** The ways to get a signer. Each one can be replaced in a test. */
export interface SigningServices {
  readonly startupSecrets: StartupSecrets
  readonly fileHints: FileHints
  signerFromPrivateKeyText(text: string): Signer
  signerFromPrivateKeyFile(path: string): Promise<Signer>
  signerFromKeystoreFile(path: string, password: string): Promise<Signer>
  readSecretText(path: string): Promise<string>
  mnemonicSource(mnemonic: string, passphrase: string): AddressSource
  ledgerSource(input: Pick<LedgerSourceInput, 'onDevicePrompt'>): AddressSource
  trezorSource(input: Pick<TrezorSourceInput, 'onDevicePrompt'>): AddressSource
}

/** Thrown by `openSecretStore` when the platform has no secret store and a password is needed for the file. */
export class PasswordRequiredError extends Error {
  override readonly name = 'PasswordRequiredError'
  constructor() {
    super('The secrets file needs a password.')
  }
}

/** What the Prover setup view needs. Tests replace each part. */
export interface ProverSetupServices {
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly run: CommandRunner
  readonly http: HttpClient
  load(): Promise<ProverSetup>
  save(setup: ProverSetup): Promise<void>
  /**
   * Opens the secret store. The Keychain and the Secret Service open without a password. The encrypted file needs one:
   * pass it, or this throws {@link PasswordRequiredError}.
   */
  openSecretStore(options: { readonly password: string | null }): Promise<SecretStore>
}

/** Everything the views need. */
export interface AppServices {
  readonly pair: PairConfig
  readonly dataSource: DataSource
  readonly chainAccess: ChainAccess
  /**
   * The live connections (indexer first, RPC fallback behind it), or null in fixture mode. When it is set,
   * `dataSource` and `chainAccess` are the proxies of this runtime. The Connections view reads and changes the URLs here.
   */
  readonly connection: ConnectionRuntime | null
  readonly signing: SigningServices
  readonly proverSetup: ProverSetupServices
  /** The clock, in unix seconds. */
  readonly now: () => number
  /** Reads a text file, for the handoff and evidence files. */
  readonly readTextFile: (path: string) => Promise<string>
  /** Ends the program through the renderer. Never `process.exit`. */
  readonly quit: () => void
  /** The pair the dashboard opens on. */
  readonly defaultPairId: string
  /** The value of one whole token in wei, by lowercase address, for delivery fee suggestions. See `config/token-valuations.ts`. */
  readonly tokenValuationsWei: Readonly<Record<string, bigint>>
  /**
   * Where the fork cutover keeps the last fork schedule of each chain (files in the configuration directory), for when the
   * beacon node does not answer. Absent: only the schedule bundled with the release.
   */
  readonly forkSchedules?: ForkScheduleStore
}

const ServicesContext = createContext<AppServices | null>(null)

/** Provides the services. */
export function ServicesProvider({ services, children }: { readonly services: AppServices; readonly children: ReactNode }) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>
}

/** Reads the services. */
export function useServices(): AppServices {
  const services = useContext(ServicesContext)
  if (services === null) throw new Error('useServices needs a ServicesProvider above it.')
  return services
}

/**
 * The label of the active data source: `indexer`, `RPC fallback: <reason>`, or the fixed label of fixture data. The
 * component that calls this hook draws again when the source changes.
 */
export function useConnectionStatus(): string {
  const { connection, dataSource } = useServices()
  const subscribe = useCallback((listener: () => void) => (connection === null ? () => undefined : connection.subscribe(listener)), [connection])
  return useSyncExternalStore(subscribe, () => (connection === null ? dataSource.label : connection.source().label))
}

/**
 * Takes the secrets out of the environment and returns them. After this call, a child process of the dashboard no
 * longer inherits them.
 */
export function takeStartupSecrets(environment: Environment): StartupSecrets {
  return {
    privateKey: takeEnvironmentSecret(environment, SECRET_VARIABLES.privateKey),
    mnemonic: takeEnvironmentSecret(environment, SECRET_VARIABLES.mnemonic),
    mnemonicPassphrase: takeEnvironmentSecret(environment, SECRET_VARIABLES.mnemonicPassphrase),
  }
}

/** Reads the file path hints from the environment. */
export function readFileHints(environment: Environment): FileHints {
  return {
    privateKeyFile: environment[SECRET_VARIABLES.privateKeyFile],
    keystoreFile: environment[SECRET_VARIABLES.keystoreFile],
    mnemonicFile: environment[SECRET_VARIABLES.mnemonicFile],
    handoffFile: environment.EXPLORER_HANDOFF_FILE,
    evidenceFile: environment.EXPLORER_EVIDENCE_FILE,
  }
}

/** The signing services that use the real libraries and files. */
export function createDefaultSigningServices(environment: Environment): SigningServices {
  return {
    startupSecrets: takeStartupSecrets(environment),
    fileHints: readFileHints(environment),
    signerFromPrivateKeyText,
    signerFromPrivateKeyFile,
    signerFromKeystoreFile,
    readSecretText: readSecretFile,
    mnemonicSource: (mnemonic, passphrase) => createMnemonicSource({ mnemonic, passphrase }),
    ledgerSource: (input) => createLedgerSource(input),
    trezorSource: (input) => createTrezorSource(input),
  }
}

/**
 * The Prover setup services that use the real file system, commands and network.
 *
 * @param environment The environment that names the configuration directory.
 * @param options `platform` picks the secret store. It defaults to the platform that runs the program. A test passes a
 * platform that has no operating system store, so the encrypted file is used and no real command runs.
 */
export function createDefaultProverSetupServices(
  environment: Environment,
  options: { readonly platform?: NodeJS.Platform } = {},
): ProverSetupServices {
  return {
    environment,
    run: spawnRunner,
    http: fetchClient,
    load: () => loadProverSetup(setupFilePath(environment)),
    save: (setup) => saveProverSetup(setupFilePath(environment), setup),
    async openSecretStore({ password }) {
      return chooseSecretStore({
        platform: options.platform ?? process.platform,
        run: spawnRunner,
        fallback: async () => {
          if (password === null) throw new PasswordRequiredError()
          const store = createEncryptedFileStore({ path: encryptedSecretsPath(environment), password })
          // Reading proves the password: a wrong one fails here, not at the first save.
          await store.get('__check')
          return store
        },
      })
    },
  }
}
