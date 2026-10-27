/**
 * Operator actions: post a light client update from a prover handoff, and execute a message from evidence.
 *
 * Both start from a JSON file that the prover writes. The files carry ready calldata, but the dashboard never trusts
 * them as written. It decodes the calldata, and it requires every address and number in the file to agree with the
 * calldata and with the pair configuration before it offers a transaction. A file that points at another contract is
 * refused, not corrected.
 */
import { decodeLightClientOutput, type LightClientOutput } from '@zk-bridge/shared'
import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  keccak256,
  type Address,
  type Hex,
} from 'viem'
import type { ChainConfig, PairConfig } from '../model/types'
import { beaconLightClientAbi, messageBridgeAbi } from './abis'
import { decodeKnownCall, selectorOf } from './decode'
import type { DisplayArgument, PlannedTransaction } from './plan'

/** A prover file is malformed, or it disagrees with its own calldata or with the pair configuration. */
export class OperatorFileError extends Error {
  override readonly name = 'OperatorFileError'
}

/** A transaction in a sequence, with its place in the sequence. */
export interface SequenceStep {
  readonly plan: PlannedTransaction
  readonly role: 'prerequisite' | 'execute'
  /** The text of the reason that the prover gave, for a prerequisite. */
  readonly reason: string | null
}

/** A summary of a message to execute, for the screen that shows the file before any transaction. */
export interface EvidenceSummary {
  readonly route: string
  readonly messageId: Hex
  readonly sender: Address
  readonly executor: Address
  readonly gasLimit: bigint
  readonly sourceTransactionHash: Hex
  readonly sourceSlot: bigint
  readonly anchorSlot: bigint
  readonly deliveryStatus: string
}

/** The result of reading an evidence file. */
export interface ExecutionSequence {
  readonly summary: EvidenceSummary
  readonly steps: readonly SequenceStep[]
}

const HANDOFF_SCHEMA_VERSION = 1
const EVIDENCE_SCHEMA_VERSION = 2

/**
 * Reads a prover handoff and plans the light client update.
 *
 * @param text The JSON text of the handoff (`zk-bridge-prover prove` output).
 * @param pair The pair configuration. The destination must be one of its chains, at its configured light client.
 * @throws OperatorFileError when the file is malformed or disagrees with its calldata or the configuration.
 */
export function planLightClientUpdate(text: string, pair: PairConfig): PlannedTransaction {
  const file = readObject(parseJson(text), 'handoff')
  requireNumber(file, 'schemaVersion', HANDOFF_SCHEMA_VERSION, 'handoff')
  const destination = readObject(file.destination, 'handoff.destination')
  const chain = chainOfPair(pair, readSafeInteger(destination, 'chainId', 'handoff.destination'))
  const lightClient = readAddressField(destination, 'lightClient', 'handoff.destination')
  requireSameAddress(lightClient, chain.contracts.lightClient, `the light client of ${chain.name}`)

  const startHeadSlot = readSlot(file, 'startHeadSlot', 'handoff')
  const newHeadSlot = readSlot(file, 'newHeadSlot', 'handoff')
  const proof = readHexField(file, 'proof', 'handoff')
  const publicValues = readHexField(file, 'publicValues', 'handoff')
  const updateCalldata = readHexField(file, 'updateCalldata', 'handoff')

  const call = decodeUpdateCalldata(updateCalldata)
  requireEqual(call.proof, proof, 'the proof in updateCalldata', 'the proof in the file')
  requireEqual(call.publicValues, publicValues, 'the public values in updateCalldata', 'the public values in the file')

  const output = readLightClientOutput(publicValues)
  requireEqual(output.previousHeadSlot, startHeadSlot, 'previousHeadSlot in the public values', 'startHeadSlot')
  requireEqual(output.newHeadSlot, newHeadSlot, 'newHeadSlot in the public values', 'newHeadSlot')
  requireEqual(
    output.previousHeaderRoot,
    readHexField(file, 'startHeadRoot', 'handoff'),
    'previousHeaderRoot in the public values',
    'startHeadRoot',
  )
  requireEqual(
    output.newHeaderRoot,
    readHexField(file, 'newHeadRoot', 'handoff'),
    'newHeaderRoot in the public values',
    'newHeadRoot',
  )

  return {
    title: `Post a light client update to ${chain.name}`,
    chain,
    to: chain.contracts.lightClient,
    contractLabel: `BeaconLightClient (${chain.name})`,
    functionSignature: 'update(bytes,bytes)',
    functionName: 'update',
    data: updateCalldata,
    value: 0n,
    arguments: [
      bytesArgumentOf('proof', proof),
      bytesArgumentOf('publicValues', publicValues),
      { name: 'publicValues.previousHeadSlot', type: 'uint64', value: output.previousHeadSlot.toString() },
      { name: 'publicValues.newHeadSlot', type: 'uint64', value: output.newHeadSlot.toString() },
      { name: 'publicValues.newHeaderRoot', type: 'bytes32', value: output.newHeaderRoot },
      { name: 'publicValues.executionBlockNumber', type: 'uint64', value: output.executionBlockNumber.toString() },
    ],
    notes: [
      `The light client moves from slot ${output.previousHeadSlot} to slot ${output.newHeadSlot}.`,
      'The contract refuses the update when its stored head is no longer the start head.',
    ],
  }
}

