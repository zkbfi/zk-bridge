/**
 * Operator actions for the terminal: a thin adapter over the shared operator module.
 *
 * The shared module reads the prover files and checks them against the chain list. This file gives it the chains of the
 * pair, and turns each {@link OperatorCall} it returns into a {@link PlannedTransaction} for the confirmation screen.
 */
import {
  OperatorFileError,
  encodeUpdateCalldata,
  planMessageExecution as planSharedMessageExecution,
  planUpdateFromHandoff,
  type EvidenceSummary,
  type OperatorCall,
  type OperatorChain,
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
  return plannedTransactionOf(planUpdateFromHandoff(text, operatorChainsOf(pair)), pair)
}

/** Reads evidence from `zk-bridge-prover evidence` and plans the transactions that deliver the message. */
export function planMessageExecution(text: string, pair: PairConfig): ExecutionSequence {
  const { summary, steps } = planSharedMessageExecution(text, operatorChainsOf(pair))
  return {
    summary,
    steps: steps.map((step) => ({ role: step.role, reason: step.reason, plan: plannedTransactionOf(step.call, pair) })),
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
