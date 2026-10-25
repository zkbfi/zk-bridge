/**
 * Turns a planned transaction into an unsigned transaction with a nonce, a gas estimate and fees, and sends a signed
 * one. The chain access goes through small interfaces, so tests pass a fake and the later web interface passes its own.
 */
import type { Address, Hash, Hex, TransactionReceipt, TransactionSerializableEIP1559 } from 'viem'
import type { PlannedTransaction } from './plan'

/** The part of a viem public client that preparation needs. */
export interface PrepareClient {
  estimateGas(parameters: { account: Address; to: Address; data: Hex; value: bigint }): Promise<bigint>
  getTransactionCount(parameters: { address: Address; blockTag: 'pending' }): Promise<number>
  estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>
}

/** The part of a viem public client that sending needs. */
export interface SendClient {
  sendRawTransaction(parameters: { serializedTransaction: Hex }): Promise<Hash>
  waitForTransactionReceipt(parameters: { hash: Hash }): Promise<TransactionReceipt>
}

/** A planned transaction with everything the signer needs, and everything the confirmation screen shows. */
export interface PreparedTransaction {
  readonly plan: PlannedTransaction
  readonly from: Address
  readonly unsigned: TransactionSerializableEIP1559
  /** The node's estimate of the gas used. */
  readonly gasEstimate: bigint
  /** The estimate plus a margin: the gas limit in the transaction. */
  readonly gasLimit: bigint
  /** The most the network fee can be: `gasLimit * maxFeePerGas`, in wei. */
  readonly maximumNetworkFee: bigint
}

/** The share of the estimate that is added as a margin, in percent. */
const GAS_MARGIN_PERCENT = 20n

/**
 * Estimates gas, reads the nonce and fees, and builds the unsigned transaction.
 *
 * The estimate runs against the chain, so a call that would revert fails here, before anything is signed.
 *
 * @param client The chain access of the plan's chain.
 * @param from The address that will sign.
 * @param plan The plan to prepare.
 * @throws Error with the node's reason when the estimate fails.
 */
export async function prepareTransaction(
  client: PrepareClient,
  from: Address,
  plan: PlannedTransaction,
): Promise<PreparedTransaction> {
  const [gasEstimate, nonce, fees] = await Promise.all([
    client.estimateGas({ account: from, to: plan.to, data: plan.data, value: plan.value }),
    client.getTransactionCount({ address: from, blockTag: 'pending' }),
    client.estimateFeesPerGas(),
  ])
  const gasLimit = gasEstimate + (gasEstimate * GAS_MARGIN_PERCENT) / 100n
  const unsigned: TransactionSerializableEIP1559 = {
    type: 'eip1559',
    chainId: plan.chain.chainId,
    nonce,
    to: plan.to,
    data: plan.data,
    value: plan.value,
    gas: gasLimit,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  }
  return {
    plan,
    from,
    unsigned,
    gasEstimate,
    gasLimit,
    maximumNetworkFee: gasLimit * fees.maxFeePerGas,
  }
}

/** The outcome of a mined transaction. */
export interface SendOutcome {
  readonly hash: Hash
  readonly status: 'success' | 'reverted'
  readonly gasUsed: bigint
  readonly blockNumber: bigint
}

/** Sends a signed transaction and waits for its receipt. */
export async function sendSignedTransaction(client: SendClient, serializedTransaction: Hex): Promise<SendOutcome> {
  const hash = await client.sendRawTransaction({ serializedTransaction })
  const receipt = await client.waitForTransactionReceipt({ hash })
  return { hash, status: receipt.status, gasUsed: receipt.gasUsed, blockNumber: receipt.blockNumber }
}