/**
 * Reads evidence from `zk-bridge-prover evidence` and plans the transactions that deliver the message.
 *
 * The prerequisites come first, in the order of the file, then the execution. The calls of one prerequisite
 * function are alternatives, so the caller must let the user skip a step. An already delivered message is refused.
 *
 * @throws OperatorFileError when the file is malformed, disagrees with its calldata, or names a delivered message.
 */
export function planMessageExecution(text: string, pair: PairConfig): ExecutionSequence {
  const file = readObject(parseJson(text), 'evidence')
  requireNumber(file, 'schemaVersion', EVIDENCE_SCHEMA_VERSION, 'evidence')
  const destination = readObject(file.destination, 'evidence.destination')
  const chain = chainOfPair(pair, readSafeInteger(destination, 'chainId', 'evidence.destination'))
  const bridge = readAddressField(destination, 'bridge', 'evidence.destination')
  requireSameAddress(bridge, chain.contracts.messageBridge, `the message bridge of ${chain.name}`)
  requireSameAddress(
    readAddressField(destination, 'lightClient', 'evidence.destination'),
    chain.contracts.lightClient,
    `the light client of ${chain.name}`,
  )

  const deliveryStatus = readString(file, 'deliveryStatus', 'evidence')
  if (file.alreadyDelivered !== false || deliveryStatus !== 'notDelivered') {
    throw new OperatorFileError(`The message is already delivered (status ${deliveryStatus}). It can run only once.`)
  }

  const message = readObject(file.message, 'evidence.message')
  const logIndex = readSafeInteger(file, 'logIndex', 'evidence')
  const execute = readObject(file.execute, 'evidence.execute')
  const executeData = readHexField(execute, 'data', 'evidence.execute')
  requireSameAddress(readAddressField(execute, 'to', 'evidence.execute'), bridge, 'the target of execute')

  const executeCall = decodeExecuteMessage(executeData)
  requireEqual(BigInt(logIndex), executeCall.logIndex, 'logIndex in the executeMessage proof', 'logIndex in the file')

  const anchor = readObject(file.anchor, 'evidence.anchor')
  const summary: EvidenceSummary = {
    route: readString(file, 'route', 'evidence'),
    messageId: readHexField(message, 'messageId', 'evidence.message'),
    sender: readAddressField(message, 'sender', 'evidence.message'),
    executor: readAddressField(message, 'executor', 'evidence.message'),
    gasLimit: BigInt(readSafeInteger(message, 'gasLimit', 'evidence.message')),
    sourceTransactionHash: readHexField(file, 'sourceTransactionHash', 'evidence'),
    sourceSlot: readSlot(message, 'sourceSlot', 'evidence.message'),
    anchorSlot: readSlot(anchor, 'slot', 'evidence.anchor'),
    deliveryStatus,
  }

  const prerequisites = readArray(file.prerequisites, 'evidence.prerequisites').map((entry, index) =>
    prerequisiteStep(readObject(entry, `evidence.prerequisites[${index}]`), { chain, bridge, index }),
  )
  const executeStep: SequenceStep = {
    role: 'execute',
    reason: null,
    plan: {
      title: `Execute message ${summary.messageId.slice(0, 12)}… on ${chain.name}`,
      chain,
      to: bridge,
      contractLabel: `MessageBridge (${chain.name})`,
      functionSignature: executeCall.signature,
      functionName: 'executeMessage',
      data: executeData,
      value: 0n,
      arguments: [
        { name: 'message.messageId', type: 'bytes32', value: summary.messageId },
        { name: 'message.sender', type: 'address', value: summary.sender },
        { name: 'message.executor', type: 'address', value: summary.executor },
        { name: 'message.gasLimit', type: 'uint256', value: summary.gasLimit.toString() },
        { name: 'sourceTransactionHash', type: 'bytes32', value: summary.sourceTransactionHash },
        ...executeCall.arguments,
      ],
      notes: [
        'The bridge checks the evidence itself. No proof is needed. The message runs once, even if the call reverts.',
        `The target ${summary.executor} receives the call with ${summary.gasLimit} gas.`,
      ],
    },
  }
  return { summary, steps: [...prerequisites, executeStep] }
}

