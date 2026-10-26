/**
 * Ledger over USB HID, through the Ethereum app.
 *
 * The transport and the app library load on first use, so a user without a Ledger never loads the native HID module.
 * The transport is injectable, so tests run the real app library against a simulated device.
 *
 * Signing is blind signing as far as the device goes: the dashboard passes no clear-signing metadata, because that
 * metadata comes from a remote service and would send the transaction to it. The dashboard shows the whole
 * transaction on screen before the device is asked, and checks the returned signature against it.
 */
import { serializeTransaction, type Hex, type TransactionSerializableEIP1559 } from 'viem'
import { getAddress } from 'viem'
import { HardwareWalletError, hardwareError } from './hardware-error'
import { assertPathTemplate, expandPath } from './mnemonic'
import type { AddressSource, DerivedAddress, SignTransactionOptions, Signer } from './signer'

/** The part of the Ledger Ethereum app library that the dashboard uses. */
export interface LedgerEthereumApp {
  getAddress(path: string, display?: boolean): Promise<{ address: string }>
  signTransaction(path: string, rawTransactionHex: string, resolution: null): Promise<{ r: string; s: string; v: string }>
}

/** A transport to a device, and the application on top of it. */
export interface LedgerConnection {
  readonly app: LedgerEthereumApp
  close(): Promise<void>
}

/** Opens a connection to the first Ledger. The default uses USB HID. */
export type LedgerConnector = () => Promise<LedgerConnection>

/** Input of {@link createLedgerSource}. */
export interface LedgerSourceInput {
  /** Replaces the USB HID connection. Tests pass a simulated device here. */
  readonly connect?: LedgerConnector
  /** Replaces the load of the USB HID libraries, for the default connection. Tests pass fakes here. */
  readonly loadModules?: LedgerModuleLoader
  /** Called with text the user must read on the device. */
  readonly onDevicePrompt?: (message: string) => void
}

/** Status words of the Ledger Ethereum app that the dashboard names. */
const STATUS = {
  rejected: 0x6985,
  locked: 0x5515,
  invalidData: 0x6a80,
  appClosedClass: 0x6e00,
  appClosedInstruction: 0x6d00,
  appClosedOther: 0x6511,
} as const

/**
 * Creates an address source and signer factory for a Ledger.
 *
 * The connection opens on the first call. The same connection serves every address and signer of this source.
 */
export function createLedgerSource(input: LedgerSourceInput = {}): AddressSource {
  const connect = input.connect ?? (async () => openUsbConnection(await (input.loadModules ?? loadLedgerUsbModules)()))
  let connection: Promise<LedgerConnection> | null = null

  function openConnection(): Promise<LedgerConnection> {
    connection ??= connect().catch((error: unknown) => {
      connection = null
      throw mapLedgerError(error)
    })
    return connection
  }

  async function addressOf(path: string): Promise<DerivedAddress['address']> {
    const { app } = await openConnection()
    try {
      return getAddress((await app.getAddress(path, false)).address)
    } catch (error) {
      throw mapLedgerError(error)
    }
  }

  return {
    kind: 'ledger',
    async listAddresses({ pathTemplate, start, count }) {
      assertPathTemplate(pathTemplate)
      input.onDevicePrompt?.('Unlock the Ledger and open the Ethereum app.')
      const found: DerivedAddress[] = []
      for (let offset = 0; offset < count; offset += 1) {
        const index = start + offset
        const path = expandPath(pathTemplate, index)
        found.push({ index, path, address: await addressOf(path) })
      }
      return found
    },
    async openSigner(path: string): Promise<Signer> {
      const address = await addressOf(path)
      return createLedgerSigner({ address, path, connection: openConnection, onDevicePrompt: input.onDevicePrompt })
    },
    async dispose() {
      const open = await connection?.catch(() => null)
      connection = null
      await open?.close()
    },
  }
}

