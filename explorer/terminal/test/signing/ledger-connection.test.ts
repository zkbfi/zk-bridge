import { describe, expect, test } from 'bun:test'
import Eth from '@ledgerhq/hw-app-eth'
import { HardwareWalletError, type HardwareFailure } from '../../src/signing/hardware-error'
import {
  createLedgerSource,
  loadLedgerUsbModules,
  mapLedgerError,
  openUsbConnection,
  type LedgerConnection,
} from '../../src/signing/ledger'
import { SimulatedLedgerTransport } from './simulated-ledger'

const TEMPLATE = "m/44'/60'/0'/0/{index}"

/** An error of the Ledger libraries: a name and a numeric status word. */
function statusError(statusCode: number, name = 'TransportStatusError'): Error {
  return Object.assign(new Error(`Ledger device: status ${statusCode}`), { name, statusCode })
}

describe('mapLedgerError', () => {
  test('keeps an error that already is a hardware wallet error, the same object', () => {
    const original = new HardwareWalletError('locked', 'already mapped')
    expect(mapLedgerError(original)).toBe(original)
  })

  test('names each status word of the Ethereum app', () => {
    const expected: ReadonlyArray<readonly [number, HardwareFailure]> = [
      [0x6985, 'rejected'],
      [0x5515, 'locked'],
      [0x6a80, 'blind-signing-disabled'],
      [0x6e00, 'app-closed'],
      [0x6d00, 'app-closed'],
      [0x6511, 'app-closed'],
    ]
    for (const [statusCode, failure] of expected) {
      expect(mapLedgerError(statusError(statusCode)).failure).toBe(failure)
    }
  })

  test('maps the named error of the app for contract data to blind signing disabled', () => {
    const error = Object.assign(new Error('Please enable contract data'), { name: 'EthAppPleaseEnableContractData' })
    expect(mapLedgerError(error).failure).toBe('blind-signing-disabled')
  })

  test('maps the messages of a missing device to no device', () => {
    for (const message of ['No device found', 'NoDevice', 'cannot open device with path', 'could not open the HID']) {
      expect(mapLedgerError(new Error(message)).failure).toBe('no-device')
    }
  })

  test('shows an unknown status word in hex, and an unknown message as it is', () => {
    expect(mapLedgerError(statusError(0x6001)).message).toBe('The device returned an error. (status 0x6001)')
    expect(mapLedgerError(new Error('boom')).message).toBe('The device returned an error. (boom)')
    expect(mapLedgerError('plain text').message).toBe('The device returned an error. (plain text)')
  })

  test('ignores a status code that is not a number', () => {
    const error = Object.assign(new Error('odd'), { statusCode: '0x6985' })
    expect(mapLedgerError(error).failure).toBe('other')
  })
})

