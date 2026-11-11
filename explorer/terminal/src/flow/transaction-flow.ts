/**
 * The confirm-before-send flow, as a small state machine with no dependency on the terminal library.
 *
 * The rule: a transaction reaches the signer and the network only through {@link TransactionFlow.confirm}, and
 * `confirm` works only in the `review` phase, which the flow enters after it shows the full transaction. Nothing else
 * in the program holds a path to `sendRawTransaction`.
 *
 * The deposit gate: right before the estimate of a send on a chain with a gate, the flow asks the gate check (no cache:
 * an epoch lasts 6.4 minutes on Ethereum and Sepolia, and someone else may confirm meanwhile). When the epoch needs a
 * confirmation, the flow inserts the step `confirm(evidence)` before the send, with the gas of its simulation plus the
 * usual margin, and the review shows it like any other step. A send through the delivery router carries its own gate
 * evidence instead: the flow puts the evidence that the check returns (or none) into the send, so it stays one
 * transaction. When the beacon header of the epoch is not on chain yet, or too little of the epoch is left, it waits and
 * asks again. When the send's estimate still reverts with `ForkNotConfirmed` or `HeaderNotInCurrentEpoch` (the epoch
 * rolled over), it asks once more. The rules are those of the web page: `decideGateStep` of `../tx/gate-step`.
 */
import type { Address } from 'viem'
import { isGateEpochPassed, revertText, type GateCheck, type GateCheckAnswer } from '@zk-bridge/shared'
import { assertSignedTransactionMatches, type Signer } from '../signing/signer'
import { carriesGateEvidence, decideGateStep, gateErrorText, passesGate, withGateEvidence, withKnownGas, type GateConfirmMark, type GateDecision, type GateWait } from '../tx/gate-step'
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
  /** Set on the step that the flow inserted to confirm an epoch on the deposit gate. */
  readonly gateConfirm?: GateConfirmMark
}

/** What happened to a step. */
export interface StepOutcome {
  readonly title: string
  readonly status: 'success' | 'reverted' | 'skipped'
  readonly transactionHash: string | null
  /** Set for the confirmation of an epoch on the gate. */
  readonly gateConfirm?: true
}

/** The phases of the flow. `waiting`: the gate check waits (for the beacon header of the epoch, or for the next epoch), then asks again. */
export type FlowPhase = 'idle' | 'preparing' | 'waiting' | 'review' | 'signing' | 'sending' | 'error' | 'finished' | 'cancelled'

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
  /** Set in the `waiting` phase. */
  readonly gateWait: GateWait | null
}

/** The chain access of the flow. */
export interface FlowChainClient extends PrepareClient, SendClient {}

/** Dependencies of {@link createTransactionFlow}. */
export interface TransactionFlowDependencies {
  readonly signer: Signer
  /** Returns the chain client for a chain identifier. It throws for a chain the dashboard has no RPC URL for. */
  readonly clientFor: (chainId: number) => FlowChainClient
  /** The deposit gate check. Absent: no check (fixture data, which reaches no chain). */
  readonly checkGate?: GateCheck
  /** Waits before the gate is asked again. Default: a timer. */
  readonly sleep?: (milliseconds: number) => Promise<void>
  /** The clock in milliseconds, which the time left in the epoch is read from. Default: `Date.now`. */
  readonly now?: () => number
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
  gateWait: null,
}

/** What the terminal tells when no beacon endpoint answered the gate check. */
const BEACON_HINT = 'Press r to try again.'

/** How far a preparation went: whether the gate was asked again after a `ForkNotConfirmed`, and how many waits in a row. */
interface Attempt {
  readonly redone: boolean
  readonly waits: number
}

const FIRST_ATTEMPT: Attempt = { redone: false, waits: 0 }

