import { describe, expect, test } from 'bun:test'
import { parseTransaction, type TransactionSerializableEIP1559 } from 'viem'
import { HardwareWalletError } from '../../src/signing/hardware-error'
import {
  createTrezorSource,
  parseTrezorConnect,
  loadTrezorConnect,
  type TrezorApi,
  type TrezorResponse,
} from '../../src/signing/trezor'

const TEMPLATE = "m/44'/60'/0'/0/{index}"
const ADDRESS = '0x9858effd232b4033e47d90003d41ec34ecaeda94'

const TRANSACTION: TransactionSerializableEIP1559 = {
  type: 'eip1559',
  chainId: 369,
  nonce: 1,
  to: '0x1111111111111111111111111111111111111111',
  value: 0n,
  data: '0x',
  gas: 21_000n,
  maxFeePerGas: 2n,
  maxPriorityFeePerGas: 1n,
}

type Failure = { error: string; code?: string }

/** A Trezor library whose answers the test sets. It records the order of the calls. */
function scriptedTrezor(answers: {
  address?: TrezorResponse<{ address: string }>
  signature?: TrezorResponse<{ v: string; r: string; s: string }>
}) {
  const events: string[] = []
  const api: TrezorApi = {
    async init(settings) {
      events.push(`init ${settings.manifest.email}`)
    },
    async ethereumGetAddress() {
      return answers.address ?? { success: true, payload: { address: ADDRESS } }
    },
    async ethereumSignTransaction() {
      return answers.signature ?? { success: true, payload: { v: '0x0', r: '0x01', s: '0x02' } }
    },
    dispose() {
      events.push('dispose')
    },
  }
  return { api, events }
}

async function failureOf(failure: Failure): Promise<HardwareWalletError> {
  const { api } = scriptedTrezor({ address: { success: false, payload: failure } })
  const source = createTrezorSource({ api, contact: 'contact-for-test' })
  return (await source.listAddresses({ pathTemplate: TEMPLATE, start: 0, count: 1 }).catch((error: unknown) => error)) as HardwareWalletError
}

describe('Trezor failures', () => {
  test('maps a cancel by code or by text to rejected', async () => {
    expect((await failureOf({ error: 'x', code: 'Failure_ActionCancelled' })).failure).toBe('rejected')
    expect((await failureOf({ error: 'Request was rejected by the user' })).failure).toBe('rejected')
  })

  test('maps a missing device by code or by text to no device', async () => {
    expect((await failureOf({ error: 'x', code: 'Device_NotFound' })).failure).toBe('no-device')
    expect((await failureOf({ error: 'Device not found' })).failure).toBe('no-device')
  })

  test('maps a PIN or passphrase failure to locked, and keeps the text of the library', async () => {
    const error = await failureOf({ error: 'PIN invalid' })
    expect(error.failure).toBe('locked')
    expect(error.message).toBe('The device is locked. Unlock it, then try again. (PIN invalid)')
  })

  test('keeps the text of any other failure', async () => {
    const error = await failureOf({ error: 'Firmware too old' })
    expect(error.failure).toBe('other')
    expect(error.message).toBe('The device returned an error. (Firmware too old)')
  })
})

