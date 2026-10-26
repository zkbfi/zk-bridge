/**
 * Where secrets live: the macOS Keychain, the Linux Secret Service, or an encrypted file. A secret can also stay in an
 * environment variable or a 1Password item, and the configuration then holds only a reference.
 *
 * A secret never travels on a command line, because other users can read a command line. The Keychain store sends it
 * through the standard input of `security -i`, and the Secret Service store sends it through the standard input of
 * `secret-tool`. This module has no dependency on the terminal library, so the bots can import it.
 */
import { spawn } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { redactSecrets } from '../redaction.js'
import type { SecretReference } from './prover-setup.js'

/** The result of running a command. */
export interface CommandResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Runs a command. The standard input carries secrets, never the arguments. */
export type CommandRunner = (command: string, args: readonly string[], standardInput?: string) => Promise<CommandResult>

/** A place that keeps named secrets. */
export interface SecretStore {
  readonly kind: 'macos-keychain' | 'secret-service' | 'encrypted-file'
  get(name: string): Promise<string | null>
  set(name: string, value: string): Promise<void>
  delete(name: string): Promise<void>
}

/** The service name that every stored secret goes under. */
export const SERVICE_NAME = 'zk-bridge-explorer'

/** A store call failed. The message is already redacted. */
export class SecretStoreError extends Error {
  override readonly name = 'SecretStoreError'
}

/**
 * The command runner that spawns a real process with `node:child_process`, which Node.js and Bun both run.
 * A command that cannot start (for example a missing `op`) answers with code 127 and the reason on standard error.
 */
export const spawnRunner: CommandRunner = (command, args, standardInput) =>
  new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: [standardInput === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', (error) => resolve({ code: 127, stdout: '', stderr: error.message }))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }))
    if (standardInput !== undefined) child.stdin?.end(standardInput)
  })

function failure(action: string, result: CommandResult, secret?: string): SecretStoreError {
  return new SecretStoreError(redactSecrets(`${action} failed (exit ${result.code}): ${result.stderr.trim()}`, secret === undefined ? [] : [secret]))
}

