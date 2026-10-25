import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_PATH_TEMPLATE,
  MnemonicError,
  assertPathTemplate,
  createMnemonicSource,
  expandPath,
  normalizeMnemonic,
} from '../../src/signing/mnemonic'

// The public BIP-39 test vector. Every address below was also produced by Foundry `cast wallet`,
// an independent implementation, so the expected values do not come from the code under test.
const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('derivation against the standard "abandon ... about" vector', () => {
  test('the default path gives the well-known first three addresses', async () => {
    const source = createMnemonicSource({ mnemonic: ABANDON })
    const listed = await source.listAddresses({ pathTemplate: DEFAULT_PATH_TEMPLATE, start: 0, count: 3 })
    expect(listed.map((entry) => entry.address)).toEqual([
      '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
      '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0',
      '0xb6716976A3ebe8D39aCEB04372f22Ff8e6802D7A',
    ])
    expect(listed.map((entry) => entry.path)).toEqual(["m/44'/60'/0'/0/0", "m/44'/60'/0'/0/1", "m/44'/60'/0'/0/2"])
  })

  test('a custom hardened path gives the address that cast gives', async () => {
    const source = createMnemonicSource({ mnemonic: ABANDON })
    const listed = await source.listAddresses({ pathTemplate: "m/44'/60'/1'/0/{index}", start: 0, count: 1 })
    expect(listed[0]?.address).toBe('0x78839F6054d7ed13918bAe0473BA31b1Ca9D7265')
    const ledgerLiveStyle = await source.listAddresses({ pathTemplate: "m/44'/60'/{index}'/0/5", start: 2, count: 1 })
    expect(ledgerLiveStyle[0]?.path).toBe("m/44'/60'/2'/0/5")
    expect(ledgerLiveStyle[0]?.address).toBe('0x62E8d98696E8C9cd89c67dCD8897B813E74bBdF6')
  })

  test('a page of addresses continues where the last page ended', async () => {
    const source = createMnemonicSource({ mnemonic: ABANDON })
    const firstPage = await source.listAddresses({ pathTemplate: DEFAULT_PATH_TEMPLATE, start: 0, count: 5 })
    const secondPage = await source.listAddresses({ pathTemplate: DEFAULT_PATH_TEMPLATE, start: 5, count: 5 })
    expect(secondPage[0]?.index).toBe(5)
    expect(new Set([...firstPage, ...secondPage].map((entry) => entry.address)).size).toBe(10)
  })

  test('the BIP-39 passphrase changes every address (vector: passphrase TREZOR)', async () => {
    const source = createMnemonicSource({ mnemonic: ABANDON, passphrase: 'TREZOR' })
    const [first] = await source.listAddresses({ pathTemplate: DEFAULT_PATH_TEMPLATE, start: 0, count: 1 })
    expect(first?.address).toBe('0x9c32F71D4DB8Fb9e1A58B0a80dF79935e7256FA6')
  })

  test('the signer of a derived path signs as that address', async () => {
    const source = createMnemonicSource({ mnemonic: ABANDON })
    const signer = await source.openSigner("m/44'/60'/0'/0/1")
    expect(signer.address).toBe('0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0')
    expect(signer.kind).toBe('mnemonic')
    expect(signer.derivationPath).toBe("m/44'/60'/0'/0/1")
  })
})

describe('mnemonic validation', () => {
  test('normalizes case and spacing', () => {
    expect(normalizeMnemonic(`  ${ABANDON.toUpperCase().replaceAll(' ', '   ')}\n`)).toBe(ABANDON)
  })

  test('refuses a bad checksum and an unknown word, and never repeats the phrase in the message', () => {
    const badChecksum = ABANDON.replace('about', 'abandon')
    for (const phrase of [badChecksum, `${ABANDON} extra`, 'not a mnemonic at all']) {
      let message = ''
      try {
        createMnemonicSource({ mnemonic: phrase })
      } catch (error) {
        expect(error).toBeInstanceOf(MnemonicError)
        message = (error as Error).message
      }
      expect(message).not.toBe('')
      expect(message).not.toContain('abandon')
    }
  })
})

describe('path templates', () => {
  test('accepts the standard shapes', () => {
    for (const template of [DEFAULT_PATH_TEMPLATE, "m/44'/60'/{index}'/0/0", "m/44'/60'/0'/0/7", 'm/0']) {
      expect(() => assertPathTemplate(template)).not.toThrow()
    }
  })

  test('refuses text that is not a path, and a placeholder inside a number', () => {
    for (const template of ['44/60/0', "m/44'/60'/0'/0/x", "m/44'/60'/0'/0/{index}{index}", "m/44'/60'/0'/0/1{index}", '', "m//0"]) {
      expect(() => assertPathTemplate(template)).toThrow(MnemonicError)
    }
  })

  test('expandPath puts the index in', () => {
    expect(expandPath(DEFAULT_PATH_TEMPLATE, 12)).toBe("m/44'/60'/0'/0/12")
  })
})