describe('Trezor signing', () => {
  test('pads the short signature words to 32 bytes and reads the parity', async () => {
    const { api } = scriptedTrezor({ signature: { success: true, payload: { v: '1', r: '0x01', s: '02' } } })
    const signer = await createTrezorSource({ api, contact: 'contact-for-test' }).openSigner("m/44'/60'/0'/0/0")
    const signed = await signer.signTransaction(TRANSACTION)
    const parsed = parseTransaction(signed)
    expect(parsed.r).toBe(`0x${'0'.repeat(63)}1`)
    expect(parsed.s).toBe(`0x${'0'.repeat(63)}2`)
    expect(parsed.yParity).toBe(1)
  })

  test('shows the prompt of the call, with the chain, before it asks the device', async () => {
    const { api } = scriptedTrezor({})
    const sourcePrompts: string[] = []
    const source = createTrezorSource({ api, contact: 'contact-for-test', onDevicePrompt: (message) => sourcePrompts.push(message) })
    const signer = await source.openSigner("m/44'/60'/0'/0/0")
    const callPrompts: string[] = []
    await signer.signTransaction(TRANSACTION, { onDevicePrompt: (message) => callPrompts.push(message) })
    expect(callPrompts).toEqual([
      'Check the transaction on your Trezor (chain 369) and confirm it there. Reject it if anything differs from this screen.',
    ])
    // The prompt of the source is for opening the signer only. The call prompt replaces it for signing.
    expect(sourcePrompts).toEqual(['Confirm the address on the Trezor screen.'])
    await signer.signTransaction(TRANSACTION)
    expect(sourcePrompts).toHaveLength(2)
    expect(sourcePrompts[1]).toContain('Check the transaction on your Trezor')
  })

  test('maps a refusal while it signs', async () => {
    const { api } = scriptedTrezor({ signature: { success: false, payload: { error: 'x', code: 'Failure_ActionCancelled' } } })
    const signer = await createTrezorSource({ api, contact: 'contact-for-test' }).openSigner("m/44'/60'/0'/0/0")
    const failed = await signer.signTransaction(TRANSACTION).catch((error: unknown) => error)
    expect((failed as HardwareWalletError).failure).toBe('rejected')
  })

  test('a signer does not dispose the library that its source owns', async () => {
    const { api, events } = scriptedTrezor({})
    const source = createTrezorSource({ api, contact: 'contact-for-test' })
    const signer = await source.openSigner("m/44'/60'/0'/0/0")
    await signer.dispose()
    expect(events).not.toContain('dispose')
    await source.dispose()
    expect(events).toEqual(['init contact-for-test', 'dispose'])
  })
})

describe('Trezor library start', () => {
  test('disposing a source that never started does nothing', async () => {
    const { api, events } = scriptedTrezor({})
    await createTrezorSource({ api, contact: 'contact-for-test' }).dispose()
    expect(events).toEqual([])
  })

  test('forgets a failed start, so the next call can start again', async () => {
    const { api, events } = scriptedTrezor({})
    const source = createTrezorSource({ api, contact: '' })
    await expect(source.listAddresses({ pathTemplate: TEMPLATE, start: 0, count: 1 })).rejects.toThrow('EXPLORER_TREZOR_CONTACT')
    expect(events).toEqual([])
    const startsLater = createTrezorSource({ api, contact: 'later' })
    await startsLater.listAddresses({ pathTemplate: TEMPLATE, start: 0, count: 1 })
    expect(events).toEqual(['init later'])
  })

  test('disposing after a failed start does not throw', async () => {
    const { api } = scriptedTrezor({})
    const source = createTrezorSource({ api, contact: '' })
    await source.listAddresses({ pathTemplate: TEMPLATE, start: 0, count: 1 }).catch(() => undefined)
    await source.dispose()
  })

  test('disposing while the start is failing waits for it and does not throw', async () => {
    const { api } = scriptedTrezor({})
    const source = createTrezorSource({ api, contact: '' })
    const listing = source.listAddresses({ pathTemplate: TEMPLATE, start: 0, count: 1 }).catch((error: unknown) => error)
    await source.dispose()
    expect(((await listing) as HardwareWalletError).failure).toBe('unavailable')
  })

  test('tells the user to unlock the Trezor before it lists addresses', async () => {
    const { api } = scriptedTrezor({})
    const prompts: string[] = []
    const source = createTrezorSource({ api, contact: 'c', onDevicePrompt: (message) => prompts.push(message) })
    await source.listAddresses({ pathTemplate: TEMPLATE, start: 0, count: 1 })
    expect(prompts).toEqual(['Connect and unlock the Trezor. Enter the PIN on the device if it asks.'])
  })

  test('parseTrezorConnect accepts a library with init and refuses other shapes', () => {
    const library = { init: async () => {} }
    expect(parseTrezorConnect({ default: library })).toBe(library)
    for (const loaded of [{}, { default: null }, { default: 'text' }, { default: {} }, { default: { init: 1 } }]) {
      expect(() => parseTrezorConnect(loaded)).toThrow('Trezor Connect did not load')
    }
  })

  test('the real Trezor Connect library loads and has an init function', async () => {
    const api = await loadTrezorConnect()
    expect(typeof api.init).toBe('function')
    expect(typeof api.ethereumSignTransaction).toBe('function')
  })
})
