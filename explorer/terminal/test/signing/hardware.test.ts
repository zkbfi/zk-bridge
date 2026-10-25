import { describe, expect, test } from 'bun:test'
import Eth from '@ledgerhq/hw-app-eth'
import { getAddress, keccak256, parseTransaction, serializeTransaction, type TransactionSerializableEIP1559 } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { HardwareWalletError, type HardwareFailure } from '../../src/signing/hardware-error'
import { createLedgerSource } from '../../src/signing/ledger'
import { assertSignedTransactionMatches, SignatureMismatchError } from '../../src/signing/signer'
import { createTrezorSource, toTrezorTransaction, yParityOf, type TrezorApi } from '../../src/signing/trezor'
import { SimulatedLedgerTransport, type SimulatedLedgerBehavior } from './simulated-ledger'

// Every hardware test here runs against a simulation of the device. No real Ledger or Trezor was available, so the
// real devices, their firmware and their screens were NOT tested.

const TRANSACTION: TransactionSerializableEIP1559 = {
  type: 'eip1559',
  chainId: 369,
  nonce: 4,
  to: '0x1111111111111111111111111111111111111111',
  value: 0n,
  data: `0x${'ab'.repeat(300)}`,
  gas: 300_000n,
  maxFeePerGas: 2_000_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
}

// The first three addresses of the public "abandon ... about" mnemonic, as derived by Foundry `cast wallet`.
const ABANDON_ADDRESSES = [
  '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
  '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0',
  '0xb6716976A3ebe8D39aCEB04372f22Ff8e6802D7A',
] as const

function ledgerOver(behavior: SimulatedLedgerBehavior = 'approve') {
  const transport = new SimulatedLedgerTransport(behavior)
  const prompts: string[] = []
  const source = createLedgerSource({
    connect: async () => ({ app: new Eth(transport), close: () => transport.close() }),
    onDevicePrompt: (message) => prompts.push(message),
  })
  return { transport, source, prompts }
}

describe('Ledger over a simulated device', () => {
  test('lists the addresses of a path template with the Ethereum app protocol', async () => {
    const { source } = ledgerOver()
    const listed = await source.listAddresses({ pathTemplate: "m/44'/60'/0'/0/{index}", start: 0, count: 3 })
    expect(listed.map((entry) => entry.address)).toEqual([...ABANDON_ADDRESSES])
  })

  test("signs a transaction that needs several chunks, and the signature is the account's", async () => {
    const { source, transport } = ledgerOver()
    const signer = await source.openSigner("m/44'/60'/0'/0/1")
    expect(signer.address).toBe(ABANDON_ADDRESSES[1])
    const signed = await signer.signTransaction(TRANSACTION)
    await assertSignedTransactionMatches({
      signed,
      unsigned: TRANSACTION,
      expectedSigner: getAddress(ABANDON_ADDRESSES[1]),
    })
    // 300 bytes of calldata cannot fit one APDU: the host must have sent at least two sign chunks.
    const signChunks = transport.received.filter((apdu) => apdu[1] === 0x04)
    expect(signChunks.length).toBeGreaterThan(1)
    // What the device signed is exactly the transaction that the screen showed.
    expect(keccak256(`0x${transport.signedPayloads[0]!.toString('hex')}`)).toBe(keccak256(serializeTransaction(TRANSACTION)))
    expect(parseTransaction(signed).data).toBe(TRANSACTION.data)
  })

  test('shows the device prompt, with the chain, before it asks the device', async () => {
    const { source } = ledgerOver()
    const signer = await source.openSigner("m/44'/60'/0'/0/0")
    const seen: string[] = []
    await signer.signTransaction(TRANSACTION, { onDevicePrompt: (message) => seen.push(message) })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('chain 369')
  })

  const refusals: ReadonlyArray<readonly [SimulatedLedgerBehavior, HardwareFailure]> = [
    ['reject', 'rejected'],
    ['locked', 'locked'],
    ['app-closed', 'app-closed'],
    ['blind-signing-disabled', 'blind-signing-disabled'],
  ]
  for (const [behavior, failure] of refusals) {
    test(`maps the device answer "${behavior}" to the failure "${failure}"`, async () => {
      const { source, transport } = ledgerOver('approve')
      const signer = await source.openSigner("m/44'/60'/0'/0/0")
      // Change the behavior after the address was read, so only the signing step fails.
      transport.behavior = behavior
      const failed = await signer.signTransaction(TRANSACTION).catch((error: unknown) => error)
      expect(failed).toBeInstanceOf(HardwareWalletError)
      expect((failed as HardwareWalletError).failure).toBe(failure)
    })
  }

  test('a device that signs different content is caught by the host check', async () => {
    const { source, transport } = ledgerOver('approve')
    const signer = await source.openSigner("m/44'/60'/0'/0/0")
    transport.behavior = 'sign-different-transaction'
    const signed = await signer.signTransaction(TRANSACTION)
    await expect(
      assertSignedTransactionMatches({ signed, unsigned: TRANSACTION, expectedSigner: getAddress(ABANDON_ADDRESSES[0]) }),
    ).rejects.toBeInstanceOf(SignatureMismatchError)
  })

  test('closes the transport when the source is disposed', async () => {
    const { source, transport } = ledgerOver()
    await source.listAddresses({ pathTemplate: "m/44'/60'/0'/0/{index}", start: 0, count: 1 })
    await source.dispose()
    expect(transport.closed).toBe(true)
  })

  test('reports a missing device with the steps to fix it', async () => {
    const source = createLedgerSource({
      connect: async () => {
        throw new Error('NoDevice: cannot open device')
      },
    })
    const failed = await source
      .listAddresses({ pathTemplate: "m/44'/60'/0'/0/{index}", start: 0, count: 1 })
      .catch((error: unknown) => error)
    expect((failed as HardwareWalletError).failure).toBe('no-device')
    expect((failed as HardwareWalletError).message).toContain('Connect it by USB')
  })
})

