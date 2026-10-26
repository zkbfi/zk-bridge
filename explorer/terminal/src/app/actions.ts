/**
 * Turns what the user typed in an action form into the steps of a transaction flow. Pure: it reads the form values
 * and the live snapshots, and throws {@link PlanInputError} with a message that tells the user what to fix.
 */
import type { Address } from 'viem'
import { parseUnits, AmountParseError } from '../format/amounts'
import type { ChainSnapshot, ChainSnapshotResult, TokenPosition } from '../chain/live-reads'
import type { FlowStep } from '../flow/transaction-flow'
import type { ChainSide, PairConfig, TokenInfo } from '../model/types'
import {
  PlanInputError,
  parseAddress,
  parseHexBytes,
  planApproval,
  planClaim,
  planRelay,
  planSendMessage,
  planWrapAndRelay,
  type RelayMode,
} from '../tx/plan'

/** What the bridge form needs besides its values. */
export interface BridgeContext {
  readonly pair: PairConfig
  readonly snapshots: readonly ChainSnapshotResult[] | null
  readonly signerAddress: Address
}

/** The separator in a token choice value: `<side>:<address or native>`. */
export const NATIVE_CHOICE = 'native'

/** Builds the choice value of a token. */
export function tokenChoiceValue(token: TokenInfo): string {
  return `${token.side}:${token.address}`
}

/** Builds the choice value of the native coin of a side. */
export function nativeChoiceValue(side: ChainSide): string {
  return `${side}:${NATIVE_CHOICE}`
}

/**
 * Builds the steps for the bridge form: an exact-amount approval when the allowance is too low, then the relay.
 *
 * @param values The form values: token, amount, receiver, mode, data, fallback, maxFeePercent.
 */
export function buildBridgeSteps(values: Readonly<Record<string, string>>, tokens: readonly TokenInfo[], context: BridgeContext): readonly FlowStep[] {
  const [sideText = '', identity = ''] = (values.token ?? '').split(':')
  const side: ChainSide = sideText === 'second' ? 'second' : 'first'
  const chain = side === 'first' ? context.pair.first : context.pair.second
  const snapshot = snapshotOf(context.snapshots, side)
  const receiver = parseAddress(values.receiver ?? '', 'receiver')

  if (identity === NATIVE_CHOICE) {
    const value = parseAmount(values.amount ?? '', 18)
    if (value > snapshot.nativeBalance) throw new PlanInputError(`The amount is more than your ${chain.nativeSymbol} balance.`)
    return [{ plan: planWrapAndRelay({ chain, receiver, value }), skippable: false }]
  }

  const token = tokens.find((candidate) => candidate.side === side && candidate.address.toLowerCase() === identity.toLowerCase())
  if (token === undefined) throw new PlanInputError('Choose a token.')
  const amount = parseAmount(values.amount ?? '', token.decimals)
  const position = positionOf(snapshot, token)
  if (amount > position.balance) throw new PlanInputError(`The amount is more than your ${token.symbol} balance.`)
  const relay = planRelay({
    chain,
    token,
    receiver,
    amount,
    mode: relayModeOf(values),
    currentFeeRate: snapshot.feeRate,
  })
  const approval: readonly FlowStep[] =
    position.allowance >= amount
      ? []
      : [
          {
            plan: planApproval({ chain, token, spender: chain.contracts.tokenMediator, spenderLabel: 'TokenMediator', amount }),
            skippable: false,
          },
        ]
  return [...approval, { plan: relay, skippable: false }]
}

function relayModeOf(values: Readonly<Record<string, string>>): RelayMode {
  const mode = values.mode ?? 'plain'
  if (mode === 'plain') return { kind: 'plain' }
  const data = parseHexBytes(values.data ?? '')
  if (mode === 'call') return { kind: 'call', data }
  const fallbackRecipient = parseAddress(values.fallback ?? '', 'fallback recipient')
  return { kind: 'fallback', data, fallbackRecipient }
}

/** Builds the single step of the send-a-message form. */
export function buildMessageSteps(values: Readonly<Record<string, string>>, pair: PairConfig): readonly FlowStep[] {
  const chain = values.chain === 'second' ? pair.second : pair.first
  const gasText = (values.gas ?? '').trim()
  if (!/^\d+$/.test(gasText)) throw new PlanInputError('The gas must be a whole number.')
  const plan = planSendMessage({
    chain,
    target: parseAddress(values.target ?? '', 'target'),
    data: parseHexBytes(values.data ?? ''),
    gas: BigInt(gasText),
  })
  return [{ plan, skippable: false }]
}

/** A claimable balance found in the snapshots. */
export interface ClaimableEntry {
  readonly side: ChainSide
  readonly position: TokenPosition
}

/** Lists every non-zero claimable balance on both chains. */
export function claimableEntries(snapshots: readonly ChainSnapshotResult[] | null): readonly ClaimableEntry[] {
  return (snapshots ?? []).flatMap((result) =>
    result.status === 'error'
      ? []
      : result.snapshot.positions
          .filter((position) => position.claimable > 0n)
          .map((position) => ({ side: result.snapshot.chain.side, position })),
  )
}

/** Builds the single step that claims one entry for the signer. */
export function buildClaimSteps(entry: ClaimableEntry, pair: PairConfig, account: Address): readonly FlowStep[] {
  const chain = entry.side === 'first' ? pair.first : pair.second
  return [{ plan: planClaim({ chain, token: entry.position.token, account, claimable: entry.position.claimable }), skippable: false }]
}

function snapshotOf(snapshots: readonly ChainSnapshotResult[] | null, side: ChainSide): ChainSnapshot {
  const found = (snapshots ?? []).find((result) => result.status === 'ok' && result.snapshot.chain.side === side)
  if (found === undefined || found.status !== 'ok') {
    throw new PlanInputError('The balances of that chain are not loaded. Check the RPC URL and wait for them.')
  }
  return found.snapshot
}

function positionOf(snapshot: ChainSnapshot, token: TokenInfo): TokenPosition {
  const position = snapshot.positions.find((candidate) => candidate.token.address === token.address)
  if (position === undefined) throw new PlanInputError(`The ${token.symbol} balance is not loaded.`)
  return position
}

function parseAmount(text: string, decimals: number): bigint {
  try {
    return parseUnits(text, decimals)
  } catch (error) {
    if (error instanceof AmountParseError) throw new PlanInputError(error.message)
    throw error
  }
}

