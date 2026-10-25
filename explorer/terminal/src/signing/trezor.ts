/**
 * Trezor through `@trezor/connect` in its Node build (the Trezor Bridge, or USB directly).
 *
 * The library loads on first use. It is injectable, so tests run this adapter against a simulated device.
 * The library asks for a contact address in its manifest. The dashboard takes it from the environment variable named
 * in {@link TREZOR_CONTACT_VARIABLE} and never stores one.
 */
import { getAddress, serializeTransaction, toHex, type Hex, type TransactionSerializableEIP1559 } from 'viem'
import { HardwareWalletError, hardwareError } from './hardware-error'
import { assertPathTemplate, expandPath } from './mnemonic'
import type { AddressSource, DerivedAddress, SignTransactionOptions, Signer } from './signer'

/** The environment variable that holds the contact address for the Trezor Connect manifest. */
export const TREZOR_CONTACT_VARIABLE = 'EXPLORER_TREZOR_CONTACT'

/** The answer shape of Trezor Connect calls. */
export type TrezorResponse<Payload> =
  | { readonly success: true; readonly payload: Payload }
  | { readonly success: false; readonly payload: { readonly error: string; readonly code?: string } }

/** The part of Trezor Connect that the dashboard uses. */
export interface TrezorApi {
  init(settings: {
    readonly manifest: { readonly appName: string; readonly appUrl: string; readonly email: string }
    readonly lazyLoad?: boolean
  }): Promise<void>
  ethereumGetAddress(parameters: {
    readonly path: string
    readonly showOnTrezor: boolean
  }): Promise<TrezorResponse<{ readonly address: string }>>
  ethereumSignTransaction(parameters: {
    readonly path: string
    readonly transaction: TrezorTransaction
  }): Promise<TrezorResponse<{ readonly v: string; readonly r: string; readonly s: string }>>
  dispose(): void | Promise<void>
}

/** The transaction fields that Trezor Connect takes for an EIP-1559 transaction. All numbers are hex strings. */
export interface TrezorTransaction {
  readonly to: string
  readonly value: string
  readonly gasLimit: string
  readonly nonce: string
  readonly data: string
  readonly chainId: number
  readonly maxFeePerGas: string
  readonly maxPriorityFeePerGas: string
  readonly accessList: readonly []
}

/** Input of {@link createTrezorSource}. */
export interface TrezorSourceInput {
  /** Replaces the Trezor Connect library. Tests pass a simulated device here. */
  readonly api?: TrezorApi
  /** The contact address for the manifest. Defaults to the environment variable. */
  readonly contact?: string
  /** Called with text the user must read on the device. */
  readonly onDevicePrompt?: (message: string) => void
}

/** Creates an address source and signer factory for a Trezor. */
export function createTrezorSource(input: TrezorSourceInput = {}): AddressSource {
  let ready: Promise<TrezorApi> | null = null

  function openApi(): Promise<TrezorApi> {
    ready ??= startApi(input).catch((error: unknown) => {
      ready = null
      throw error
    })
    return ready
  }

  async function addressOf(path: string, display: 'show' | 'hide'): Promise<DerivedAddress['address']> {
    const api = await openApi()
    const response = await api.ethereumGetAddress({ path, showOnTrezor: display === 'show' })
    if (!response.success) throw mapTrezorFailure(response.payload)
    return getAddress(response.payload.address)
  }

  return {
    kind: 'trezor',
    async listAddresses({ pathTemplate, start, count }) {
      assertPathTemplate(pathTemplate)
      input.onDevicePrompt?.('Connect and unlock the Trezor. Enter the PIN on the device if it asks.')
      const found: DerivedAddress[] = []
      for (let offset = 0; offset < count; offset += 1) {
        const index = start + offset
        const path = expandPath(pathTemplate, index)
        found.push({ index, path, address: await addressOf(path, 'hide') })
      }
      return found
    },
    async openSigner(path: string): Promise<Signer> {
      input.onDevicePrompt?.('Confirm the address on the Trezor screen.')
      const address = await addressOf(path, 'show')
      return {
        kind: 'trezor',
        address,
        derivationPath: path,
        description: `Trezor ${path}`,
        async signTransaction(transaction: TransactionSerializableEIP1559, options?: SignTransactionOptions) {
          const prompt = options?.onDevicePrompt ?? input.onDevicePrompt
          const api = await openApi()
          prompt?.(
            `Check the transaction on your Trezor (chain ${transaction.chainId}) and confirm it there. ` +
              'Reject it if anything differs from this screen.',
          )
          const response = await api.ethereumSignTransaction({ path, transaction: toTrezorTransaction(transaction) })
          if (!response.success) throw mapTrezorFailure(response.payload)
          return serializeTransaction(transaction, {
            r: normalizeWord(response.payload.r),
            s: normalizeWord(response.payload.s),
            yParity: yParityOf(response.payload.v),
          })
        },
        async dispose() {
          // The source owns the library and disposes it.
        },
      }
    },
    async dispose() {
      const api = await ready?.catch(() => null)
      ready = null
      await api?.dispose()
    },
  }
}