function prerequisiteStep(
  entry: Record<string, unknown>,
  context: { chain: ChainConfig; bridge: Address; index: number },
): SequenceStep {
  const where = `evidence.prerequisites[${context.index}]`
  requireSameAddress(readAddressField(entry, 'to', where), context.bridge, `the target of prerequisite ${context.index}`)
  const data = readHexField(entry, 'data', where)
  const decoded = decodeKnownCall(data, [messageBridgeAbi])
  if (decoded === null) {
    throw new OperatorFileError(`Prerequisite ${context.index} is not a known message bridge call (selector ${selectorOf(data)}).`)
  }
  const named = readString(entry, 'function', where)
  requireEqual(decoded.functionName, named, 'the function in the calldata', 'the function named in the file')
  return {
    role: 'prerequisite',
    reason: readString(entry, 'reason', where),
    plan: {
      title: `Add a layout row: ${decoded.functionName}`,
      chain: context.chain,
      to: context.bridge,
      contractLabel: `MessageBridge (${context.chain.name})`,
      functionSignature: decoded.functionSignature,
      functionName: decoded.functionName,
      data,
      value: 0n,
      arguments: decoded.arguments,
      notes: ['The bridge needs a validated layout row before it can check the evidence. The chain validates the row.'],
    },
  }
}

function decodeUpdateCalldata(data: Hex): { proof: Hex; publicValues: Hex } {
  try {
    const decoded = decodeFunctionData({ abi: beaconLightClientAbi, data })
    if (decoded.functionName !== 'update') throw new Error('not update')
    const [proof, publicValues] = decoded.args as readonly [Hex, Hex]
    return { proof, publicValues }
  } catch {
    throw new OperatorFileError('updateCalldata is not a call to update(bytes,bytes).')
  }
}

/** Reads the public values with the shared decoder, and reports a bad file as an {@link OperatorFileError}. */
function readLightClientOutput(publicValues: Hex): LightClientOutput {
  try {
    return decodeLightClientOutput(publicValues)
  } catch (error) {
    throw new OperatorFileError(`The public values are not a light client output: ${(error as Error).message}.`)
  }
}

