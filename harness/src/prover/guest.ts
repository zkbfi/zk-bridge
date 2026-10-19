import {
  decodeAbiParameters,
  encodeAbiParameters,
  getAddress,
  isAddressEqual,
  keccak256,
  encodePacked,
  type Address,
  type Hex,
} from 'viem'
import { sign } from 'viem/accounts'
import { anvilAccount, anvilPrivateKey, PROVER_ORACLE_ACCOUNT_INDEX } from '../accounts.js'
import { DEPOSIT_INITIATED_TOPIC, PROGRAM_VKEY } from '../constants.js'
import { hashHeader, readReceiptsRoot } from '../header.js'
import { computeReceiptsRoot, decodeReceipt } from '../receipts.js'
import type { DepositWitness } from './witness.js'

/** The seven values that the vault reads from `publicInputsBytes`. */
export interface BridgeInputs {
  readonly sourceChainId: bigint
  readonly targetChainId: bigint
  readonly tokenAddress: Address
  readonly recipient: Address
  readonly amount: bigint
  readonly depositNonce: Hex
  readonly confirmedBlockRoot: Hex
}

/** What the guest outputs. */
export interface DepositProof {
  /** The 65-byte signature that `MockSP1Verifier` accepts. */
  readonly proof: Hex
  /** `abi.encode(BridgeInputs)`. */
  readonly publicInputsBytes: Hex
  readonly inputs: BridgeInputs
}

/** Options for `proveDeposit`. */
export interface ProveOptions {
  /**
   * When set, the guest rejects a log that another contract emitted.
   * The specification gives the circuit no way to do this, so the default is no pin.
   * Tests use the option only as a control.
   */
  readonly pinnedEmitter?: Address
}

const bridgeInputsParameters = [
  {
    type: 'tuple',
    components: [
      { name: 'sourceChainId', type: 'uint64' },
      { name: 'targetChainId', type: 'uint64' },
      { name: 'tokenAddress', type: 'address' },
      { name: 'recipient', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'depositNonce', type: 'bytes32' },
      { name: 'confirmedBlockRoot', type: 'bytes32' },
    ],
  },
] as const

/** Encodes `BridgeInputs` the way `abi.encode(BridgeInputs)` does. */
export const encodeBridgeInputs = (inputs: BridgeInputs): Hex =>
  encodeAbiParameters(bridgeInputsParameters, [inputs])

const topicToAddress = (topic: Hex | undefined): Address => {
  if (!topic || topic.length !== 66) throw new Error('Deposit log is missing an indexed topic')
  return getAddress(`0x${topic.slice(26)}`)
}

/** Address of the prover oracle. The deployment gives it to `MockSP1Verifier`. */
export const proverOracleAddress: Address = anvilAccount(PROVER_ORACLE_ACCOUNT_INDEX).address

const signAsOracle = (digest: Hex): Promise<Hex> =>
  sign({ hash: digest, privateKey: anvilPrivateKey(PROVER_ORACLE_ACCOUNT_INDEX), to: 'hex' })

/**
 * The guest half of the reference prover. It models the circuit that the specification describes,
 * as generously as possible, and it uses no RPC.
 *
 * Steps:
 * 1. `confirmedBlockRoot` is the keccak256 of the header RLP.
 * 2. Field 5 of the header is the receipts root.
 * 3. The guest rebuilds the receipts trie and requires the same root.
 * 4. The guest reads the log at `logIndex` and matches it by topic 0 only.
 * 5. The guest signs the statement with the oracle key.
 *
 * Only this function may use the oracle key.
 * @throws When the header, the trie, or the log does not hold up.
 */
export const proveDeposit = async (
  witness: DepositWitness,
  sourceChainId: number | bigint,
  options: ProveOptions = {},
): Promise<DepositProof> => {
  const confirmedBlockRoot = hashHeader(witness.headerRlp)
  const headerReceiptsRoot = readReceiptsRoot(witness.headerRlp)
  const rebuiltRoot = await computeReceiptsRoot(witness.receipts)
  if (rebuiltRoot !== headerReceiptsRoot) {
    throw new Error(`Receipts trie root ${rebuiltRoot} does not match header receipts root ${headerReceiptsRoot}`)
  }
  const encodedReceipt = witness.receipts[witness.txIndex]
  if (!encodedReceipt) throw new Error(`No receipt at transaction index ${witness.txIndex}`)
  const receipt = decodeReceipt(encodedReceipt)
  if (!receipt.status) throw new Error('The transaction failed, so it has no deposit')
  const log = receipt.logs[witness.logIndex]
  if (!log) throw new Error(`No log at index ${witness.logIndex}`)
  if (log.topics[0] !== DEPOSIT_INITIATED_TOPIC) throw new Error('Log is not a DepositInitiated event')
  if (options.pinnedEmitter && !isAddressEqual(log.address, options.pinnedEmitter)) {
    throw new Error(`Log came from ${log.address}, not from the pinned emitter ${options.pinnedEmitter}`)
  }
  const [amount, depositNonce, targetChainId] = decodeAbiParameters(
    [
      { name: 'amount', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'targetChainId', type: 'uint64' },
    ],
    log.data,
  )
  const inputs: BridgeInputs = {
    sourceChainId: BigInt(sourceChainId),
    targetChainId,
    tokenAddress: topicToAddress(log.topics[1]),
    recipient: topicToAddress(log.topics[3]),
    amount,
    depositNonce,
    confirmedBlockRoot,
  }
  const publicInputsBytes = encodeBridgeInputs(inputs)
  const digest = keccak256(encodePacked(['bytes32', 'bytes32'], [PROGRAM_VKEY, keccak256(publicInputsBytes)]))
  return { proof: await signAsOracle(digest), publicInputsBytes, inputs }
}

/** Lets tests build a decoded view of any `publicInputsBytes`. */
export const decodeBridgeInputs = (publicInputsBytes: Hex): BridgeInputs => {
  const [decoded] = decodeAbiParameters(bridgeInputsParameters, publicInputsBytes)
  return decoded
}
