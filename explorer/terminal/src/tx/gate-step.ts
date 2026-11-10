/**
 * The deposit gate step of a send, for every program that sends through a planned transaction (the terminal and the web
 * page). On a chain whose `BeaconForkGate` enforces (Sepolia, Ethereum), a send in an epoch that nobody confirmed reverts
 * with `ForkNotConfirmed(epoch)`. Right before the estimate of a send, the program asks the shared gate check
 * (`createGateCheck` of `@zk-bridge/shared`), and {@link decideGateStep} turns the answer into what to do: send, wait,
 * refuse, or insert the step `confirm(evidence)` before the send.
 *
 * Pure: nothing here reads a chain, signs or sends, and nothing imports the terminal library.
 */
import { gateConfirmWindow, GateEvidenceError, type GateConfirmation } from '@zk-bridge/shared'
import { getAddress, type Hex } from 'viem'
import type { ChainConfig } from '../model/types'
import type { PrepareClient } from './prepare'
import type { PlannedTransaction } from './plan'

/** The functions that send a bridge message, and so pass the deposit gate of their chain. */
export const GATED_FUNCTIONS: readonly string[] = ['relayTokens', 'relayTokensAndCall', 'wrapAndRelayTokens', 'requireToPassMessage']

/**
 * Whether a planned transaction passes the deposit gate of its chain: a send on a chain with a gate. The relays of the
 * token mediator and of the delivery router share their names, and every `wrapAndRelayTokens…` form counts.
 */
export function passesGate(plan: PlannedTransaction): boolean {
  if (plan.chain.contracts.gate === null) return false
  return GATED_FUNCTIONS.includes(plan.functionName) || plan.functionName.startsWith('wrapAndRelayTokens')
}

/** How many times in a row the gate check waits before it gives up: 10 waits of a slot, 2 minutes on Sepolia. */
export const GATE_WAIT_LIMIT = 10

/** What a step that confirms an epoch carries, besides its plan. */
export interface GateConfirmMark {
  readonly epoch: bigint
  /** The gas of the simulation from the sender. The preparation uses it as the estimate. */
  readonly gas: bigint
  /** The first second of the next epoch. */
  readonly validUntil: bigint
}

/** What a program shows while the gate check waits. */
export interface GateWait {
  readonly chainName: string
  readonly epoch: bigint
  readonly seconds: number
  /**
   * Set when the check waits because too little of the epoch is left for a confirmation to land in it (not for a missing
   * header): the seconds that remained in `epoch`.
   */
  readonly epochSecondsLeft?: number
}

/** What to do with the answer of the gate check. */
export type GateDecision =
  /** Prepare the send now. */
  | { readonly kind: 'send' }
  /** Stop with this message. Nothing is sent. */
  | { readonly kind: 'refuse'; readonly message: string }
  /** Wait `wait.seconds`, then ask the gate again. */
  | { readonly kind: 'wait'; readonly wait: GateWait }
  /** Insert this confirmation before the send, and prepare it. */
  | { readonly kind: 'confirm'; readonly plan: PlannedTransaction; readonly mark: GateConfirmMark }

/**
 * Decides what a send does after the gate check answered.
 *
 * The confirmation and the send must land in one epoch. With less than `GATE_SAFETY_SECONDS` left in the epoch, a
 * confirmation that the signer signs and the chain mines would end up in the next epoch and confirm nothing for the send,
 * so the program waits for the next epoch and its first block (`gateConfirmWindow`) and asks again.
 *
 * @param answer The answer of the gate check.
 * @param input.chain The chain of the send.
 * @param input.nowMilliseconds The clock now.
 * @param input.waits How many waits in a row came before this answer. At {@link GATE_WAIT_LIMIT} a wait becomes a refusal.
 */
