import { decodeFunctionData, type Abi, type Account, type Address, type Hex, type TransactionReceipt } from 'viem'
import { artifacts } from './artifacts.js'
import { walletFor, type ChainHandle } from './chains.js'
import { attest, type Committee } from './committee.js'
import { ZERO_HASH } from './constants.js'

/** The five arguments of `LightClientSync.updateSyncState`. */
export interface UpdateArguments {
  readonly period: number
  readonly attestedHeader: Hex
  readonly signatures: readonly Hex[]
  readonly merkleProofs: readonly (readonly Hex[])[]
  readonly nextCommitteeRoot: Hex
}

/** Options for `buildUpdate`. */
export interface BuildUpdateOptions {
  /** The committee that the destination light client currently trusts. */
  readonly committee: Committee
  /** Hash of the source chain block to attest. */
  readonly blockHash: Hex
  readonly period: number
  /** Defaults to zero, which keeps the current committee. */
  readonly nextCommitteeRoot?: Hex
  readonly signerCount?: number
}

/** Fee settings for a competing transaction. */
export interface FeeOptions {
  readonly maxFeePerGas: bigint
  readonly maxPriorityFeePerGas: bigint
}

/** Options for `submitUpdate`. */
export interface SubmitUpdateOptions {
  readonly destination: ChainHandle
  readonly lightClient: Address
  readonly account: Account
  readonly update: UpdateArguments
  readonly fees?: FeeOptions
  readonly gas?: bigint
}

/** Result of `relayBlock`. */
export interface RelayResult {
  readonly hash: Hex
  readonly receipt: TransactionReceipt
  readonly gasUsed: bigint
}

const lightClientAbi = (): Abi => artifacts.lightClient().abi

/** Collects the committee signatures for a block and the proofs that go with them. */
export const buildUpdate = async (options: BuildUpdateOptions): Promise<UpdateArguments> => {
  const { committee, blockHash, period, nextCommitteeRoot = ZERO_HASH, signerCount } = options
  const { signatures, merkleProofs } = await attest({ committee, attestedHeader: blockHash, period, signerCount })
  return { period, attestedHeader: blockHash, signatures, merkleProofs, nextCommitteeRoot }
}

/**
 * Sends `updateSyncState` and returns the transaction hash without waiting.
 * Use this when automine is off.
 */
export const submitUpdate = async (options: SubmitUpdateOptions): Promise<Hex> => {
  const { destination, lightClient, account, update, fees, gas } = options
  return walletFor(destination, account).writeContract({
    address: lightClient,
    abi: lightClientAbi(),
    functionName: 'updateSyncState',
    args: [update.period, update.attestedHeader, update.signatures, update.merkleProofs, update.nextCommitteeRoot],
    ...fees,
    ...(gas === undefined ? {} : { gas }),
  })
}

/**
 * Builds, sends, and waits for an update. This is the honest relayer's whole job.
 * @throws When the transaction reverts.
 */
export const relayBlock = async (
  options: BuildUpdateOptions & Omit<SubmitUpdateOptions, 'update'>,
): Promise<RelayResult> => {
  const update = await buildUpdate(options)
  const hash = await submitUpdate({ ...options, update })
  const receipt = await options.destination.publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`Light client update ${hash} reverted`)
  return { hash, receipt, gasUsed: receipt.gasUsed }
}

/**
 * Decodes the arguments of an `updateSyncState` call from its calldata.
 * An attacker uses this to copy an honest update out of the mempool.
 * @throws When the calldata calls another function.
 */
export const decodeUpdateCalldata = (input: Hex): UpdateArguments => {
  const decoded = decodeFunctionData({ abi: lightClientAbi(), data: input })
  if (decoded.functionName !== 'updateSyncState' || !decoded.args) throw new Error('Not an updateSyncState call')
  const [period, attestedHeader, signatures, merkleProofs, nextCommitteeRoot] = decoded.args as [
    number,
    Hex,
    readonly Hex[],
    readonly (readonly Hex[])[],
    Hex,
  ]
  return { period, attestedHeader, signatures, merkleProofs, nextCommitteeRoot }
}