/** The macOS Keychain, through the `security` command. */
export function createKeychainStore(run: CommandRunner): SecretStore {
  return {
    kind: 'macos-keychain',
    async get(name) {
      const result = await run('security', ['find-generic-password', '-a', name, '-s', SERVICE_NAME, '-w'])
      if (result.code === 44) return null // errSecItemNotFound
      if (result.code !== 0) throw failure('Reading the Keychain', result)
      return result.stdout.replace(/\r?\n$/, '')
    },
    async set(name, value) {
      if (/[\r\n"\\]/.test(value)) throw new SecretStoreError('The Keychain store cannot hold a value with a quote, a backslash or a line break.')
      // The command goes to the standard input of `security -i`, so the value is not in any argument list.
      const script = `add-generic-password -U -a "${name}" -s "${SERVICE_NAME}" -w "${value}"\n`
      const result = await run('security', ['-i'], script)
      if (result.code !== 0 || /\bfail|error\b/i.test(result.stderr)) throw failure('Writing the Keychain', result, value)
    },
    async delete(name) {
      const result = await run('security', ['delete-generic-password', '-a', name, '-s', SERVICE_NAME])
      if (result.code !== 0 && result.code !== 44) throw failure('Deleting from the Keychain', result)
    },
  }
}

/** The Linux Secret Service, through `secret-tool`. */
export function createSecretServiceStore(run: CommandRunner): SecretStore {
  const attributes = (name: string) => ['service', SERVICE_NAME, 'account', name]
  return {
    kind: 'secret-service',
    async get(name) {
      const result = await run('secret-tool', ['lookup', ...attributes(name)])
      if (result.code !== 0 && result.stdout === '') return null
      return result.stdout.replace(/\r?\n$/, '')
    },
    async set(name, value) {
      const result = await run('secret-tool', ['store', `--label=${SERVICE_NAME} ${name}`, ...attributes(name)], value)
      if (result.code !== 0) throw failure('Writing the Secret Service', result, value)
    },
    async delete(name) {
      const result = await run('secret-tool', ['clear', ...attributes(name)])
      if (result.code !== 0) throw failure('Deleting from the Secret Service', result)
    },
  }
}

const scryptAsync = promisify(scrypt) as (password: Buffer, salt: Buffer, keylen: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>

/** The scrypt cost of the encrypted file: N = 2^15, r = 8, p = 1 (about 32 MiB, about 100 ms). */
const FILE_SCRYPT = { N: 1 << 15, r: 8, p: 1 } as const

interface EncryptedFile {
  readonly version: 1
  readonly kdf: 'scrypt'
  readonly cipher: 'aes-256-gcm'
  readonly N: number
  readonly r: number
  readonly p: number
  readonly salt: string
  readonly nonce: string
  readonly tag: string
  readonly ciphertext: string
}

/** The password does not open the file. */
export class WrongPasswordError extends Error {
  override readonly name = 'WrongPasswordError'
  constructor() {
    super('Wrong password, or the secret file is damaged.')
  }
}

/** Encrypts a map of secrets with a password. Every call uses a new salt and a new nonce. */
export async function encryptSecrets(secrets: Readonly<Record<string, string>>, password: string): Promise<string> {
  const salt = randomBytes(16)
  const nonce = randomBytes(12)
  const key = await deriveFileKey(password, salt, FILE_SCRYPT)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf8'), cipher.final()])
  key.fill(0)
  const file: EncryptedFile = {
    version: 1,
    kdf: 'scrypt',
    cipher: 'aes-256-gcm',
    ...FILE_SCRYPT,
    salt: salt.toString('hex'),
    nonce: nonce.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  }
  return JSON.stringify(file)
}

/**
 * Decrypts the text of an encrypted file.
 * @throws WrongPasswordError when the authentication tag does not match.
 */
export async function decryptSecrets(text: string, password: string): Promise<Record<string, string>> {
  const file = JSON.parse(text) as EncryptedFile
  if (file.version !== 1 || file.kdf !== 'scrypt' || file.cipher !== 'aes-256-gcm') throw new SecretStoreError('The secret file has an unsupported format.')
  const key = await deriveFileKey(password, Buffer.from(file.salt, 'hex'), { N: file.N, r: file.r, p: file.p })
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.nonce, 'hex'))
  decipher.setAuthTag(Buffer.from(file.tag, 'hex'))
  try {
    const plain = Buffer.concat([decipher.update(Buffer.from(file.ciphertext, 'hex')), decipher.final()])
    return JSON.parse(plain.toString('utf8')) as Record<string, string>
  } catch {
    throw new WrongPasswordError()
  } finally {
    key.fill(0)
  }
}

function deriveFileKey(password: string, salt: Buffer, cost: { N: number; r: number; p: number }): Promise<Buffer> {
  return scryptAsync(Buffer.from(password, 'utf8'), salt, 32, { ...cost, maxmem: 128 * cost.N * cost.r * 2 + 1024 * 1024 })
}

/** Input of {@link createEncryptedFileStore}. */
export interface EncryptedFileStoreInput {
  readonly path: string
  readonly password: string
}

/**
 * A store in one encrypted file. The whole file is decrypted for each call and written again for each change, with
 * mode 0600, through a temporary file and a rename, so a crash leaves the old file or the new file and never half.
 */
export function createEncryptedFileStore(input: EncryptedFileStoreInput): SecretStore {
  async function load(): Promise<Record<string, string>> {
    let text: string
    try {
      text = await readFile(input.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
    return decryptSecrets(text, input.password)
  }
  async function save(secrets: Readonly<Record<string, string>>): Promise<void> {
    await mkdir(dirname(input.path), { recursive: true, mode: 0o700 })
    const temporary = `${input.path}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(temporary, await encryptSecrets(secrets, input.password), { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, input.path)
  }
  return {
    kind: 'encrypted-file',
    async get(name) {
      return (await load())[name] ?? null
    },
    async set(name, value) {
      await save({ ...(await load()), [name]: value })
    },
    async delete(name) {
      const { [name]: _removed, ...rest } = await load()
      await save(rest)
    },
  }
}

/** Input of {@link chooseSecretStore}. */
export interface ChooseStoreInput {
  readonly platform: NodeJS.Platform
  readonly run: CommandRunner
  /** Creates the encrypted file store when the platform has none. It asks for the password at that point. */
  readonly fallback: () => Promise<SecretStore>
}

/**
 * Picks the store: the Keychain on macOS, the Secret Service on Linux when `secret-tool` works, and otherwise the
 * encrypted file.
 */
export async function chooseSecretStore(input: ChooseStoreInput): Promise<SecretStore> {
  if (input.platform === 'darwin' && (await commandWorks(input.run, 'security', ['help']))) return createKeychainStore(input.run)
  if (input.platform === 'linux' && (await commandWorks(input.run, 'secret-tool', ['--version']))) return createSecretServiceStore(input.run)
  return input.fallback()
}

async function commandWorks(run: CommandRunner, command: string, args: readonly string[]): Promise<boolean> {
  try {
    const result = await run(command, args)
    // `security help` exits non-zero on some versions, so a runnable command is enough.
    return result.code === 0 || result.stderr.length > 0 || result.stdout.length > 0
  } catch {
    return false
  }
}

/** What a reference needs to resolve. */
export interface ResolveDependencies {
  readonly store: SecretStore | null
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly run: CommandRunner
}

/** A reference could not be resolved. The message names the reference, never a value. */
export class SecretResolutionError extends Error {
  override readonly name = 'SecretResolutionError'
}

/**
 * Reads the value that a reference points to.
 *
 * @returns The secret value. The caller must not log it.
 * @throws SecretResolutionError when the value is missing.
 */
export async function resolveSecretReference(reference: SecretReference, dependencies: ResolveDependencies): Promise<string> {
  if (reference.source === 'environment') {
    const value = dependencies.environment[reference.variable]
    if (value === undefined || value === '') throw new SecretResolutionError(`The environment variable ${reference.variable} is not set.`)
    return value
  }
  if (reference.source === 'onepassword') {
    const result = await dependencies.run('op', ['read', '--no-newline', reference.reference])
    if (result.code !== 0) throw new SecretResolutionError(`op read ${reference.reference} failed: ${redactSecrets(result.stderr.trim())}`)
    return result.stdout
  }
  if (dependencies.store === null) throw new SecretResolutionError('No secret store is open. Unlock it first.')
  const value = await dependencies.store.get(reference.name)
  if (value === null) throw new SecretResolutionError(`Nothing is stored under ${reference.name}.`)
  return value
}
