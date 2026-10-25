import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createCipheriv, scryptSync } from 'node:crypto'
import { keccak256 } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import {
  KeystoreFormatError,
  KeystorePasswordError,
  decryptKeystore,
} from '../../src/signing/keystore'

// A keystore written by Foundry `cast wallet import`. It holds the first Anvil development key, which is public.
const castKeystore = readFileSync(new URL('../fixtures/cast-keystore.json', import.meta.url), 'utf8')
const CAST_PASSWORD = 'correct horse battery staple'
const ANVIL_FIRST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

// The test vectors of the Web3 Secret Storage definition. The password is "testpassword".
const SPECIFICATION_KEY = '0x7a28b5ba57c53603b0b07b56bba752f7784bf506fa95edc395f5cf6c7514fe9d'
const specificationPbkdf2 = JSON.stringify({
  crypto: {
    cipher: 'aes-128-ctr',
    cipherparams: { iv: '6087dab2f9fdbbfaddc31a909735c1e6' },
    ciphertext: '5318b4d5bcd28de64ee5559e671353e16f075ecae9f99c7a79a38af5f869aa46',
    kdf: 'pbkdf2',
    kdfparams: {
      c: 262144,
      dklen: 32,
      prf: 'hmac-sha256',
      salt: 'ae3cd4e7013836a3df6bd7241b12db061dbe2c6785853cce422d148a624ce0bd',
    },
    mac: '517ead924a9d0dc3124507e3393d175ce3ff7c1e96529c6c555ce9e51205e9b2',
  },
  id: '3198bc9c-6672-5ab3-d995-4942343ae5b6',
  version: 3,
})

/** Writes a version 3 keystore with the given scrypt parameters, following the Web3 Secret Storage definition. */
function encryptForTest(input: { privateKey: string; password: string; n: number; r: number; p: number }): string {
  const salt = Buffer.alloc(32, 7)
  const iv = Buffer.alloc(16, 9)
  const derived = scryptSync(input.password, salt, 32, { N: input.n, r: input.r, p: input.p, maxmem: 1 << 30 })
  const cipher = createCipheriv('aes-128-ctr', derived.subarray(0, 16), iv)
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(input.privateKey.slice(2), 'hex')), cipher.final()])
  const mac = keccak256(Buffer.concat([derived.subarray(16, 32), ciphertext])).slice(2)
  return JSON.stringify({
    version: 3,
    crypto: {
      cipher: 'aes-128-ctr',
      cipherparams: { iv: iv.toString('hex') },
      ciphertext: ciphertext.toString('hex'),
      kdf: 'scrypt',
      kdfparams: { dklen: 32, n: input.n, r: input.r, p: input.p, salt: salt.toString('hex') },
      mac,
    },
  })
}

describe('decryptKeystore', () => {
  test('opens a keystore that Foundry wrote, and yields the key it was made from', async () => {
    const key = await decryptKeystore(castKeystore, CAST_PASSWORD)
    expect(key).toBe(ANVIL_FIRST_KEY)
    expect(privateKeyToAddress(key)).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
  })

  test('opens a keystore with the memory-hard parameters that Geth writes (N=262144, r=8, p=1)', async () => {
    const keystore = encryptForTest({ privateKey: SPECIFICATION_KEY, password: 'testpassword', n: 262_144, r: 8, p: 1 })
    expect(await decryptKeystore(keystore, 'testpassword')).toBe(SPECIFICATION_KEY)
  })

  test('says so when OpenSSL refuses the scrypt parameters of a file (N=262144, r=1 breaks RFC 7914)', async () => {
    const keystore = JSON.parse(castKeystore)
    keystore.crypto.kdfparams = { ...keystore.crypto.kdfparams, n: 262_144, r: 1, p: 8 }
    await expect(decryptKeystore(JSON.stringify(keystore), CAST_PASSWORD)).rejects.toBeInstanceOf(KeystoreFormatError)
  })

  test('opens the specification pbkdf2 vector', async () => {
    expect(await decryptKeystore(specificationPbkdf2, 'testpassword')).toBe(SPECIFICATION_KEY)
  })

  test('a wrong password fails the MAC check and returns no key', async () => {
    await expect(decryptKeystore(castKeystore, 'wrong password')).rejects.toBeInstanceOf(KeystorePasswordError)
    await expect(decryptKeystore(castKeystore, '')).rejects.toBeInstanceOf(KeystorePasswordError)
  })

  test('a flipped ciphertext bit is caught by the MAC, not decrypted into a wrong key', async () => {
    const tampered = JSON.parse(castKeystore)
    const bytes = Buffer.from(tampered.crypto.ciphertext, 'hex')
    bytes[0] = (bytes[0] ?? 0) ^ 1
    tampered.crypto.ciphertext = bytes.toString('hex')
    await expect(decryptKeystore(JSON.stringify(tampered), CAST_PASSWORD)).rejects.toBeInstanceOf(KeystorePasswordError)
  })

  test('refuses a keystore whose named address is not the address of its key', async () => {
    const lying = JSON.parse(castKeystore)
    lying.address = '000000000000000000000000000000000000dead'
    await expect(decryptKeystore(JSON.stringify(lying), CAST_PASSWORD)).rejects.toBeInstanceOf(KeystoreFormatError)
    const honest = JSON.parse(castKeystore)
    honest.address = 'f39fd6e51aad88f6f4ce6ab8827279cfffb92266'
    expect(await decryptKeystore(JSON.stringify(honest), CAST_PASSWORD)).toBe(ANVIL_FIRST_KEY)
  })

  test('refuses other versions, other key derivation functions, and text that is not JSON', async () => {
    const wrongVersion = JSON.parse(castKeystore)
    wrongVersion.version = 2
    const unknownKdf = JSON.parse(castKeystore)
    unknownKdf.crypto.kdf = 'argon2'
    for (const text of [JSON.stringify(wrongVersion), JSON.stringify(unknownKdf), 'not json', '{}', 'null']) {
      await expect(decryptKeystore(text, CAST_PASSWORD)).rejects.toBeInstanceOf(KeystoreFormatError)
    }
  })

  test('the error for a wrong password does not carry the password or the key', async () => {
    const error = await decryptKeystore(castKeystore, 'hunter2-not-the-password').catch((caught: Error) => caught)
    expect((error as Error).message).not.toContain('hunter2')
    expect((error as Error).message).not.toContain(ANVIL_FIRST_KEY.slice(2, 12))
  })
})
