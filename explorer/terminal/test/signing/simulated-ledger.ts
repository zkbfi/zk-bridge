/**
 * A simulated Ledger for tests. It answers the APDUs of the Ledger Ethereum app: get address (INS 0x02) and sign
 * transaction (INS 0x04). The real `@ledgerhq/hw-app-eth` library runs on top of it, so the tests exercise the
 * serialization, the chunking and the parsing of the answers. Keys come from the public "abandon ... about" mnemonic.
 *
 * This is NOT a real device. It checks nothing about the real firmware, the screens or the buttons.
 */
import Transport from '@ledgerhq/hw-transport'
import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync } from '@scure/bip39'
import { bytesToHex, keccak256, type Hex } from 'viem'
import { privateKeyToAccount, sign } from 'viem/accounts'

const PUBLIC_TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

/** How the simulated device behaves. */
export type SimulatedLedgerBehavior =
  | 'approve'
  | 'reject'
  | 'locked'
  | 'app-closed'
  | 'blind-signing-disabled'
  /** Signs a different transaction than the one it received. A correct host must notice. */
  | 'sign-different-transaction'

const STATUS_OK = 0x9000

/** The simulated transport. */
export class SimulatedLedgerTransport extends Transport {
  readonly received: Buffer[] = []
  readonly signedPayloads: Buffer[] = []
  behavior: SimulatedLedgerBehavior
  private readonly root = HDKey.fromMasterSeed(mnemonicToSeedSync(PUBLIC_TEST_MNEMONIC, ''))
  private pending: { path: string; rlp: Buffer } | null = null
  closed = false

  constructor(behavior: SimulatedLedgerBehavior = 'approve') {
    super()
    this.behavior = behavior
  }

  override async exchange(apdu: Buffer): Promise<Buffer> {
    this.received.push(apdu)
    const [cla, instruction, p1] = [apdu[0], apdu[1], apdu[2]]
    const data = apdu.subarray(5, 5 + (apdu[4] ?? 0))
    const refusal = this.refusal()
    if (cla !== 0xe0) return statusWord(0x6e00)
    if (refusal !== null && instruction !== 0x06) return statusWord(refusal)
    if (instruction === 0x02) return this.answerAddress(data)
    if (instruction === 0x04) return this.answerSign(data, p1 ?? 0)
    return statusWord(0x6d00)
  }

  override async close(): Promise<void> {
    this.closed = true
  }

  /** The address of a path, for the test to compare with what the host reports. */
  addressOf(path: string) {
    return privateKeyToAccount(this.keyAt(path)).address
  }

  private refusal(): number | null {
    if (this.behavior === 'locked') return 0x5515
    if (this.behavior === 'app-closed') return 0x6e00
    return null
  }

  private keyAt(path: string): Hex {
    return bytesToHex(this.root.derive(path).privateKey!)
  }

  private answerAddress(data: Buffer): Buffer {
    const path = readPath(data).path
    const key = this.keyAt(path)
    const publicKey = Buffer.from(privateKeyToAccount(key).publicKey.slice(2), 'hex')
    const address = privateKeyToAccount(key).address.slice(2).toLowerCase()
    return Buffer.concat([
      Buffer.from([publicKey.length]),
      publicKey,
      Buffer.from([address.length]),
      Buffer.from(address, 'ascii'),
      statusWord(STATUS_OK),
    ])
  }

  private async answerSign(data: Buffer, p1: number): Promise<Buffer> {
    if (p1 === 0x00) {
      const { path, length } = readPath(data)
      this.pending = { path, rlp: Buffer.from(data.subarray(length)) }
    } else if (this.pending !== null) {
      this.pending = { ...this.pending, rlp: Buffer.concat([this.pending.rlp, data]) }
    }
    const pending = this.pending
    if (pending === null) return statusWord(0x6a80)
    if (!isCompleteTypedTransaction(pending.rlp)) return statusWord(STATUS_OK)
    this.pending = null
    this.signedPayloads.push(pending.rlp)
    if (this.behavior === 'reject') return statusWord(0x6985)
    if (this.behavior === 'blind-signing-disabled') return statusWord(0x6a80)
    const payload = this.behavior === 'sign-different-transaction' ? flipLastByte(pending.rlp) : pending.rlp
    const signature = await sign({ hash: keccak256(bytesToHex(payload)), privateKey: this.keyAt(pending.path), to: 'object' })
    return Buffer.concat([
      Buffer.from([signature.yParity ?? 0]),
      Buffer.from(signature.r.slice(2).padStart(64, '0'), 'hex'),
      Buffer.from(signature.s.slice(2).padStart(64, '0'), 'hex'),
      statusWord(STATUS_OK),
    ])
  }
}

function statusWord(code: number): Buffer {
  const word = Buffer.alloc(2)
  word.writeUInt16BE(code)
  return word
}

function readPath(data: Buffer): { path: string; length: number } {
  const count = data[0] ?? 0
  const elements = Array.from({ length: count }, (_, index) => data.readUInt32BE(1 + 4 * index))
  const text = elements.map((element) => (element >= 0x80000000 ? `${element - 0x80000000}'` : String(element)))
  return { path: `m/${text.join('/')}`, length: 1 + 4 * count }
}

/** A typed transaction is `type || rlp(list)`. The device knows it is complete when the list length is reached. */
function isCompleteTypedTransaction(bytes: Buffer): boolean {
  const header = bytes[1]
  if (header === undefined) return false
  if (header >= 0xf8) {
    const lengthOfLength = header - 0xf7
    if (bytes.length < 2 + lengthOfLength) return false
    const listLength = Number.parseInt(bytes.subarray(2, 2 + lengthOfLength).toString('hex'), 16)
    return bytes.length >= 2 + lengthOfLength + listLength
  }
  return bytes.length >= 2 + (header - 0xc0)
}

function flipLastByte(bytes: Buffer): Buffer {
  const copy = Buffer.from(bytes)
  copy[copy.length - 1] = (copy[copy.length - 1] ?? 0) ^ 0xff
  return copy
}
