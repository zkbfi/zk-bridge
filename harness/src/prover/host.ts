import type { Hex, PublicClient } from 'viem'
import { DEPOSIT_INITIATED_TOPIC } from '../constants.js'
import { encodeHeader, hashHeader, type RpcBlockHeader } from '../header.js'
import { encodeReceipt, fromRpcReceipt, type RpcReceipt } from '../receipts.js'
import type { DepositWitness } from './witness.js'

/** Options for `fetchWitness`. */
export interface FetchWitnessOptions {
  /**
   * Index of the log inside the receipt.
   * Defaults to the first log whose topic 0 is `DepositInitiated`.
   */
  readonly logIndex?: number
}

type RequestClient = Pick<PublicClient, 'request'>

const requestBlock = async (client: RequestClient, blockNumber: Hex): Promise<RpcBlockHeader> => {
  const block = (await client.request({
    method: 'eth_getBlockByNumber',
    params: [blockNumber, false],
  } as never)) as RpcBlockHeader | null
  if (!block) throw new Error(`Block ${blockNumber} does not exist`)
  return block
}

const requestReceipts = async (client: RequestClient, blockNumber: Hex): Promise<readonly RpcReceipt[]> => {
  const receipts = (await client.request({
    method: 'eth_getBlockReceipts',
    params: [blockNumber],
  } as never)) as readonly RpcReceipt[] | null
  if (!receipts) throw new Error(`Receipts of block ${blockNumber} do not exist`)
  return receipts
}

/**
 * The host half of the reference prover. It reads chain data over RPC.
 * Anvil has no `debug_getRawHeader`, so the host rebuilds the header RLP and checks it
 * against the block hash. It also rebuilds each receipt encoding from `eth_getBlockReceipts`.
 * @throws When the rebuilt header does not hash to the block hash, or the transaction has no deposit log.
 */
export const fetchWitness = async (
  client: RequestClient,
  transactionHash: Hex,
  options: FetchWitnessOptions = {},
): Promise<DepositWitness> => {
  const transaction = (await client.request({
    method: 'eth_getTransactionByHash',
    params: [transactionHash],
  } as never)) as { blockNumber: Hex | null; transactionIndex: Hex | null } | null
  if (!transaction?.blockNumber || transaction.transactionIndex === null) {
    throw new Error(`Transaction ${transactionHash} is not mined`)
  }
  const [block, rpcReceipts] = await Promise.all([
    requestBlock(client, transaction.blockNumber),
    requestReceipts(client, transaction.blockNumber),
  ])
  const headerRlp = encodeHeader(block)
  if (hashHeader(headerRlp) !== block.hash) {
    throw new Error(`Rebuilt header hashes to ${hashHeader(headerRlp)} but the block hash is ${block.hash}`)
  }
  const txIndex = Number(BigInt(transaction.transactionIndex))
  const ownReceipt = rpcReceipts[txIndex]
  if (!ownReceipt) throw new Error(`Block has no receipt at index ${txIndex}`)
  const logIndex =
    options.logIndex ?? ownReceipt.logs.findIndex((log) => log.topics[0] === DEPOSIT_INITIATED_TOPIC)
  if (logIndex < 0 || !ownReceipt.logs[logIndex]) throw new Error(`Transaction ${transactionHash} has no deposit log`)
  return {
    headerRlp,
    receipts: rpcReceipts.map((receipt) => encodeReceipt(fromRpcReceipt(receipt))),
    txIndex,
    logIndex,
  }
}
