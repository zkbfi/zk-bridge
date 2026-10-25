/**
 * The confirm-before-send flow, as a small state machine with no dependency on the terminal library.
 *
 * The rule: a transaction reaches the signer and the network only through {@link TransactionFlow.confirm}, and
 * `confirm` works only in the `review` phase, which the flow enters after it shows the full transaction. Nothing else
 * in the program holds a path to `sendRawTransaction`.
 */
import { assertSignedTransactionMatches, type Signer } from '../signing/signer'
import {
  prepareTransaction,
  sendSignedTransaction,
  type PrepareClient,
  type PreparedTransaction,
  type SendClient,
} from '../tx/prepare'
import type { PlannedTransaction } from '../tx/plan'

/** One transaction of a sequence. */
export interface FlowStep {
  readonly plan: PlannedTransaction
  /** True when the user may skip this step, for example a layout row that the chain may already hold. */
  readonly skippable: boolean
}

/** What happened to a step. */
export interface StepOutcome {
  readonly title: string
  readonly status: 'success' | 'reverted' | 'skipped'
  readonly transactionHash: string | null
}

/** The phases of the flow. */
export type FlowPhase = 'idle' | 'preparing' | 'review' | 'signing' | 'sending' | 'error' | 'finished' | 'cancelled'

/** The whole state of the flow. Every field is read-only; the flow replaces the object on each change. */
export interface FlowState {
  readonly phase: FlowPhase
  readonly steps: readonly FlowStep[]
  readonly stepIndex: number
  /** The transaction under review, signing or sending. Null outside those phases. */
  readonly prepared: PreparedTransaction | null
  /** Text that the user must read on the hardware device. */
  readonly devicePrompt: string | null
  readonly outcomes: readonly StepOutcome[]
  readonly error: string | null
}

/** The chain access of the flow. */
export interface FlowChainClient extends PrepareClient, SendClient {}

/** Dependencies of {@link createTransactionFlow}. */
export interface TransactionFlowDependencies {
  readonly signer: Signer
  /** Returns the chain client for a chain identifier. It throws for a chain the dashboard has no RPC URL for. */
  readonly clientFor: (chainId: number) => FlowChainClient
}

/** A flow over a sequence of transactions. */
export interface TransactionFlow {
  getState(): FlowState
  subscribe(listener: () => void): () => void
  /** Starts a sequence. It prepares the first step and stops at the review. */
  start(steps: readonly FlowStep[]): void
  /** Approves the transaction under review. Only this call signs and sends. */
  confirm(): void
  /** Skips the current step when it allows that. */
  skip(): void
  /** Prepares the current step again after an error. */
  retry(): void
  /** Abandons the sequence. Steps already mined stay mined. */
  cancel(): void
}

const IDLE_STATE: FlowState = {
  phase: 'idle',
  steps: [],
  stepIndex: 0,
  prepared: null,
  devicePrompt: null,
  outcomes: [],
  error: null,
}

/** Creates a flow for one signer. */
export function createTransactionFlow(dependencies: TransactionFlowDependencies): TransactionFlow {
  let state: FlowState = IDLE_STATE
  const listeners = new Set<() => void>()
  // A cancel or a new start makes the result of an older preparation stale. The counter lets that result be dropped.
  let generation = 0

  function update(changes: Partial<FlowState>): void {
    state = { ...state, ...changes }
    listeners.forEach((listener) => listener())
  }

  async function prepareCurrent(): Promise<void> {
    const step = state.steps[state.stepIndex]
    if (step === undefined) return update({ phase: 'finished', prepared: null, devicePrompt: null })
    update({ phase: 'preparing', prepared: null, error: null, devicePrompt: null })
    const mine = generation
    try {
      const client = dependencies.clientFor(step.plan.chain.chainId)
      const prepared = await prepareTransaction(client, dependencies.signer.address, step.plan)
      if (mine !== generation) return
      update({ phase: 'review', prepared })
    } catch (error) {
      if (mine !== generation) return
      update({ phase: 'error', error: `Could not prepare the transaction: ${messageOf(error)}` })
    }
  }

  async function signAndSend(prepared: PreparedTransaction): Promise<void> {
    try {
      const signed = await dependencies.signer.signTransaction(prepared.unsigned, {
        onDevicePrompt: (message) => update({ devicePrompt: message }),
      })
      await assertSignedTransactionMatches({ signed, unsigned: prepared.unsigned, expectedSigner: dependencies.signer.address })
      update({ phase: 'sending', devicePrompt: null })
      const outcome = await sendSignedTransaction(dependencies.clientFor(prepared.plan.chain.chainId), signed)
      const record: StepOutcome = {
        title: prepared.plan.title,
        status: outcome.status === 'success' ? 'success' : 'reverted',
        transactionHash: outcome.hash,
      }
      if (outcome.status === 'reverted') {
        return update({ phase: 'error', outcomes: [...state.outcomes, record], error: `The transaction ${outcome.hash} reverted.` })
      }
      update({ outcomes: [...state.outcomes, record], stepIndex: state.stepIndex + 1 })
      await prepareCurrent()
    } catch (error) {
      update({ phase: 'error', devicePrompt: null, error: `Not sent: ${messageOf(error)}` })
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start(steps) {
      if (state.phase !== 'idle' && state.phase !== 'finished' && state.phase !== 'cancelled') return
      generation += 1
      state = { ...IDLE_STATE, steps, phase: 'preparing' }
      listeners.forEach((listener) => listener())
      void prepareCurrent()
    },
    confirm() {
      const { prepared } = state
      if (state.phase !== 'review' || prepared === null) return
      update({ phase: 'signing', devicePrompt: null })
      void signAndSend(prepared)
    },
    skip() {
      const step = state.steps[state.stepIndex]
      if ((state.phase !== 'review' && state.phase !== 'error') || step === undefined || !step.skippable) return
      const record: StepOutcome = { title: step.plan.title, status: 'skipped', transactionHash: null }
      update({ outcomes: [...state.outcomes, record], stepIndex: state.stepIndex + 1, prepared: null })
      void prepareCurrent()
    },
    retry() {
      if (state.phase !== 'error') return
      void prepareCurrent()
    },
    cancel() {
      if (state.phase !== 'review' && state.phase !== 'error' && state.phase !== 'preparing') return
      generation += 1
      update({ phase: 'cancelled', prepared: null, devicePrompt: null })
    },
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