export function decideGateStep(answer: GateConfirmation, input: { readonly chain: ChainConfig; readonly nowMilliseconds: number; readonly waits: number }): GateDecision {
  const { chain, waits } = input
  switch (answer.kind) {
    case 'not-needed':
      return { kind: 'send' }
    case 'sealed':
      return { kind: 'refuse', message: `The ${chain.name} deposit gate is sealed: it admits no send in epoch ${answer.epoch} or later. Nothing was sent.` }
    case 'wait':
      if (waits >= GATE_WAIT_LIMIT) {
        return {
          kind: 'refuse',
          message: `The beacon header of epoch ${answer.epoch} is not on ${chain.name} after ${GATE_WAIT_LIMIT} checks ${answer.retryAfterSeconds} seconds apart. Nothing was sent.`,
        }
      }
      return { kind: 'wait', wait: { chainName: chain.name, epoch: answer.epoch, seconds: answer.retryAfterSeconds } }
    case 'confirm':
      return decideConfirm(answer, input)
  }
}

/** The confirmation goes ahead when enough of its epoch is left; else the program waits for the next epoch. */
function decideConfirm(answer: Extract<GateConfirmation, { kind: 'confirm' }>, input: { readonly chain: ChainConfig; readonly nowMilliseconds: number; readonly waits: number }): GateDecision {
  const { chain } = input
  const window = gateConfirmWindow(answer.validUntil, input.nowMilliseconds)
  if (!window.late) return { kind: 'confirm', plan: planGateConfirm(chain, answer), mark: { epoch: answer.epoch, gas: answer.gas, validUntil: answer.validUntil } }
  if (input.waits >= GATE_WAIT_LIMIT) {
    return {
      kind: 'refuse',
      message: `The ${chain.name} deposit gate still ends epoch ${answer.epoch} in ${window.secondsLeft} seconds after ${GATE_WAIT_LIMIT} checks. Nothing was sent.`,
    }
  }
  return { kind: 'wait', wait: { chainName: chain.name, epoch: answer.epoch, seconds: window.waitSeconds, epochSecondsLeft: window.secondsLeft } }
}

function utcTime(unixSeconds: bigint): string {
  return new Date(Number(unixSeconds) * 1000).toISOString().slice(11, 19)
}

/**
 * The planned transaction of a confirmation, for the review: `confirm(evidence)` on the gate, no value.
 *
 * @param chain The chain of the gate.
 * @param confirmation The answer of the gate check.
 */
export function planGateConfirm(chain: ChainConfig, confirmation: Extract<GateConfirmation, { kind: 'confirm' }>): PlannedTransaction {
  const data: Hex = confirmation.call.data
  return {
    title: `Confirm this epoch on the gate (epoch ${confirmation.epoch})`,
    chain,
    to: getAddress(confirmation.call.to),
    contractLabel: `${chain.name} deposit gate (BeaconForkGate)`,
    functionSignature: 'confirm(bytes)',
    functionName: 'confirm',
    data,
    value: 0n,
    arguments: [{ name: 'evidence', type: 'bytes', value: confirmation.evidence.encoded }],
    notes: [
      `The ${chain.name} deposit gate admits sends in epoch ${confirmation.epoch} once one transaction confirms it. This transaction confirms it. Your send follows as the next step.`,
      `The evidence proves fork version ${confirmation.forkVersion} with the beacon header of slot ${confirmation.evidence.header.slot}. The gate checks it against the beacon root on chain.`,
      `It must be mined before ${utcTime(confirmation.validUntil)} UTC, the end of epoch ${confirmation.epoch}. It sends no ${chain.nativeSymbol}.`,
    ],
  }
}

/**
 * A sentence for an error of the gate check.
 *
 * @param error What the check threw.
 * @param chainName The chain of the gate.
 * @param beaconHint What to do when no beacon endpoint answered, in the program's words. Default: nothing more.
 */
export function gateErrorText(error: unknown, chainName: string, beaconHint?: string): string {
  const reason = error instanceof Error ? error.message : String(error)
  const hint = beaconHint !== undefined && error instanceof GateEvidenceError && error.code === 'beacon-request-failed' ? ` ${beaconHint}` : ''
  return `Could not confirm the ${chainName} deposit gate: ${reason}.${hint}`
}

/** A client that answers the estimate with a gas that is known already (the gate confirmation's simulation). */
export function withKnownGas(client: PrepareClient, gas: bigint): PrepareClient {
  return {
    estimateGas: async () => gas,
    getTransactionCount: (parameters) => client.getTransactionCount(parameters),
    estimateFeesPerGas: () => client.estimateFeesPerGas(),
  }
}
