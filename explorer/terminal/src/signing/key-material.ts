/**
 * Shared checks for private keys, and the signer built from one.
 */
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex, TransactionSerializableEIP1559 } from 'viem'
import type { SignTransactionOptions, Signer, SignerKind } from './signer'

/** The text is not a private key. The message never includes the text. */
export class InvalidPrivateKeyError extends Error {
  override readonly name = 'InvalidPrivateKeyError'
}

/** The order of the secp256k1 group. A private key must be below it. */
const CURVE_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

/**
 * Reads a private key from text: 64 hex digits, with or without a `0x` prefix, surrounded by white space at most.
 *
 * @throws InvalidPrivateKeyError when the text is not a key in the range 1 to the curve order minus one.
 */
export function parsePrivateKey(text: string): Hex {
  const trimmed = text.trim()
  const digits = trimmed.startsWith('0x') || trimmed.startsWith('0X') ? trimmed.slice(2) : trimmed
  if (!/^[0-9a-fA-F]{64}$/.test(digits)) {
    throw new InvalidPrivateKeyError('A private key is 64 hex digits, with or without a 0x prefix.')
  }
  const value = BigInt(`0x${digits}`)
  if (value === 0n || value >= CURVE_ORDER) throw new InvalidPrivateKeyError('The private key is outside the valid range.')
  return `0x${digits.toLowerCase()}`
}

/** Input of {@link createSoftwareSigner}. */
export interface SoftwareSignerInput {
  readonly kind: Extract<SignerKind, 'private-key' | 'keystore' | 'mnemonic'>
  readonly privateKey: Hex
  readonly derivationPath: string | null
  readonly description: string
}

/**
 * Builds a signer that holds a key in memory. The key lives in the closure only: it is not a property, it is not
 * serialized, and printing the signer shows nothing of it.
 */
export function createSoftwareSigner(input: SoftwareSignerInput): Signer {
  const account = privateKeyToAccount(input.privateKey)
  return {
    kind: input.kind,
    address: account.address,
    derivationPath: input.derivationPath,
    description: input.description,
    signTransaction(transaction: TransactionSerializableEIP1559, _options?: SignTransactionOptions) {
      return account.signTransaction(transaction)
    },
    async dispose() {
      // A JavaScript string cannot be wiped. The key leaves reach when the closure is released.
    },
  }
}
