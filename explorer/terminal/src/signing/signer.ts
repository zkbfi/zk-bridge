/**
 * The one interface that every kind of signer implements, and the check that every signature must pass.
 *
 * The transaction-building code (`../tx`) knows only this interface. A private key, a keystore, a mnemonic, a Ledger
 * and a Trezor all sit behind it, so the later web interface can use the same building code with its own signers.
 */
import {
  parseTransaction,
  recoverTransactionAddress,
  type Address,
  type Hex,
  type TransactionSerializableEIP1559,
} from 'viem'

/** The kinds of signer. */
export type SignerKind = 'private-key' | 'keystore' | 'mnemonic' | 'ledger' | 'trezor'

/** Options of one signing call. */
export interface SignTransactionOptions {
  /** Called with text that the user must read on the device, for example "Approve the transaction on your Ledger". */
  readonly onDevicePrompt?: (message: string) => void
}

/** A signer: one account that signs one kind of transaction. */
export interface Signer {
  readonly kind: SignerKind
  /** The account address, checksummed. */
  readonly address: Address
  /** The derivation path of the account, or null for a signer without one. */
  readonly derivationPath: string | null
  /** A short description for the account panel. It never holds secret material. */
  readonly description: string
  /**
   * Signs an EIP-1559 transaction and returns the serialized signed transaction.
   * @throws Error when the user rejects the request on the device, or the device refuses.
   */
  signTransaction(transaction: TransactionSerializableEIP1559, options?: SignTransactionOptions): Promise<Hex>
  /** Releases the device or clears secret material where the runtime allows it. */
  dispose(): Promise<void>
}

/** One derived address of an address source, with its position. */
export interface DerivedAddress {
  readonly index: number
  readonly path: string
  readonly address: Address
}

/** A source of many addresses, from which the user picks one: a mnemonic, a Ledger or a Trezor. */
export interface AddressSource {
  readonly kind: SignerKind
  /**
   * Lists addresses of a path template.
   * @param request The template holds `{index}`, and the list covers `start` to `start + count - 1`.
   */
  listAddresses(request: { readonly pathTemplate: string; readonly start: number; readonly count: number }): Promise<readonly DerivedAddress[]>
  /** Opens a signer for one path of the source. */
  openSigner(path: string): Promise<Signer>
  dispose(): Promise<void>
}

/** A signature came back that does not belong to the transaction or to the signer. */
export class SignatureMismatchError extends Error {
  override readonly name = 'SignatureMismatchError'
}

/**
 * Proves that a signed transaction is the transaction that was shown, signed by the expected account.
 *
 * A device or a library could return a signature for different content, or for another account. This function parses
 * the signed bytes, compares every field with the unsigned transaction, and recovers the signer from the signature.
 *
 * @throws SignatureMismatchError when any field differs or the recovered address is not `expectedSigner`.
 */
export async function assertSignedTransactionMatches(input: {
  readonly signed: Hex
  readonly unsigned: TransactionSerializableEIP1559
  readonly expectedSigner: Address
}): Promise<void> {
  const { signed, unsigned, expectedSigner } = input
  const parsed = parseTransaction(signed)
  const checks: ReadonlyArray<readonly [string, unknown, unknown]> = [
    ['type', parsed.type, 'eip1559'],
    ['chainId', parsed.chainId, unsigned.chainId],
    ['nonce', parsed.nonce, unsigned.nonce],
    ['to', parsed.to?.toLowerCase(), unsigned.to?.toLowerCase()],
    ['value', parsed.value ?? 0n, unsigned.value ?? 0n],
    ['data', (parsed.data ?? '0x').toLowerCase(), (unsigned.data ?? '0x').toLowerCase()],
    ['gas', parsed.gas, unsigned.gas],
    ['maxFeePerGas', parsed.maxFeePerGas, unsigned.maxFeePerGas],
    ['maxPriorityFeePerGas', parsed.maxPriorityFeePerGas, unsigned.maxPriorityFeePerGas],
  ]
  const differing = checks.find(([, found, wanted]) => found !== wanted)
  if (differing !== undefined) {
    throw new SignatureMismatchError(`The signed transaction differs from the one shown: ${differing[0]} changed.`)
  }
  const recovered = await recoverTransactionAddress({ serializedTransaction: signed as never })
  if (recovered.toLowerCase() !== expectedSigner.toLowerCase()) {
    throw new SignatureMismatchError(`The signature is from ${recovered}, not from ${expectedSigner}.`)
  }
}
