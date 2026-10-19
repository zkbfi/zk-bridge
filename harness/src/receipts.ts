import { createMPT } from '@ethereumjs/mpt'
import { RLP } from '@ethereumjs/rlp'
import { bytesToHex, hexToBytes, type Address, type Hex } from 'viem'

/** A log as it appears inside a receipt. */
export interface ReceiptLog {
  readonly address: Address
  readonly topics: readonly Hex[]
  readonly data: Hex
}

/** The fields of a receipt that the consensus encoding covers. */
export interface ConsensusReceipt {
  /** Transaction type: 0 for legacy, 1 and 2 and others for typed transactions. */
  readonly type: number
  readonly status: boolean
  readonly cumulativeGasUsed: bigint
  readonly logsBloom: Hex
  readonly logs: readonly ReceiptLog[]
}

/** The receipt fields as `eth_getBlockReceipts` returns them. */
export interface RpcReceipt {
  readonly type: Hex
  readonly status: Hex
  readonly cumulativeGasUsed: Hex
  readonly logsBloom: Hex
  readonly logs: readonly { readonly address: Address; readonly topics: readonly Hex[]; readonly data: Hex }[]
}

/** Converts an RPC receipt into the consensus fields. */
export const fromRpcReceipt = (receipt: RpcReceipt): ConsensusReceipt => ({
  type: Number(BigInt(receipt.type)),
  status: BigInt(receipt.status) === 1n,
  cumulativeGasUsed: BigInt(receipt.cumulativeGasUsed),
  logsBloom: receipt.logsBloom,
  logs: receipt.logs.map(({ address, topics, data }) => ({ address, topics, data })),
})

/** Big-endian bytes of an integer with no leading zeros. Zero becomes an empty array. */
export const integerToMinimalBytes = (value: bigint): Uint8Array => {
  if (value === 0n) return new Uint8Array()
  const digits = value.toString(16)
  return hexToBytes(`0x${digits.length % 2 === 0 ? digits : `0${digits}`}`)
}

/** Reads a big-endian integer. An empty array is zero. */
export const minimalBytesToInteger = (bytes: Uint8Array): bigint => (bytes.length === 0 ? 0n : BigInt(bytesToHex(bytes)))

/**
 * Encodes a receipt as the consensus rules do.
 * A legacy receipt is the plain RLP list. A typed receipt is the type byte followed by that list.
 */
export const encodeReceipt = (receipt: ConsensusReceipt): Hex => {
  const body = RLP.encode([
    receipt.status ? Uint8Array.of(1) : new Uint8Array(),
    integerToMinimalBytes(receipt.cumulativeGasUsed),
    hexToBytes(receipt.logsBloom),
    receipt.logs.map((log) => [hexToBytes(log.address), log.topics.map((topic) => hexToBytes(topic)), hexToBytes(log.data)]),
  ])
  if (receipt.type === 0) return bytesToHex(body)
  return bytesToHex(Uint8Array.from([receipt.type, ...body]))
}

/** Decodes a consensus-encoded receipt. */
export const decodeReceipt = (encoded: Hex): ConsensusReceipt => {
  const bytes = hexToBytes(encoded)
  const first = bytes[0]
  if (first === undefined) throw new Error('Receipt is empty')
  // A legacy receipt starts with an RLP list prefix, which is 0xc0 or more.
  const type = first >= 0xc0 ? 0 : first
  const decoded = RLP.decode(first >= 0xc0 ? bytes : bytes.slice(1))
  if (!Array.isArray(decoded) || decoded.length !== 4) throw new Error('Receipt is not a four-item list')
  const [status, cumulativeGasUsed, logsBloom, logs] = decoded as [Uint8Array, Uint8Array, Uint8Array, Uint8Array[][]]
  return {
    type,
    status: status.length === 1 && status[0] === 1,
    cumulativeGasUsed: minimalBytesToInteger(cumulativeGasUsed),
    logsBloom: bytesToHex(logsBloom),
    logs: logs.map(([address, topics, data]) => ({
      address: bytesToHex(address as Uint8Array) as Address,
      topics: (topics as unknown as Uint8Array[]).map((topic) => bytesToHex(topic)),
      data: bytesToHex(data as Uint8Array),
    })),
  }
}

/**
 * Rebuilds the receipts trie and returns its root.
 * Keys are the RLP encoding of the transaction index. Values are the consensus-encoded receipts.
 * @param encodedReceipts - Consensus-encoded receipts, in block order.
 */
export const computeReceiptsRoot = async (encodedReceipts: readonly Hex[]): Promise<Hex> => {
  const trie = await createMPT()
  for (const [index, encoded] of encodedReceipts.entries()) {
    await trie.put(RLP.encode(index), hexToBytes(encoded))
  }
  return bytesToHex(trie.root())
}
