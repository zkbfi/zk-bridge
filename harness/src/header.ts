import { RLP } from '@ethereumjs/rlp'
import { bytesToHex, hexToBytes, keccak256, type Hex } from 'viem'
import { integerToMinimalBytes } from './receipts.js'

/** A block as `eth_getBlockByNumber` returns it, limited to the header fields. */
export interface RpcBlockHeader {
  readonly hash: Hex
  readonly parentHash: Hex
  readonly sha3Uncles: Hex
  readonly miner: Hex
  readonly stateRoot: Hex
  readonly transactionsRoot: Hex
  readonly receiptsRoot: Hex
  readonly logsBloom: Hex
  readonly difficulty: Hex
  readonly number: Hex
  readonly gasLimit: Hex
  readonly gasUsed: Hex
  readonly timestamp: Hex
  readonly extraData: Hex
  readonly mixHash: Hex
  readonly nonce: Hex
  readonly baseFeePerGas?: Hex
  readonly withdrawalsRoot?: Hex
  readonly blobGasUsed?: Hex
  readonly excessBlobGas?: Hex
  readonly parentBeaconBlockRoot?: Hex
  readonly requestsHash?: Hex
}

/** Index of `receiptsRoot` in the header list. */
export const RECEIPTS_ROOT_FIELD_INDEX = 5

const quantity = (value: Hex): Uint8Array => integerToMinimalBytes(BigInt(value))

/**
 * Encodes an execution header as RLP, in the field order of the Prague fork.
 * Fields after `nonce` appear only when the block carries them, in fork order.
 * The caller must check that the keccak256 of the result equals the block hash.
 */
export const encodeHeader = (block: RpcBlockHeader): Hex => {
  const optionalFields: readonly (Uint8Array | undefined)[] = [
    block.baseFeePerGas === undefined ? undefined : quantity(block.baseFeePerGas),
    block.withdrawalsRoot === undefined ? undefined : hexToBytes(block.withdrawalsRoot),
    block.blobGasUsed === undefined ? undefined : quantity(block.blobGasUsed),
    block.excessBlobGas === undefined ? undefined : quantity(block.excessBlobGas),
    block.parentBeaconBlockRoot === undefined ? undefined : hexToBytes(block.parentBeaconBlockRoot),
    block.requestsHash === undefined ? undefined : hexToBytes(block.requestsHash),
  ]
  const fields: Uint8Array[] = [
    hexToBytes(block.parentHash),
    hexToBytes(block.sha3Uncles),
    hexToBytes(block.miner),
    hexToBytes(block.stateRoot),
    hexToBytes(block.transactionsRoot),
    hexToBytes(block.receiptsRoot),
    hexToBytes(block.logsBloom),
    quantity(block.difficulty),
    quantity(block.number),
    quantity(block.gasLimit),
    quantity(block.gasUsed),
    quantity(block.timestamp),
    hexToBytes(block.extraData),
    hexToBytes(block.mixHash),
    hexToBytes(block.nonce),
    ...optionalFields.filter((field): field is Uint8Array => field !== undefined),
  ]
  return bytesToHex(RLP.encode(fields))
}

/** The block hash that a header RLP commits to. */
export const hashHeader = (headerRlp: Hex): Hex => keccak256(headerRlp)

/**
 * Reads field 5 of a decoded header.
 * @throws When the header is not an RLP list of at least six byte strings.
 */
export const readReceiptsRoot = (headerRlp: Hex): Hex => {
  const decoded = RLP.decode(hexToBytes(headerRlp))
  if (!Array.isArray(decoded)) throw new Error('Header is not an RLP list')
  const field = decoded[RECEIPTS_ROOT_FIELD_INDEX]
  if (!(field instanceof Uint8Array) || field.length !== 32) throw new Error('Header field 5 is not a 32-byte receipts root')
  return bytesToHex(field)
}
