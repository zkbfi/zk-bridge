/**
 * Decryption of an Ethereum keystore (Web3 Secret Storage, version 3), the format that Foundry `cast wallet import`
 * writes. The key is decrypted in memory. Nothing is written anywhere.
 */
import { createDecipheriv, pbkdf2, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { keccak256, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { parsePrivateKey } from './key-material'

const scryptAsync = promisify(scrypt) as (
  password: Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>
const pbkdf2Async = promisify(pbkdf2)

/** The keystore file is not a version 3 keystore that this reader supports. */
export class KeystoreFormatError extends Error {
  override readonly name = 'KeystoreFormatError'
}

/** The password does not open the keystore: the message authentication code differs. */
export class KeystorePasswordError extends Error {
  override readonly name = 'KeystorePasswordError'
  constructor() {
    super('Wrong password, or the keystore is damaged.')
  }
}

/** Decrypts a keystore and returns its private key.
 *
 * @param keystoreJson The text of the keystore file.
 * @param password The password. It is read as UTF-8 bytes, as the standard says.
 * @throws KeystoreFormatError for an unsupported or malformed keystore.
 * @throws KeystorePasswordError when the password is wrong.
 */
export async function decryptKeystore(keystoreJson: string, password: string): Promise<Hex> {
  const crypto = readCrypto(parseKeystore(keystoreJson))
  const derivedKey = await deriveKey(crypto.kdf, crypto.kdfparams, Buffer.from(password, 'utf8'))
  const ciphertext = hexBytes(crypto.ciphertext, 'ciphertext')
  const expectedMac = hexBytes(crypto.mac, 'mac')
  const actualMac = Buffer.from(keccak256(Buffer.concat([derivedKey.subarray(16, 32), ciphertext])).slice(2), 'hex')
  if (actualMac.length !== expectedMac.length || !timingSafeEqual(actualMac, expectedMac)) {
    throw new KeystorePasswordError()
  }
  if (crypto.cipher !== 'aes-128-ctr') throw new KeystoreFormatError(`Cipher ${crypto.cipher} is not supported.`)
  const decipher = createDecipheriv('aes-128-ctr', derivedKey.subarray(0, 16), hexBytes(crypto.cipherparams.iv, 'iv'))
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  const privateKey = parsePrivateKey(plain.toString('hex'))
  plain.fill(0)
  derivedKey.fill(0)
  requireAddressMatch(keystoreJson, privateKey)
  return privateKey
}

interface KeystoreCrypto {
  readonly cipher: string
  readonly cipherparams: { readonly iv: string }
  readonly ciphertext: string
  readonly kdf: string
  readonly kdfparams: Record<string, unknown>
  readonly mac: string
}

function parseKeystore(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value === 'object' && value !== null) return value as Record<string, unknown>
  } catch {
    // The error below is the same for text that is not JSON.
  }
  throw new KeystoreFormatError('The keystore is not valid JSON.')
}

function readCrypto(keystore: Record<string, unknown>): KeystoreCrypto {
  if (keystore.version !== 3) throw new KeystoreFormatError('Only keystore version 3 is supported.')
  const crypto = keystore.crypto ?? keystore.Crypto
  if (typeof crypto !== 'object' || crypto === null) throw new KeystoreFormatError('The keystore has no crypto section.')
  const record = crypto as Record<string, unknown>
  const cipherparams = record.cipherparams as { iv?: unknown } | undefined
  const kdfparams = record.kdfparams as Record<string, unknown> | undefined
  const fields = [record.cipher, record.ciphertext, record.kdf, record.mac, cipherparams?.iv]
  if (fields.some((field) => typeof field !== 'string') || kdfparams === undefined) {
    throw new KeystoreFormatError('The crypto section of the keystore is incomplete.')
  }
  return record as unknown as KeystoreCrypto
}

async function deriveKey(kdf: string, parameters: Record<string, unknown>, password: Buffer): Promise<Buffer> {
  const keyLength = integerParameter(parameters, 'dklen')
  const salt = hexBytes(String(parameters.salt), 'salt')
  if (keyLength < 32) throw new KeystoreFormatError('The derived key length must be at least 32 bytes.')
  if (kdf === 'scrypt') return deriveWithScrypt({ parameters, password, salt, keyLength })
  if (kdf === 'pbkdf2') return deriveWithPbkdf2({ parameters, password, salt, keyLength })
  throw new KeystoreFormatError(`Key derivation function ${kdf} is not supported.`)
}

async function deriveWithScrypt(input: {
  parameters: Record<string, unknown>
  password: Buffer
  salt: Buffer
  keyLength: number
}): Promise<Buffer> {
  const N = integerParameter(input.parameters, 'n')
  const r = integerParameter(input.parameters, 'r')
  const p = integerParameter(input.parameters, 'p')
  // Node refuses a memory use above `maxmem`. The scrypt memory is about 128 * N * r bytes.
  const maxmem = 128 * N * r * 2 + 128 * r * p + 1024 * 1024
  try {
    return await scryptAsync(input.password, input.salt, input.keyLength, { N, r, p, maxmem })
  } catch (error) {
    // RFC 7914 requires N < 2^(128 * r / 8), and OpenSSL enforces it. Some old test files break the rule.
    throw new KeystoreFormatError(`The scrypt parameters are not accepted (N=${N}, r=${r}, p=${p}): ${(error as Error).message}`)
  }
}

async function deriveWithPbkdf2(input: {
  parameters: Record<string, unknown>
  password: Buffer
  salt: Buffer
  keyLength: number
}): Promise<Buffer> {
  if (input.parameters.prf !== 'hmac-sha256') throw new KeystoreFormatError('Only the hmac-sha256 pseudo-random function is supported.')
  const iterations = integerParameter(input.parameters, 'c')
  return pbkdf2Async(input.password, input.salt, iterations, input.keyLength, 'sha256')
}

function integerParameter(parameters: Record<string, unknown>, name: string): number {
  const value = parameters[name]
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  throw new KeystoreFormatError(`The key derivation parameter ${name} is missing or invalid.`)
}

function hexBytes(text: string, name: string): Buffer {
  const digits = text.startsWith('0x') ? text.slice(2) : text
  if (!/^([0-9a-fA-F]{2})*$/.test(digits)) throw new KeystoreFormatError(`The keystore field ${name} is not hex.`)
  return Buffer.from(digits, 'hex')
}

/** When the keystore names an address, the decrypted key must belong to it. A name is a claim, not proof. */
function requireAddressMatch(keystoreJson: string, privateKey: Hex): void {
  const named: unknown = (JSON.parse(keystoreJson) as { address?: unknown }).address
  if (typeof named !== 'string' || named === '') return
  const found = privateKeyToAccount(privateKey).address.toLowerCase().replace(/^0x/, '')
  if (found === named.toLowerCase().replace(/^0x/, '')) return
  throw new KeystoreFormatError('The decrypted key does not belong to the address in the keystore.')
}
