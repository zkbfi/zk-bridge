import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'
import type { TransactionSerializableEIP1559 } from 'viem'
import { InvalidPrivateKeyError, createSoftwareSigner, parsePrivateKey } from '../../src/signing/key-material'
import {
  InsecureFileError,
  readSecretFile,
  signerFromKeystoreFile,
  signerFromPrivateKeyFile,
  signerFromPrivateKeyText,
  takeEnvironmentSecret,
} from '../../src/signing/key-sources'
import { KeystorePasswordError } from '../../src/signing/keystore'
import { SignatureMismatchError, assertSignedTransactionMatches } from '../../src/signing/signer'

// The first two public Anvil development keys. They are published test values, not secrets.
const FIRST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const FIRST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const SECOND_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'

const TRANSACTION: TransactionSerializableEIP1559 = {
  type: 'eip1559',
  chainId: 1,
  nonce: 9,
  to: '0x2222222222222222222222222222222222222222',
  value: 1_000n,
  data: '0xdeadbeef',
  gas: 90_000n,
  maxFeePerGas: 40_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
}

const scratch: string[] = []
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function scratchDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'explorer-terminal-test-'))
  scratch.push(directory)
  return directory
}

describe('parsePrivateKey', () => {
  test('accepts 64 hex digits with or without the prefix, and trims white space', () => {
    expect(parsePrivateKey(FIRST_KEY)).toBe(FIRST_KEY)
    expect(parsePrivateKey(FIRST_KEY.slice(2))).toBe(FIRST_KEY)
    expect(parsePrivateKey(`  ${FIRST_KEY.toUpperCase().replace('0X', '0x')}\n`)).toBe(FIRST_KEY)
  })

  test('refuses a short key, a non-hex key, zero, and a value at or above the curve order', () => {
    const order = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
    for (const text of ['0x1234', 'z'.repeat(64), '0'.repeat(64), order, 'f'.repeat(64), '']) {
      expect(() => parsePrivateKey(text)).toThrow(InvalidPrivateKeyError)
    }
  })

  test('the message of a refusal never contains the text that was refused', () => {
    const attempt = `${FIRST_KEY.slice(0, 40)}zz`
    const message = (() => {
      try {
        parsePrivateKey(attempt)
        return ''
      } catch (error) {
        return (error as Error).message
      }
    })()
    expect(message).not.toBe('')
    expect(message).not.toContain(attempt.slice(2, 20))
  })
})

describe('software signer', () => {
  test('signs a transaction that passes the check against the transaction shown', async () => {
    const signer = signerFromPrivateKeyText(FIRST_KEY)
    expect(signer.address).toBe(FIRST_ADDRESS)
    const signed = await signer.signTransaction(TRANSACTION)
    await assertSignedTransactionMatches({ signed, unsigned: TRANSACTION, expectedSigner: signer.address })
  })

  test('the signer holds no key in any property or in its serialization', () => {
    const signer = signerFromPrivateKeyText(FIRST_KEY)
    const everything = `${JSON.stringify(signer)} ${Object.keys(signer).join(' ')} ${String(Object.values(signer))}`
    expect(everything).not.toContain(FIRST_KEY.slice(2, 30))
  })

  test('the check rejects a signature made for other content, field by field', async () => {
    const signer = signerFromPrivateKeyText(FIRST_KEY)
    const signed = await signer.signTransaction(TRANSACTION)
    const changes: Array<Partial<TransactionSerializableEIP1559>> = [
      { to: '0x3333333333333333333333333333333333333333' },
      { value: 1_001n },
      { data: '0xdeadbef0' },
      { nonce: 10 },
      { gas: 90_001n },
      { chainId: 369 },
      { maxFeePerGas: 40_000_000_001n },
      { maxPriorityFeePerGas: 1_000_000_001n },
    ]
    for (const change of changes) {
      await expect(
        assertSignedTransactionMatches({ signed, unsigned: { ...TRANSACTION, ...change }, expectedSigner: signer.address }),
      ).rejects.toBeInstanceOf(SignatureMismatchError)
    }
  })

  test('the check rejects a signature from another account', async () => {
    const other = createSoftwareSigner({
      kind: 'private-key',
      privateKey: SECOND_KEY,
      derivationPath: null,
      description: 'private key',
    })
    const signed = await other.signTransaction(TRANSACTION)
    await expect(
      assertSignedTransactionMatches({ signed, unsigned: TRANSACTION, expectedSigner: privateKeyToAccount(FIRST_KEY).address }),
    ).rejects.toBeInstanceOf(SignatureMismatchError)
  })
})

describe('key sources', () => {
  test('takeEnvironmentSecret returns the value and removes the variable', () => {
    const environment: Record<string, string | undefined> = { EXPLORER_PRIVATE_KEY: FIRST_KEY, OTHER: 'kept' }
    expect(takeEnvironmentSecret(environment, 'EXPLORER_PRIVATE_KEY')).toBe(FIRST_KEY)
    expect('EXPLORER_PRIVATE_KEY' in environment).toBe(false)
    expect(environment.OTHER).toBe('kept')
    expect(takeEnvironmentSecret(environment, 'EXPLORER_PRIVATE_KEY')).toBeUndefined()
  })

  test('an empty variable counts as unset, and is removed too', () => {
    const environment: Record<string, string | undefined> = { EXPLORER_PRIVATE_KEY: '' }
    expect(takeEnvironmentSecret(environment, 'EXPLORER_PRIVATE_KEY')).toBeUndefined()
    expect('EXPLORER_PRIVATE_KEY' in environment).toBe(false)
  })

  test('reads a key file with owner-only permissions', async () => {
    const path = join(await scratchDirectory(), 'key.txt')
    await writeFile(path, `${FIRST_KEY}\n`, { mode: 0o600 })
    await chmod(path, 0o600)
    expect((await signerFromPrivateKeyFile(path)).address).toBe(FIRST_ADDRESS)
  })

  test('refuses a key file that group or others can read, before it reads a byte', async () => {
    const path = join(await scratchDirectory(), 'key.txt')
    await writeFile(path, FIRST_KEY)
    for (const mode of [0o644, 0o640, 0o604, 0o660]) {
      await chmod(path, mode)
      await expect(readSecretFile(path)).rejects.toBeInstanceOf(InsecureFileError)
    }
  })

  test('opens a keystore file with the password, and refuses a wrong password', async () => {
    const path = new URL('../fixtures/cast-keystore.json', import.meta.url).pathname
    const signer = await signerFromKeystoreFile(path, 'correct horse battery staple')
    expect(signer.address).toBe(FIRST_ADDRESS)
    expect(signer.kind).toBe('keystore')
    await expect(signerFromKeystoreFile(path, 'nope')).rejects.toBeInstanceOf(KeystorePasswordError)
  })
})
