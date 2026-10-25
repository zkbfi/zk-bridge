/**
 * BIP-39 mnemonics and BIP-32 derivation of Ethereum accounts.
 */
import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { bytesToHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createSoftwareSigner } from './key-material'
import type { AddressSource, DerivedAddress, Signer } from './signer'

/** The standard Ethereum path with an account index: `m/44'/60'/0'/0/{index}`. */
export const DEFAULT_PATH_TEMPLATE = "m/44'/60'/0'/0/{index}"

/** The placeholder that a path template uses for the account index. */
export const INDEX_PLACEHOLDER = '{index}'

/** The mnemonic or the path is not valid. The message never includes the mnemonic. */
export class MnemonicError extends Error {
  override readonly name = 'MnemonicError'
}

const PATH_PATTERN = /^m(\/\d+'?)+$/

/**
 * Normalizes the text of a mnemonic: lower case, single spaces. It then checks the word list and the checksum.
 *
 * @throws MnemonicError when a word is not in the English word list, the count is wrong, or the checksum fails.
 */
export function normalizeMnemonic(text: string): string {
  const normalized = text.trim().toLowerCase().split(/\s+/).join(' ')
  if (!validateMnemonic(normalized, wordlist)) {
    throw new MnemonicError('The mnemonic is not valid: check the words, the count and the checksum.')
  }
  return normalized
}

/**
 * Checks a derivation path template.
 *
 * A template is a path such as `m/44'/60'/0'/0/{index}`. It may omit `{index}` to name one fixed account.
 *
 * @throws MnemonicError when the template is not a path of numbers and hardened marks, or when `{index}` is not a
 * whole path element.
 */
export function assertPathTemplate(template: string): void {
  const probe = template.split(INDEX_PLACEHOLDER).join('0')
  const placeholders = template.split(INDEX_PLACEHOLDER).length - 1
  if (placeholders > 1) throw new MnemonicError('A path template may hold {index} once.')
  if (!PATH_PATTERN.test(probe)) {
    throw new MnemonicError("A path looks like m/44'/60'/0'/0/{index}: numbers, with ' for hardened elements.")
  }
  if (template.includes(INDEX_PLACEHOLDER) && !/\/\{index\}'?(\/|$)/.test(template)) {
    throw new MnemonicError('{index} must be a whole element of the path.')
  }
}

/** Puts an index into a path template. */
export function expandPath(template: string, index: number): string {
  assertPathTemplate(template)
  return template.split(INDEX_PLACEHOLDER).join(String(index))
}

/** Input of {@link createMnemonicSource}. */
export interface MnemonicSourceInput {
  readonly mnemonic: string
  /** The optional BIP-39 passphrase. An empty string means none. */
  readonly passphrase?: string
}

/**
 * Creates an address source from a mnemonic.
 *
 * The source keeps the root key only. It does not keep the mnemonic text. A signer holds the key of one account.
 *
 * @throws MnemonicError when the mnemonic is not valid.
 */
export function createMnemonicSource(input: MnemonicSourceInput): AddressSource {
  const seed = mnemonicToSeedSync(normalizeMnemonic(input.mnemonic), input.passphrase ?? '')
  const root = HDKey.fromMasterSeed(seed)
  seed.fill(0)

  function privateKeyAt(path: string) {
    assertPathTemplate(path)
    const key = root.derive(path).privateKey
    if (key === null) throw new MnemonicError('The derivation produced no private key.')
    return bytesToHex(key)
  }

  return {
    kind: 'mnemonic',
    async listAddresses({ pathTemplate, start, count }): Promise<readonly DerivedAddress[]> {
      return Array.from({ length: count }, (_, offset) => {
        const index = start + offset
        const path = expandPath(pathTemplate, index)
        return { index, path, address: privateKeyToAccount(privateKeyAt(path)).address }
      })
    },
    async openSigner(path: string): Promise<Signer> {
      return createSoftwareSigner({
        kind: 'mnemonic',
        privateKey: privateKeyAt(path),
        derivationPath: path,
        description: `mnemonic ${path}`,
      })
    },
    async dispose() {
      root.wipePrivateData()
    },
  }
}