describe('Ledger connection lifecycle', () => {
  test('forgets a failed connection, so the next call can connect again', async () => {
    const transport = new SimulatedLedgerTransport()
    let attempts = 0
    const source = createLedgerSource({
      connect: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('NoDevice')
        return { app: new Eth(transport), close: () => transport.close() }
      },
    })
    const first = await source.listAddresses({ pathTemplate: TEMPLATE, start: 0, count: 1 }).catch((error: unknown) => error)
    expect((first as HardwareWalletError).failure).toBe('no-device')
    const second = await source.listAddresses({ pathTemplate: TEMPLATE, start: 0, count: 1 })
    expect(second).toHaveLength(1)
    expect(attempts).toBe(2)
  })

  test('uses one connection for every address and signer', async () => {
    const transport = new SimulatedLedgerTransport()
    let connections = 0
    const source = createLedgerSource({
      connect: async () => {
        connections += 1
        return { app: new Eth(transport), close: () => transport.close() }
      },
    })
    await source.listAddresses({ pathTemplate: TEMPLATE, start: 0, count: 2 })
    await source.openSigner("m/44'/60'/0'/0/0")
    expect(connections).toBe(1)
  })

  test('tells the user to unlock the device and open the Ethereum app before it lists addresses', async () => {
    const transport = new SimulatedLedgerTransport()
    const prompts: string[] = []
    const source = createLedgerSource({
      connect: async () => ({ app: new Eth(transport), close: () => transport.close() }),
      onDevicePrompt: (message) => prompts.push(message),
    })
    await source.listAddresses({ pathTemplate: TEMPLATE, start: 0, count: 1 })
    expect(prompts).toEqual(['Unlock the Ledger and open the Ethereum app.'])
  })

  test('refuses a malformed path template before it opens the device', async () => {
    let connected = false
    const source = createLedgerSource({
      connect: async () => {
        connected = true
        throw new Error('must not connect')
      },
    })
    await expect(source.listAddresses({ pathTemplate: 'not a path', start: 0, count: 1 })).rejects.toThrow('A path looks like')
    expect(connected).toBe(false)
  })

  test('maps a locked device while it reads an address', async () => {
    const transport = new SimulatedLedgerTransport('locked')
    const source = createLedgerSource({ connect: async () => ({ app: new Eth(transport), close: () => transport.close() }) })
    const failed = await source.listAddresses({ pathTemplate: TEMPLATE, start: 0, count: 1 }).catch((error: unknown) => error)
    expect((failed as HardwareWalletError).failure).toBe('locked')
  })

  test('a signer does not close the connection that its source owns', async () => {
    const transport = new SimulatedLedgerTransport()
    const source = createLedgerSource({ connect: async () => ({ app: new Eth(transport), close: () => transport.close() }) })
    const signer = await source.openSigner("m/44'/60'/0'/0/0")
    await signer.dispose()
    expect(transport.closed).toBe(false)
    await source.dispose()
    expect(transport.closed).toBe(true)
  })

  test('disposing a source that never connected, or whose connection failed, does nothing and does not throw', async () => {
    await createLedgerSource({ connect: async () => { throw new Error('never') } }).dispose()
    const failing = createLedgerSource({ connect: async () => { throw new Error('NoDevice') } })
    await failing.listAddresses({ pathTemplate: TEMPLATE, start: 0, count: 1 }).catch(() => undefined)
    await failing.dispose()
  })

  test('disposing while a connection attempt is failing waits for it and does not throw', async () => {
    const source = createLedgerSource({
      connect: async () => {
        await Bun.sleep(5)
        throw new Error('NoDevice')
      },
    })
    const listing = source.listAddresses({ pathTemplate: TEMPLATE, start: 0, count: 1 }).catch((error: unknown) => error)
    await source.dispose()
    expect(((await listing) as HardwareWalletError).failure).toBe('no-device')
  })
})

describe('Ledger default connection over USB', () => {
  /** A fake pair of libraries. The transport records that it was created and closed. */
  function fakeModules(wrap: 'plain' | 'double') {
    const events: string[] = []
    const transport = { close: async () => void events.push('transport closed') }
    const hid = { create: async () => (events.push('transport created'), transport) }
    class FakeApp {
      constructor(readonly handle: unknown) {
        events.push(handle === transport ? 'app on the transport' : 'app on another object')
      }
      async getAddress() {
        return { address: '0x9858effd232b4033e47d90003d41ec34ecaeda94' }
      }
      async signTransaction(): Promise<never> {
        throw new Error('not used')
      }
    }
    const modules =
      wrap === 'plain'
        ? { hidTransport: hid, ethereumApp: FakeApp }
        : { hidTransport: { default: hid }, ethereumApp: { default: FakeApp } }
    return { modules, events }
  }

  test('creates the transport, builds the app on it, and closes the transport on dispose', async () => {
    const { modules, events } = fakeModules('plain')
    const connection: LedgerConnection = await openUsbConnection(modules)
    expect(events).toEqual(['transport created', 'app on the transport'])
    await connection.close()
    expect(events).toEqual(['transport created', 'app on the transport', 'transport closed'])
  })

  test('unwraps a library that a module loader wrapped in a second default', async () => {
    const { modules, events } = fakeModules('double')
    await openUsbConnection(modules)
    expect(events).toEqual(['transport created', 'app on the transport'])
  })

  test('a source without a connector loads the libraries and reads an address through them', async () => {
    const { modules, events } = fakeModules('plain')
    const source = createLedgerSource({ loadModules: async () => modules })
    const [entry] = await source.listAddresses({ pathTemplate: TEMPLATE, start: 0, count: 1 })
    expect(entry?.address).toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94')
    await source.dispose()
    expect(events).toEqual(['transport created', 'app on the transport', 'transport closed'])
  })

  test('the real libraries load, and have the shape that the connection needs', async () => {
    const { hidTransport, ethereumApp } = await loadLedgerUsbModules()
    expect(typeof (hidTransport as { create: unknown }).create).toBe('function')
    expect(typeof ethereumApp).toBe('function')
    expect((ethereumApp as { name: string }).name).toBe('Eth')
  })
})