/** Converts an unsigned EIP-1559 transaction to the fields of Trezor Connect. */
export function toTrezorTransaction(transaction: TransactionSerializableEIP1559): TrezorTransaction {
  return {
    to: transaction.to ?? '0x',
    value: toHex(transaction.value ?? 0n),
    gasLimit: toHex(transaction.gas ?? 0n),
    nonce: toHex(transaction.nonce ?? 0),
    data: transaction.data ?? '0x',
    chainId: transaction.chainId,
    maxFeePerGas: toHex(transaction.maxFeePerGas ?? 0n),
    maxPriorityFeePerGas: toHex(transaction.maxPriorityFeePerGas ?? 0n),
    accessList: [],
  }
}

/**
 * Reads the recovery value of a Trezor answer as the parity of an EIP-1559 signature (0 or 1).
 * A device may answer with the parity, or with 27 or 28.
 */
export function yParityOf(v: string): 0 | 1 {
  const value = Number.parseInt(v.startsWith('0x') ? v.slice(2) : v, 16)
  const parity = value >= 27 ? value - 27 : value
  if (parity !== 0 && parity !== 1) throw hardwareError('other', `unexpected recovery value ${v}`)
  return parity
}

function normalizeWord(word: string): Hex {
  const digits = word.startsWith('0x') ? word.slice(2) : word
  return `0x${digits.padStart(64, '0')}`
}

function mapTrezorFailure(failure: { error: string; code?: string }): HardwareWalletError {
  const { error, code } = failure
  if (code === 'Failure_ActionCancelled' || /cancel|reject/i.test(error)) return hardwareError('rejected')
  if (code === 'Device_NotFound' || /device not found|no device/i.test(error)) return hardwareError('no-device')
  if (/pin|passphrase/i.test(error)) return hardwareError('locked', error)
  return hardwareError('other', error)
}

async function startApi(input: TrezorSourceInput): Promise<TrezorApi> {
  const contact = input.contact ?? process.env[TREZOR_CONTACT_VARIABLE]
  if (contact === undefined || contact === '') {
    throw hardwareError('unavailable', `set ${TREZOR_CONTACT_VARIABLE}: Trezor Connect requires a contact address`)
  }
  const api = input.api ?? (await loadTrezorConnect())
  await api.init({
    manifest: { appName: 'zk-bridge explorer terminal', appUrl: 'http://localhost', email: contact },
    lazyLoad: true,
  })
  return api
}

async function loadTrezorConnect(): Promise<TrezorApi> {
  const loaded = await import('@trezor/connect')
  const api: unknown = (loaded as { default?: unknown }).default
  if (typeof api !== 'object' || api === null || typeof (api as TrezorApi).init !== 'function') {
    throw hardwareError('unavailable', 'Trezor Connect did not load')
  }
  return api as TrezorApi
}
