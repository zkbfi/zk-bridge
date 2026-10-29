/**
 * Operator actions for the terminal: a thin adapter over the shared operator module.
 *
 * The shared module reads the prover files and checks them against the chain list. This file gives it the chains of the
 * pair, and turns each {@link OperatorCall} it returns into a {@link PlannedTransaction} for the confirmation screen.
 */
import {
  OperatorChainError,
  OperatorFileError,
  encodeUpdateCalldata,
  planMessageExecution as planSharedMessageExecution,
  planUpdateFromHandoff,
  planUpdateFromProofMessage,
  type EvidenceSummary,
  type OperatorCall,
  type OperatorChain,
  type ProofMessage,
} from '@zk-bridge/shared'
import type { ChainConfig, PairConfig } from '../model/types'
import type { PlannedTransaction } from './plan'

export { OperatorFileError, encodeUpdateCalldata, type EvidenceSummary }

/** A transaction in a sequence, with its place in the sequence. */
export interface SequenceStep {
  readonly plan: PlannedTransaction
  readonly role: 'prerequisite' | 'execute'
  /** The text of the reason that the prover gave, for a prerequisite. */
  readonly reason: string | null
}

/** The result of reading an evidence file. */
export interface ExecutionSequence {
  readonly summary: EvidenceSummary
  readonly steps: readonly SequenceStep[]
}

/** Reads a prover handoff and plans the light client update on a chain of the pair. */
export function planLightClientUpdate(text: string, pair: PairConfig): PlannedTransaction {
  return plannedTransactionOf(withPairName(pair, () => planUpdateFromHandoff(text, operatorChainsOf(pair))), pair)
}

/**
 * Plans the light client update that a proof message carries, on the chain that the direction of the message updates:
 * the second chain for `first-to-second`, the first chain for `second-to-first`.
 */
export function planProofMessageUpdate(message: ProofMessage, pair: PairConfig): PlannedTransaction {
  const chain = message.direction === 'first-to-second' ? pair.second : pair.first
  const operatorChain = operatorChainsOf(pair).find((candidate) => candidate.chainId === chain.chainId) as OperatorChain
  return plannedTransactionOf(planUpdateFromProofMessage(message, operatorChain), pair)
}

/** Reads evidence from `zk-bridge-prover evidence` and plans the transactions that deliver the message. */
export function planMessageExecution(text: string, pair: PairConfig): ExecutionSequence {
  const { summary, steps } = withPairName(pair, () => planSharedMessageExecution(text, operatorChainsOf(pair)))
  return {
    summary,
    steps: steps.map((step) => ({ role: step.role, reason: step.reason, plan: plannedTransactionOf(step.call, pair) })),
  }
}

/** Runs a plan, and names the pair in the error for a chain that the pair does not have. */
function withPairName<Result>(pair: PairConfig, plan: () => Result): Result {
  try {
    return plan()
  } catch (error) {
    if (!(error instanceof OperatorChainError)) throw error
    throw new OperatorFileError(`The file names chain ${error.chainId}, which is not a chain of the pair ${pair.id}.`)
  }
}

function operatorChainsOf(pair: PairConfig): readonly OperatorChain[] {
  return [pair.first, pair.second].map((chain) => ({
    chainId: chain.chainId,
    name: chain.name,
    lightClient: chain.contracts.lightClient,
    messageBridge: chain.contracts.messageBridge,
  }))
}

function plannedTransactionOf(call: OperatorCall, pair: PairConfig): PlannedTransaction {
  const chain = chainOfCall(call, pair)
  const contractName = call.to === chain.contracts.lightClient ? 'BeaconLightClient' : 'MessageBridge'
  return {
    title: call.title,
    chain,
    to: call.to,
    contractLabel: `${contractName} (${chain.name})`,
    functionSignature: call.functionSignature,
    functionName: call.functionName,
    data: call.data,
    value: 0n,
    arguments: call.arguments,
    notes: call.notes,
  }
}

/** The shared module only returns calls for chains that the adapter gave it, so the chain is always found. */
function chainOfCall(call: OperatorCall, pair: PairConfig): ChainConfig {
  return call.chainId === pair.first.chainId ? pair.first : pair.second
}