function createLedgerSigner(input: {
  address: DerivedAddress['address']
  path: string
  connection: () => Promise<LedgerConnection>
  onDevicePrompt: LedgerSourceInput['onDevicePrompt']
}): Signer {
  return {
    kind: 'ledger',
    address: input.address,
    derivationPath: input.path,
    description: `Ledger ${input.path}`,
    async signTransaction(transaction: TransactionSerializableEIP1559, options?: SignTransactionOptions) {
      const prompt = options?.onDevicePrompt ?? input.onDevicePrompt
      const { app } = await input.connection()
      const rawTransaction = serializeTransaction(transaction).slice(2)
      prompt?.(
        `Check the transaction on your Ledger (chain ${transaction.chainId}) and approve it there. ` +
          'Reject it if anything differs from this screen.',
      )
      try {
        const { r, s, v } = await app.signTransaction(input.path, rawTransaction, null)
        return serializeTransaction(transaction, {
          r: `0x${r}` as Hex,
          s: `0x${s}` as Hex,
          yParity: Number.parseInt(v, 16) % 2,
        })
      } catch (error) {
        throw mapLedgerError(error)
      }
    },
    async dispose() {
      // The source owns the connection and closes it.
    },
  }
}

/** Turns an error of the transport or the app library into a {@link HardwareWalletError}. */
export function mapLedgerError(error: unknown): HardwareWalletError {
  if (error instanceof HardwareWalletError) return error
  const statusCode = statusCodeOf(error)
  if (statusCode === STATUS.rejected) return hardwareError('rejected')
  if (statusCode === STATUS.locked) return hardwareError('locked')
  if (statusCode === STATUS.invalidData || nameOf(error) === 'EthAppPleaseEnableContractData') {
    return hardwareError('blind-signing-disabled')
  }
  if (isAppClosedStatus(statusCode)) return hardwareError('app-closed')
  const message = error instanceof Error ? error.message : String(error)
  if (/no device|NoDevice|cannot open device|could not open/i.test(message)) return hardwareError('no-device')
  return hardwareError('other', statusCode === undefined ? message : `status 0x${statusCode.toString(16)}`)
}

function nameOf(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined
}

function statusCodeOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return undefined
  const { statusCode } = error as { statusCode: unknown }
  return typeof statusCode === 'number' ? statusCode : undefined
}

function isAppClosedStatus(statusCode: number | undefined): boolean {
  return (
    statusCode === STATUS.appClosedClass ||
    statusCode === STATUS.appClosedInstruction ||
    statusCode === STATUS.appClosedOther
  )
}

/** The two libraries of the default connection, as the module loader returns them. */
export interface LedgerUsbModules {
  /** The USB HID transport class. */
  readonly hidTransport: unknown
  /** The Ledger Ethereum app class. */
  readonly ethereumApp: unknown
}

/** Loads the USB HID libraries. */
export type LedgerModuleLoader = () => Promise<LedgerUsbModules>

/** Loads the USB HID libraries on the first call, so a user without a Ledger never loads the native module. */
export async function loadLedgerUsbModules(): Promise<LedgerUsbModules> {
  const [hid, eth] = await Promise.all([import('@ledgerhq/hw-transport-node-hid'), import('@ledgerhq/hw-app-eth')])
  return { hidTransport: hid.default, ethereumApp: eth.default }
}

/** Opens the first Ledger over USB HID with the given libraries. */
export async function openUsbConnection(modules: LedgerUsbModules): Promise<LedgerConnection> {
  const transport = await unwrapDefault<{ create(): Promise<LedgerTransportHandle> }>(modules.hidTransport).create()
  const EthereumApp = unwrapDefault<new (transport: LedgerTransportHandle) => LedgerEthereumApp>(modules.ethereumApp)
  return { app: new EthereumApp(transport), close: () => transport.close() }
}

interface LedgerTransportHandle {
  close(): Promise<void>
}

/** A package that is CommonJS under an ES module loader can wrap its default export twice. This unwraps it. */
function unwrapDefault<Wanted>(value: unknown): Wanted {
  const wrapped = value as { default?: unknown }
  return (wrapped.default ?? value) as Wanted
}