describe('Trezor over a simulated Connect library', () => {
  // The first public Anvil development key. It is a published test value.
  const testKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
  const account = privateKeyToAccount(testKey)

  function fakeTrezor(options: { rejectSigning?: 'yes' | 'no'; v?: 'parity' | 'legacy' } = {}) {
    const calls: Array<{ method: string; parameters: unknown }> = []
    const api: TrezorApi = {
      async init() {},
      async ethereumGetAddress(parameters) {
        calls.push({ method: 'ethereumGetAddress', parameters })
        return { success: true, payload: { address: account.address.toLowerCase() } }
      },
      async ethereumSignTransaction(parameters) {
        calls.push({ method: 'ethereumSignTransaction', parameters })
        if (options.rejectSigning === 'yes') {
          return { success: false, payload: { error: 'Action cancelled by user', code: 'Failure_ActionCancelled' } }
        }
        const given = parameters.transaction
        const transaction: TransactionSerializableEIP1559 = {
          type: 'eip1559',
          chainId: given.chainId,
          nonce: Number(given.nonce),
          to: given.to as `0x${string}`,
          value: BigInt(given.value),
          data: given.data as `0x${string}`,
          gas: BigInt(given.gasLimit),
          maxFeePerGas: BigInt(given.maxFeePerGas),
          maxPriorityFeePerGas: BigInt(given.maxPriorityFeePerGas),
        }
        const parsed = parseTransaction(await account.signTransaction(transaction))
        const parity = parsed.yParity ?? 0
        const v = options.v === 'legacy' ? 27 + parity : parity
        return { success: true, payload: { v: `0x${v.toString(16)}`, r: parsed.r!, s: parsed.s! } }
      },
      async dispose() {},
    }
    return { api, calls }
  }

  test('lists addresses, signs, and the result recovers to the account', async () => {
    const { api, calls } = fakeTrezor()
    const source = createTrezorSource({ api, contact: 'contact-for-test' })
    const [entry] = await source.listAddresses({ pathTemplate: "m/44'/60'/0'/0/{index}", start: 0, count: 1 })
    expect(entry?.address).toBe(account.address)
    const signer = await source.openSigner("m/44'/60'/0'/0/0")
    const signed = await signer.signTransaction(TRANSACTION)
    await assertSignedTransactionMatches({ signed, unsigned: TRANSACTION, expectedSigner: account.address })
    // The address is shown on the device when a signer opens, and not when the list is read.
    const addressCalls = calls.filter((call) => call.method === 'ethereumGetAddress')
    expect((addressCalls[0]?.parameters as { showOnTrezor: boolean }).showOnTrezor).toBe(false)
    expect((addressCalls[1]?.parameters as { showOnTrezor: boolean }).showOnTrezor).toBe(true)
  })

  test('accepts a recovery value of 27 or 28 as well as 0 or 1', async () => {
    const { api } = fakeTrezor({ v: 'legacy' })
    const signer = await createTrezorSource({ api, contact: 'contact-for-test' }).openSigner("m/44'/60'/0'/0/0")
    const signed = await signer.signTransaction(TRANSACTION)
    await assertSignedTransactionMatches({ signed, unsigned: TRANSACTION, expectedSigner: account.address })
    expect(yParityOf('0x1c')).toBe(1)
    expect(() => yParityOf('0x05')).toThrow(HardwareWalletError)
  })

  test('maps a cancel on the device to the rejected failure', async () => {
    const { api } = fakeTrezor({ rejectSigning: 'yes' })
    const signer = await createTrezorSource({ api, contact: 'contact-for-test' }).openSigner("m/44'/60'/0'/0/0")
    const failed = await signer.signTransaction(TRANSACTION).catch((error: unknown) => error)
    expect((failed as HardwareWalletError).failure).toBe('rejected')
  })

  test('refuses to start without a contact for the manifest, and names the variable to set', async () => {
    const { api } = fakeTrezor()
    const previous = process.env.EXPLORER_TREZOR_CONTACT
    delete process.env.EXPLORER_TREZOR_CONTACT
    try {
      const failed = await createTrezorSource({ api })
        .listAddresses({ pathTemplate: "m/44'/60'/0'/0/{index}", start: 0, count: 1 })
        .catch((error: unknown) => error)
      expect((failed as HardwareWalletError).failure).toBe('unavailable')
      expect((failed as HardwareWalletError).message).toContain('EXPLORER_TREZOR_CONTACT')
    } finally {
      if (previous !== undefined) process.env.EXPLORER_TREZOR_CONTACT = previous
    }
  })

  test('converts the transaction to the hex fields that Trezor Connect expects', () => {
    expect(toTrezorTransaction({ ...TRANSACTION, value: 0n, nonce: 0 })).toMatchObject({
      value: '0x0',
      nonce: '0x0',
      chainId: 369,
      gasLimit: '0x493e0',
      maxPriorityFeePerGas: '0x3b9aca00',
    })
  })
})
