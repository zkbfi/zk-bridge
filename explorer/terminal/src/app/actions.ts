/**
 * Turns what the user typed in an action form into the steps of a transaction flow. Pure: it reads the form values
 * and the live snapshots, and throws {@link PlanInputError} with a message that tells the user what to fix.
 */
import { readDeliveryTerms, routerCallbackGas, type DeliveryCall, type DeliveryCostReport } from '@zk-bridge/shared'
import type { Address, Hex } from 'viem'
import { parseUnits, AmountParseError } from '../format/amounts'
import type { ChainSnapshot, ChainSnapshotResult, RouterAddressesReading, TokenPosition } from '../chain/live-reads'
import type { FlowStep } from '../flow/transaction-flow'
import type { ChainConfig, ChainSide, PairConfig, TokenInfo } from '../model/types'
import { DELIVERY_FIELD, buildDeliveryFeeModel, paysForDelivery, resolveDeliveryTarget, routerOf, transferValueOf, type TokenValuationsWei } from './delivery-fee-form'
import { encodeDirectorFor, isDeploymentDeliveryRouter, requireValidRouterRelay } from '../tx/fee-terms-guard'
import {
  PlanInputError,
  parseAddress,
  parseHexBytes,
  planApproval,
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
 * @param values The form values: token, amount, receiver, mode, data, callback gas, maxFeePercent.
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
    ...(deliveryWanted(values, { source, tokens, context })
      ? deliveryRelayOf(values, { source, tokens, context })
      : directRelayOf(values, { source, receiver, pair: context.pair })),
  })
  const approval: readonly FlowStep[] =
    position.allowance >= amount
      ? []
      : [
          {
            plan: planApproval({ chain, token, spender: chain.contracts.tokenMediator, spenderLabel: 'ERC-20 mediator', amount }),
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
  const mode = relayModeOf(values)
  if (mode.kind === 'plain') return { receiver: input.receiver, mode }
  return { receiver: input.receiver, mode, callbackGas: callbackGasOf(values, { receiver: input.receiver, data: mode.data, pair: input.pair }) }
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
 * other chain. The call data is the encoded fee terms. The router receives the whole amount.
 */
function deliveryRelayOf(
  values: Readonly<Record<string, string>>,
  input: { source: Extract<BridgeSource, { kind: 'token' }>; tokens: readonly TokenInfo[]; context: BridgeContext },
) {
  const { context } = input
  const resolved = resolveDeliveryTarget({ source: input.source, pair: context.pair, tokens: input.tokens, valuations: context.tokenValuationsWei ?? {} })
  if (resolved.kind === 'unavailable') throw new PlanInputError(resolved.reason)
  if (context.deliveryCost === undefined || context.deliveryCost === null) {
    throw new PlanInputError('The delivery cost is not loaded yet. Wait for it, or choose No for Pay for delivery.')
  }
  const { target } = resolved
  const state = buildDeliveryFeeModel({ values, target, report: context.deliveryCost, transferValue: transferValueOf(values.amount ?? '', input.source.token.decimals) })
  if (state.kind === 'needs-amount') throw new PlanInputError('The amount is too small: enter an amount above zero to pay for delivery.')
  if (state.kind === 'unavailable') throw new PlanInputError(state.reason)
  const { chosen, dataSource, router } = state.model
  if (chosen.kind === 'invalid') throw new PlanInputError(chosen.reason)
  const call = deliveryCallOf(values)
  return {
    receiver: router,
    callbackGas: routerCallbackGas(call === null ? {} : { callGas: chosen.director.callGas }),
    mode: { kind: 'call', data: encodeDirectorFor(chosen.director, context.pair, { router, destination: target.chain, destinationToken: input.source.token.counterpart }, call ?? undefined) } satisfies RelayMode,
    deliveryFee: {
      router,
      defaultRouter: target.router,
      routerChainName: target.chain.name,
      director: chosen.director,
      ...(call === null ? {} : { call }),
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
  throw new PlanInputError(`The mode "${mode}" is not known.`)
}

/**
 * The optional call after the delivery: null when both fields are empty. A target with no call data is a call with empty
 * call data. Call data with no target is an error, because the router reads the call data only after a target.
 */
export function deliveryCallOf(values: Readonly<Record<string, string>>): DeliveryCall | null {
  const targetText = (values[DELIVERY_FIELD.callTarget] ?? '').trim()
  const dataText = (values[DELIVERY_FIELD.callData] ?? '').trim()
  const data = parseHexBytes(dataText)
  if (targetText === '' && data === '0x') return null
  if (targetText === '') throw new PlanInputError('The call data needs a call target. Name the contract to call, or clear the call data.')
  return { target: parseAddress(targetText, 'call target'), data }
}

/**
 * The callback gas of a relay with a call, as the mediator takes it. A number typed in the form wins. Without one, a
 * receiver that is a delivery router of the deployment gets the gas that the router needs for the terms in the data:
 * its own work, plus the call gas when the data asks for a call. Any other receiver needs a number, because nobody can
 * say how much gas its `onTokenBridged` needs.
 */
function callbackGasOf(values: Readonly<Record<string, string>>, input: { receiver: Address; data: Hex; pair: PairConfig }): bigint {
  const text = (values.callbackGas ?? '').trim()
  if (text !== '') {
    if (!/^\d+$/.test(text) || BigInt(text) === 0n) throw new PlanInputError('The callback gas must be a whole number above zero.')
    return BigInt(text)
  }
  if (isDeploymentDeliveryRouter(input.pair, input.receiver)) {
    const terms = readDeliveryTerms(input.data)
    return routerCallbackGas(terms.kind === 'director' && terms.call !== null ? { callGas: terms.director.callGas } : {})
  }
  throw new PlanInputError('Enter the callback gas: the exact gas that onTokenBridged gets on the other chain. A relay with a call has no default.')
}

/** Builds the single step of the send-a-message form. */
export function buildMessageSteps(values: Readonly<Record<string, string>>, pair: PairConfig): readonly FlowStep[] {
  const chain = values.chain === 'second' ? pair.second : pair.first
  const plan = planSendMessage({
    chain,
    target: parseAddress(values.target ?? '', 'target'),
    data: parseHexBytes(values.data ?? ''),
  })
  return [{ plan, skippable: false }]
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