function decodeExecuteMessage(data: Hex) {
  const decoded = decodeKnownCall(data, [messageBridgeAbi])
  if (decoded === null || decoded.functionName !== 'executeMessage') {
    throw new OperatorFileError('execute.data is not a call to executeMessage.')
  }
  const proof = decodeFunctionData({ abi: messageBridgeAbi, data }).args?.[0] as { logIndex: bigint }
  return { signature: decoded.functionSignature, arguments: decoded.arguments, logIndex: proof.logIndex }
}

function bytesArgumentOf(name: string, value: Hex): DisplayArgument {
  const length = (value.length - 2) / 2
  const shown = value.length <= 66 ? value : `${value.slice(0, 34)}… keccak256 ${keccak256(value)}`
  return { name, type: 'bytes', value: shown, meaning: `${length} bytes` }
}

function chainOfPair(pair: PairConfig, chainId: number): ChainConfig {
  const chain = [pair.first, pair.second].find((candidate) => candidate.chainId === chainId)
  if (chain === undefined) {
    throw new OperatorFileError(`The file names chain ${chainId}, which is not a chain of the pair ${pair.id}.`)
  }
  return chain
}

function requireSameAddress(found: Address, expected: Address, what: string): void {
  if (found.toLowerCase() === expected.toLowerCase()) return
  throw new OperatorFileError(`The file names ${abbreviate(found)} for ${what}; the deployment says ${abbreviate(expected)}.`)
}

function requireEqual<Value extends bigint | string>(left: Value, right: Value, leftName: string, rightName: string): void {
  if (left === right) return
  throw new OperatorFileError(`${leftName} (${abbreviate(left)}) differs from ${rightName} (${abbreviate(right)}).`)
}

/** Cuts long values, such as proofs, so an error message stays one readable line. */
function abbreviate(value: bigint | string): string {
  const text = value.toString()
  return text.length <= 24 ? text : `${text.slice(0, 12)}…${text.slice(-8)}`
}

function requireNumber(source: Record<string, unknown>, key: string, expected: number, where: string): void {
  if (source[key] === expected) return
  throw new OperatorFileError(`${where}.${key} must be ${expected}, found ${JSON.stringify(source[key])}.`)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new OperatorFileError('The file is not valid JSON.')
  }
}

function readObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
  throw new OperatorFileError(`${where} must be an object.`)
}

function readArray(value: unknown, where: string): unknown[] {
  if (Array.isArray(value)) return value
  throw new OperatorFileError(`${where} must be an array.`)
}

function readString(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key]
  if (typeof value === 'string') return value
  throw new OperatorFileError(`${where}.${key} must be a string.`)
}

function readSafeInteger(source: Record<string, unknown>, key: string, where: string): number {
  const value = source[key]
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  throw new OperatorFileError(`${where}.${key} must be a non-negative integer.`)
}

function readSlot(source: Record<string, unknown>, key: string, where: string): bigint {
  return BigInt(readSafeInteger(source, key, where))
}

function readHexField(source: Record<string, unknown>, key: string, where: string): Hex {
  const value = readString(source, key, where)
  if (/^0x([0-9a-fA-F]{2})*$/.test(value)) return value.toLowerCase() as Hex
  throw new OperatorFileError(`${where}.${key} must be 0x hex with whole bytes.`)
}

function readAddressField(source: Record<string, unknown>, key: string, where: string): Address {
  const value = readString(source, key, where)
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) return getAddress(value)
  throw new OperatorFileError(`${where}.${key} must be an address.`)
}

/** Builds the calldata of `update(proof, publicValues)`. Tests and fixtures use it to write handoff files. */
export function encodeUpdateCalldata(proof: Hex, publicValues: Hex): Hex {
  return encodeFunctionData({ abi: beaconLightClientAbi, functionName: 'update', args: [proof, publicValues] })
}
