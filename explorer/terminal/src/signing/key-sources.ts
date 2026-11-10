/**
 * Loading of secrets from the places the user may keep them: an environment variable, a file, or a keystore.
 *
 * Nothing here prints a secret, logs it, or writes it. Each reader that takes a secret from the environment removes
 * the variable from the process environment, so a child process does not inherit it.
 */
import { readFile, stat } from 'node:fs/promises'
import type { Hex } from 'viem'
import { decryptKeystore } from './keystore'
import { createSoftwareSigner, parsePrivateKey } from './key-material'
import type { Signer } from './signer'

/** The names of the environment variables that the dashboard reads for secrets. */
export const SECRET_VARIABLES = {
  privateKey: 'EXPLORER_PRIVATE_KEY',
  privateKeyFile: 'EXPLORER_PRIVATE_KEY_FILE',
  keystoreFile: 'EXPLORER_KEYSTORE_FILE',
  mnemonic: 'EXPLORER_MNEMONIC',
  mnemonicFile: 'EXPLORER_MNEMONIC_FILE',
  mnemonicPassphrase: 'EXPLORER_MNEMONIC_PASSPHRASE',
} as const

/** A secret file has permissions that let other users read it. */
export class InsecureFileError extends Error {
  override readonly name = 'InsecureFileError'
  constructor(message: string) {
    super(message)
  }
}

/** A mutable view of the environment. Tests pass a plain object. */
export type Environment = Record<string, string | undefined>

/**
 * Reads a secret file. It refuses a file that group or others can read.
 *
 * @throws InsecureFileError when the mode allows access to group or others.
 */
export async function readSecretFile(path: string): Promise<string> {
  const { mode } = await stat(path)
  if ((mode & 0o077) !== 0) {
    throw new InsecureFileError(`${path} is readable by other users. Run: chmod 600 on it.`)
  }
  return readFile(path, 'utf8')
}

/**
 * Takes a value out of the environment and removes the variable.
 * @returns The value, or `undefined` when the variable is unset or empty.
 */
export function takeEnvironmentSecret(environment: Environment, name: string): string | undefined {
  const value = environment[name]
  delete environment[name]
  if (value === undefined || value === '') return undefined
  return value
}

/**
 * Builds a signer from the text of a private key.
 * @throws InvalidPrivateKeyError when the text is not a private key.
 */
export function signerFromPrivateKeyText(text: string): Signer {
  return createSoftwareSigner({
    kind: 'private-key',
    privateKey: parsePrivateKey(text),
    derivationPath: null,
    description: 'private key',
  })
}

/**
 * Builds a signer from a private key file.
 * @throws InsecureFileError for a file that others can read.
 */
export async function signerFromPrivateKeyFile(path: string): Promise<Signer> {
  return signerFromPrivateKeyText(await readSecretFile(path))
}

/**
 * Builds a signer from an encrypted keystore and a password.
 * @throws KeystorePasswordError when the password is wrong.
 */
export async function signerFromKeystoreFile(path: string, password: string): Promise<Signer> {
  const keystoreJson = await readFile(path, 'utf8')
  const privateKey: Hex = await decryptKeystore(keystoreJson, password)
  return createSoftwareSigner({ kind: 'keystore', privateKey, derivationPath: null, description: 'keystore' })
}
