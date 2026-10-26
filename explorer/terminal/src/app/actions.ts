/**
 * Turns what the user typed in an action form into the steps of a transaction flow. Pure: it reads the form values
 * and the live snapshots, and throws {@link PlanInputError} with a message that tells the user what to fix.
 */
import type { DeliveryCostReport } from '@zk-bridge/shared'
import type { Address } from 'viem'
import { parseUnits, AmountParseError } from '../format/amounts'
import type { ChainSnapshot, ChainSnapshotResult, RouterAddressesReading, TokenPosition } from '../chain/live-reads'
import type { FlowStep } from '../flow/transaction-flow'
import type { ChainConfig, ChainSide, PairConfig, TokenInfo } from '../model/types'
import { buildDeliveryFeeModel, paysForDelivery, resolveDeliveryTarget, routerOf, transferValueOf, type TokenValuationsWei } from './delivery-fee-form'
import { encodeDirectorFor, isDeploymentDeliveryRouter, requireValidRouterRelay } from '../tx/fee-terms-guard'
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
  /** The delivery cost report of the destination chain. It is needed when the user pays for delivery. */
  readonly deliveryCost?: DeliveryCostReport | null
  /** The user's prices of tokens in wei, by lowercase address. Default: none. */
  readonly tokenValuationsWei?: TokenValuationsWei
  /**
   * What the router of the delivery fee says about the address that receives the tip and the address that receives
   * what it cannot deliver: read with {@link deliveryRouterOf}. Absent means nobody read it, and the review says so.
   */
  readonly routerAddresses?: RouterAddressesReading
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
  const source = bridgeSourceOf(values, tokens, context.pair)
  const { chain, side } = source
  const snapshot = snapshotOf(context.snapshots, side)
  const receiver = parseAddress(values.receiver ?? '', 'receiver')

  if (source.kind === 'native') {
    requireValidTermsForKnownRouter(values, { source, receiver, pair: context.pair })
    const value = parseAmount(values.amount ?? '', 18)
    if (value > snapshot.nativeBalance) throw new PlanInputError(`The amount is more than your ${chain.nativeSymbol} balance.`)
    return [{ plan: planWrapAndRelay({ chain, receiver, value }), skippable: false }]
  }

  if (source.kind === 'none') throw new PlanInputError('Choose a token.')
  const { token } = source
  const amount = parseAmount(values.amount ?? '', token.decimals)
  const position = positionOf(snapshot, token)
  if (amount > position.balance) throw new PlanInputError(`The amount is more than your ${token.symbol} balance.`)
  const relay = planRelay({
    chain,
    token,
    amount,
    currentFeeRate: snapshot.feeRate,
    ...(deliveryWanted(values, { source, tokens, context })
      ? deliveryRelayOf(values, { source, tokens, context, feeRate: snapshot.feeRate })
      : directRelayOf(values, { source, receiver, pair: context.pair })),
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

/**
 * Refuses a relay to a default delivery router whose data the router would hand to its failed delivery address. A relay
 * that pays for delivery builds its own data and meets the same guard in the encoder.
 */
function requireValidTermsForKnownRouter(
  values: Readonly<Record<string, string>>,
  input: { source: BridgeSource; receiver: Address; pair: PairConfig },
): void {
  const { source, receiver, pair } = input
  if (!isDeploymentDeliveryRouter(pair, receiver)) return
  const destination = source.side === 'first' ? pair.second : pair.first
  const mode = source.kind === 'native' ? ({ kind: 'plain' } satisfies RelayMode) : relayModeOf(values)
  const data = mode.kind === 'plain' ? '0x' : mode.data
  const destinationToken = source.kind === 'token' ? source.token.counterpart : null
  requireValidRouterRelay({ pair, destination, router: receiver, data, destinationToken })
}

/** The receiver and the mode that the user typed, once the guard accepts them. */
function directRelayOf(values: Readonly<Record<string, string>>, input: { source: BridgeSource; receiver: Address; pair: PairConfig }) {
  requireValidTermsForKnownRouter(values, input)
  return { receiver: input.receiver, mode: relayModeOf(values) }
}

/** What the bridge form has chosen as the source of the transfer. */
export type BridgeSource =
  | { readonly kind: 'none'; readonly side: ChainSide; readonly chain: ChainConfig }
  | { readonly kind: 'native'; readonly side: ChainSide; readonly chain: ChainConfig }
  | { readonly kind: 'token'; readonly side: ChainSide; readonly chain: ChainConfig; readonly token: TokenInfo }

/** Reads the token choice of the form: the side, and the token or the native coin. */
export function bridgeSourceOf(values: Readonly<Record<string, string>>, tokens: readonly TokenInfo[], pair: PairConfig): BridgeSource {
  const [sideText = '', identity = ''] = (values.token ?? '').split(':')
  const side: ChainSide = sideText === 'second' ? 'second' : 'first'
  const chain = side === 'first' ? pair.first : pair.second
  if (identity === NATIVE_CHOICE) return { kind: 'native', side, chain }
  const token = tokens.find((candidate) => candidate.side === side && candidate.address.toLowerCase() === identity.toLowerCase())
  return token === undefined ? { kind: 'none', side, chain } : { kind: 'token', side, chain, token }
}

/**
 * True when the relay carries a tip: the user left the tip on and the transfer can carry one. The tip is on by default.
 * A transfer that cannot carry one (the native coin route, or a chain with no delivery router in the deployment) is a plain
 * relay, and the form says why on its note.
 */
function deliveryWanted(
  values: Readonly<Record<string, string>>,
  input: { source: Extract<BridgeSource, { kind: 'token' }>; tokens: readonly TokenInfo[]; context: BridgeContext },
): boolean {
  if (!paysForDelivery(values)) return false
  const resolved = resolveDeliveryTarget({ source: input.source, pair: input.context.pair, tokens: input.tokens, valuations: input.context.tokenValuationsWei ?? {} })
  return resolved.kind === 'ready'
}

/** The reading of a review that nobody asked the router for. The review must not show an address it never read. */
const NOT_READ_ROUTER_ADDRESSES: RouterAddressesReading = { kind: 'unreadable', reason: 'The addresses were not read from the router.' }

/**
 * The router and the chain whose `rewardAddress()` and `failedDeliveryAddress()` the review of this form needs to show, or null when the form builds
 * no delivery fee. The form reads the addresses from the router, then passes it in the context.
 */
export function deliveryRouterOf(
  values: Readonly<Record<string, string>>,
  tokens: readonly TokenInfo[],
  context: BridgeContext,
): { readonly chainId: number; readonly router: Address } | null {
  const source = bridgeSourceOf(values, tokens, context.pair)
  if (source.kind !== 'token') return null
  if (!deliveryWanted(values, { source, tokens, context })) return null
  const resolved = resolveDeliveryTarget({ source, pair: context.pair, tokens, valuations: context.tokenValuationsWei ?? {} })
  if (resolved.kind !== 'ready') return null
  try {
    return { chainId: resolved.target.chain.chainId, router: routerOf(values, resolved.target) }
  } catch {
    // The only failure of the router read is a router field that is not an address. The build of the steps reports it to the user.
    return null
  }
}

/**
 * The receiver, the call data and the review of a relay that pays for delivery. The receiver is the delivery router of the
 * other chain. The call data is the encoded fee terms. The amount that the router receives is the amount less the fee
 * of the mediator.
 */
function deliveryRelayOf(
  values: Readonly<Record<string, string>>,
  input: { source: Extract<BridgeSource, { kind: 'token' }>; tokens: readonly TokenInfo[]; context: BridgeContext; feeRate: bigint },
) {
  const { context } = input
  const resolved = resolveDeliveryTarget({ source: input.source, pair: context.pair, tokens: input.tokens, valuations: context.tokenValuationsWei ?? {} })
  if (resolved.kind === 'unavailable') throw new PlanInputError(resolved.reason)
  if (context.deliveryCost === undefined || context.deliveryCost === null) {
    throw new PlanInputError('The delivery cost is not loaded yet. Wait for it, or choose No for Pay for delivery.')
  }
  const { target } = resolved
  const state = buildDeliveryFeeModel({ values, target, report: context.deliveryCost, transferValue: transferValueOf(values.amount ?? '', input.source.token.decimals, input.feeRate) })
  if (state.kind === 'needs-amount') throw new PlanInputError('The amount is too small: nothing reaches the delivery router after the bridge fee.')
  if (state.kind === 'unavailable') throw new PlanInputError(state.reason)
  const { chosen, dataSource, router } = state.model
  if (chosen.kind === 'invalid') throw new PlanInputError(chosen.reason)
  return {
    receiver: router,
    mode: { kind: 'call', data: encodeDirectorFor(chosen.director, context.pair, router) } satisfies RelayMode,
    deliveryFee: {
      router,
      defaultRouter: target.router,
      routerChainName: target.chain.name,
      director: chosen.director,
      token: target.token,
      description: chosen.description,
      dataSource,
      routerAddresses: context.routerAddresses ?? NOT_READ_ROUTER_ADDRESSES,
    },
  }
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