/** Creates a flow for one signer. */
export function createTransactionFlow(dependencies: TransactionFlowDependencies): TransactionFlow {
  let state: FlowState = IDLE_STATE
  const listeners = new Set<() => void>()
  // A cancel or a new start makes the result of an older preparation stale. The counter lets that result be dropped.
  let generation = 0
  const now = dependencies.now ?? Date.now
  const sleep = dependencies.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))

  function update(changes: Partial<FlowState>): void {
    state = { ...state, ...changes }
    listeners.forEach((listener) => listener())
  }

  /**
   * Asks the gate before a send. Returns the send decision when the send may be prepared now; null when the flow went on
   * in another way (a confirmation step inserted and prepared, a wait, an error, or a stale answer).
   */
  async function settleGate(step: FlowStep, mine: number, attempt: Attempt, checkGate: GateCheck): Promise<Extract<GateDecision, { kind: 'send' }> | null> {
    const chain = step.plan.chain
    let answer: GateCheckAnswer
    try {
      answer = await checkGate({ chainId: chain.chainId, gate: chain.contracts.gate as Address, account: dependencies.signer.address, ...(carriesGateEvidence(step.plan) ? { carriesEvidence: true } : {}) })
    } catch (error) {
      if (mine === generation) update({ phase: 'error', error: gateErrorText(error, chain.name, BEACON_HINT) })
      return null
    }
    if (mine !== generation) return null
    const decision = decideGateStep(answer, { chain, nowMilliseconds: now(), waits: attempt.waits })
    switch (decision.kind) {
      case 'send':
        return decision
      case 'refuse':
        update({ phase: 'error', error: decision.message })
        return null
      case 'wait':
        update({ phase: 'waiting', gateWait: decision.wait })
        await sleep(decision.wait.seconds * 1000)
        if (mine === generation) await prepareCurrent({ ...attempt, waits: attempt.waits + 1 })
        return null
      case 'confirm': {
        const confirmStep: FlowStep = { plan: decision.plan, skippable: false, gateConfirm: decision.mark }
        update({ steps: [...state.steps.slice(0, state.stepIndex), confirmStep, ...state.steps.slice(state.stepIndex)] })
        await prepareCurrent(attempt)
        return null
      }
    }
  }

  /** The step with the gate evidence of the decision, for a send that carries it; the step itself otherwise. */
  function withEvidenceOf(step: FlowStep, decision: Extract<GateDecision, { kind: 'send' }>): FlowStep {
    if (!carriesGateEvidence(step.plan)) return step
    const carried: FlowStep = { ...step, plan: withGateEvidence(step.plan, decision.gateEvidence) }
    update({ steps: state.steps.map((existing, index) => (index === state.stepIndex ? carried : existing)) })
    return carried
  }

  async function prepareCurrent(attempt: Attempt = FIRST_ATTEMPT): Promise<void> {
    const step = state.steps[state.stepIndex]
    if (step === undefined) return update({ phase: 'finished', prepared: null, devicePrompt: null, gateWait: null })
    update({ phase: 'preparing', prepared: null, error: null, devicePrompt: null, gateWait: null })
    const mine = generation
    const { checkGate } = dependencies
    const gated = checkGate !== undefined && step.gateConfirm === undefined && passesGate(step.plan)
    try {
      const client = dependencies.clientFor(step.plan.chain.chainId)
      let ready = step
      if (gated) {
        const decision = await settleGate(step, mine, attempt, checkGate)
        if (decision === null) return
        ready = withEvidenceOf(step, decision)
      }
      const prepared = await prepareTransaction(ready.gateConfirm === undefined ? client : withKnownGas(client, ready.gateConfirm.gas), dependencies.signer.address, ready.plan)
      if (mine !== generation) return
      update({ phase: 'review', prepared })
    } catch (error) {
      if (mine !== generation) return
      // The epoch rolled over between the check and the estimate, or the node had not seen the confirmation: ask once more.
      if (gated && !attempt.redone && isGateEpochPassed(error)) return prepareCurrent({ redone: true, waits: 0 })
      update({ phase: 'error', error: `Could not prepare the transaction: ${revertText(error, { chainName: step.plan.chain.name }) ?? messageOf(error)}` })
    }
  }

  async function signAndSend(prepared: PreparedTransaction): Promise<void> {
    const confirmation = state.steps[state.stepIndex]?.gateConfirm
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
        ...(confirmation === undefined ? {} : { gateConfirm: true as const }),
      }
      if (outcome.status === 'reverted') {
        const error =
          confirmation === undefined
            ? `The transaction ${outcome.hash} reverted.`
            : `The confirmation of epoch ${confirmation.epoch} reverted in ${outcome.hash}. Nothing else was sent. Press r to check the gate and confirm the current epoch.`
        return update({ phase: 'error', outcomes: [...state.outcomes, record], error })
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
      // A confirmation is never prepared twice: its evidence names one epoch. A reverted one stays in the list as mined;
      // one that was not sent leaves it. Either way the send comes next, and its preparation asks the gate again.
      if (state.steps[state.stepIndex]?.gateConfirm !== undefined) {
        if (state.outcomes.length > state.stepIndex) update({ stepIndex: state.stepIndex + 1 })
        else update({ steps: state.steps.filter((_, index) => index !== state.stepIndex) })
      }
      void prepareCurrent()
    },
    cancel() {
      if (state.phase !== 'review' && state.phase !== 'error' && state.phase !== 'preparing' && state.phase !== 'waiting') return
      generation += 1
      update({ phase: 'cancelled', prepared: null, devicePrompt: null, gateWait: null })
    },
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
