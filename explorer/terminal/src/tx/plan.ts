/**
 * Transaction building. Every function here is pure: it takes configuration and user input and returns a
 * {@link PlannedTransaction}. Nothing here reads a chain, signs, or sends, and nothing imports the terminal library,
 * so the later web interface can reuse this file as it is.
 */
import { decodeFeeDirector, type FeeDataSource, type FeeDescription, type FeeDirector } from '@zk-bridge/shared'
import { encodeFunctionData, erc20Abi, getAddress, isAddress, isHex, type Address, type Hex } from 'viem'
import { formatUnits } from '../format/amounts'
import type { ChainConfig, TokenInfo } from '../model/types'
import type { RouterAddressesReading } from '../chain/live-reads'
import { deliveryRouterAbi, messageBridgeAbi, tokenMediatorAbi } from './abis'

/** One line of the argument list of a transaction, as the confirmation screen shows it. */
export interface DisplayArgument {
  readonly name: string
  readonly type: string
  /** The exact value: a checksummed address, a decimal integer, or hex. */
  readonly value: string
  /** A reading of the value for a person: a token amount, a percentage, or a symbol. Absent when there is none. */
  readonly meaning?: string
}

/** What the confirmation screen tells about the delivery fee that a relay carries. */
export interface DeliveryFeeReview {
  /** The router that the relay targets on the destination chain: the receiver of the relay. */
  readonly router: Address
  /** The default delivery router on that chain. The review warns when `router` differs from it. */
  readonly defaultRouter: Address
  readonly routerChainName: string
  /** The fee terms that the call data holds. */
  readonly director: FeeDirector
  /** The token that the fee is paid in, on the destination chain. */
  readonly token: { readonly symbol: string; readonly decimals: number }
  /** The amount now, the maximum and the label (`exact` or `estimate, at most X`). */
  readonly description: FeeDescription
  /** The gas and the base fee that the amount now uses. */
  readonly dataSource: FeeDataSource
  /** What the router on the destination chain says about the address that receives the tip and the address that receives what it cannot deliver. */
  readonly routerAddresses: RouterAddressesReading
}

/** A transaction that the dashboard offers for confirmation. It has no nonce or gas yet. */
export interface PlannedTransaction {
  readonly title: string
  readonly chain: ChainConfig
  readonly to: Address
  readonly contractLabel: string
  /** The full function signature, or `unknown` for calldata that no known ABI decodes. */
  readonly functionSignature: string
  readonly functionName: string
  readonly data: Hex
  /** The native coin that the transaction sends, in wei. */
  readonly value: bigint
  readonly arguments: readonly DisplayArgument[]
  /** Plain sentences that the confirmation screen shows below the arguments. */
  readonly notes: readonly string[]
  /** The delivery fee of a relay that pays a tip for delivery. Absent for every other transaction. */
  readonly deliveryFee?: DeliveryFeeReview
}

/** A named failure of input validation. The message tells the user what to fix. */
export class PlanInputError extends Error {
  override readonly name = 'PlanInputError'
}

/** How a token relay delivers: a plain release, or a release that also calls the receiver. */
export type RelayMode = { readonly kind: 'plain' } | { readonly kind: 'call'; readonly data: Hex }

/** Input of {@link planApproval}. */
export interface ApprovalInput {
  readonly chain: ChainConfig
  readonly token: TokenInfo
  readonly spender: Address
  readonly spenderLabel: string
  readonly amount: bigint
}

/** Plans an exact-amount allowance for the mediator. The dashboard never asks for an unlimited allowance. */
export function planApproval(input: ApprovalInput): PlannedTransaction {
  const { chain, token, spender, spenderLabel, amount } = input
  return {
    title: `Approve ${token.symbol} for ${spenderLabel}`,
    chain,
    to: token.address,
    contractLabel: `${token.symbol} token`,
    functionSignature: 'approve(address,uint256)',
    functionName: 'approve',
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }),
    value: 0n,
    arguments: [
      { name: 'spender', type: 'address', value: getAddress(spender), meaning: spenderLabel },
      { name: 'amount', type: 'uint256', value: amount.toString(), meaning: amountMeaning(amount, token) },
    ],
    notes: ['This allows the mediator to pull exactly this amount. It is not an unlimited allowance.'],
  }
}

/** The note under a plan that sets a gas limit. */
const GAS_LIMIT_NOTE =
  'The mediator uses the larger of this gas limit and its default for the kind of message. It refuses a gas limit above the bridge maximum.'

/** Input of {@link planRelay}. */
export interface RelayInput {
  readonly chain: ChainConfig
  readonly token: TokenInfo
  readonly receiver: Address
  /** The amount to pull from the sender, in base units. */
  readonly amount: bigint
  readonly mode: RelayMode
  /**
   * The gas limit that the request asks for on the other chain. When it is set, the plan uses the overload with a
   * trailing gas limit. The mediator uses the larger of this value and its default, and refuses a value above the
   * bridge maximum. When it is absent, the plan uses the function without a gas limit.
   */
  readonly gasLimit?: bigint
  /**
   * The delivery fee. The mode must be `call` with the encoded director as data, and the receiver must be the fee
   * router. The plan refuses any other combination, so a review never shows a fee that the data does not hold.
   */
  readonly deliveryFee?: DeliveryFeeReview
}

/**
 * Plans `relayTokens` or `relayTokensAndCall` on the token mediator, with a trailing gas limit when the input has one.
 *
 * The mediator takes no fee: the other chain receives the whole amount.
 *
 * @throws PlanInputError for a zero amount, a zero receiver or a gas limit of zero.
 */
export function planRelay(input: RelayInput): PlannedTransaction {
  const { chain, token, receiver, amount, mode } = input
  if (amount <= 0n) throw new PlanInputError('The amount must be above zero.')
  requireAddress(receiver, 'receiver')
  if (input.gasLimit !== undefined && input.gasLimit <= 0n) throw new PlanInputError('The gas limit must be above zero.')
  if (input.deliveryFee !== undefined) requireDeliveryFeeMatch(input.deliveryFee, receiver, mode)
  const common = { chain, to: chain.contracts.tokenMediator, contractLabel: 'TokenMediator', value: 0n }
  const tokenArgument = { name: 'token', type: 'address', value: getAddress(token.address), meaning: token.symbol }
  const receiverArgument = { name: 'receiver', type: 'address', value: getAddress(receiver) }
  const amountArgument = {
    name: 'value',
    type: 'uint256',
    value: amount.toString(),
    meaning: amountMeaning(amount, token),
  }

  const gasLimitArguments: readonly DisplayArgument[] =
    input.gasLimit === undefined ? [] : [{ name: 'gasLimit', type: 'uint256', value: input.gasLimit.toString() }]
  const gasLimitNotes = input.gasLimit === undefined ? [] : [GAS_LIMIT_NOTE]

  if (mode.kind === 'plain') {
    const baseArguments = [token.address, receiver, amount] as const
    const { gasLimit } = input
    return {
      ...common,
      title: `Relay ${token.symbol} to the other chain`,
      functionSignature: gasLimit === undefined ? 'relayTokens(address,address,uint256)' : 'relayTokens(address,address,uint256,uint256)',
      functionName: 'relayTokens',
      data:
        gasLimit === undefined
          ? encodeFunctionData({ abi: tokenMediatorAbi, functionName: 'relayTokens', args: baseArguments })
          : encodeFunctionData({ abi: tokenMediatorAbi, functionName: 'relayTokens', args: [...baseArguments, gasLimit] }),
      arguments: [tokenArgument, receiverArgument, amountArgument, ...gasLimitArguments],
      notes: ['If the receiver cannot take the release there, the release is final: the tokens stay in the mediator and nobody can claim them. Check the receiver first.', ...gasLimitNotes],
    }
  }

  const callArguments = [token.address, receiver, amount, mode.data] as const
  const { gasLimit } = input
  return {
    ...common,
    title: `Relay ${token.symbol} and call the receiver`,
    functionSignature:
      gasLimit === undefined ? 'relayTokensAndCall(address,address,uint256,bytes)' : 'relayTokensAndCall(address,address,uint256,bytes,uint256)',
    functionName: 'relayTokensAndCall',
    data:
      gasLimit === undefined
        ? encodeFunctionData({ abi: tokenMediatorAbi, functionName: 'relayTokensAndCall', args: callArguments })
        : encodeFunctionData({ abi: tokenMediatorAbi, functionName: 'relayTokensAndCall', args: [...callArguments, gasLimit] }),
    arguments: [tokenArgument, receiverArgument, amountArgument, bytesArgument('data', mode.data), ...gasLimitArguments],
    notes: [
      ...(input.deliveryFee === undefined ? [] : deliveryFeeNotes(input.deliveryFee)),
      'The receiver gets a call to onTokenBridged with this data, even when the data is empty.',
      ...gasLimitNotes,
    ],
    ...(input.deliveryFee === undefined ? {} : { deliveryFee: input.deliveryFee }),
  }
}

/** Input of {@link planWrapAndRelay}. */
export interface WrapAndRelayInput {
  readonly chain: ChainConfig
  readonly receiver: Address
  /** The native coin to wrap and relay, in wei. */
  readonly value: bigint
}

/** Plans `wrapAndRelayTokens(receiver)` on the delivery router. The coin travels as the call value. */
export function planWrapAndRelay(input: WrapAndRelayInput): PlannedTransaction {
  const { chain, receiver, value } = input
  const router = chain.contracts.deliveryRouter
  if (router === null) throw new PlanInputError(`${chain.name} has no delivery router in this deployment.`)
  if (value <= 0n) throw new PlanInputError('The amount must be above zero.')
  requireAddress(receiver, 'receiver')
  return {
    title: `Wrap ${chain.nativeSymbol} and relay it to the other chain`,
    chain,
    to: router,
    contractLabel: 'DeliveryRouter',
    functionSignature: 'wrapAndRelayTokens(address)',
    functionName: 'wrapAndRelayTokens',
    data: encodeFunctionData({ abi: deliveryRouterAbi, functionName: 'wrapAndRelayTokens', args: [receiver] }),
    value,
    arguments: [{ name: 'receiver', type: 'address', value: getAddress(receiver) }],
    notes: [`The transaction sends ${value.toString()} wei of ${chain.nativeSymbol}. The router wraps it, then relays it.`],
  }
}

/** Input of {@link planSendMessage}. */
export interface SendMessageInput {
  readonly chain: ChainConfig
  readonly target: Address
  readonly data: Hex
  /** The gas that the message gets on the other chain. */
  readonly gas: bigint
}

/** Plans `requireToPassMessage(target, data, gas)` on the message bridge. */
export function planSendMessage(input: SendMessageInput): PlannedTransaction {
  const { chain, target, data, gas } = input
  requireAddress(target, 'target')
  if (gas <= 0n) throw new PlanInputError('The gas must be above zero.')
  return {
    title: 'Send a message to the other chain',
    chain,
    to: chain.contracts.messageBridge,
    contractLabel: 'MessageBridge',
    functionSignature: 'requireToPassMessage(address,bytes,uint256)',
    functionName: 'requireToPassMessage',
    data: encodeFunctionData({ abi: messageBridgeAbi, functionName: 'requireToPassMessage', args: [target, data, gas] }),
    value: 0n,
    arguments: [
      { name: 'target', type: 'address', value: getAddress(target) },
      bytesArgument('data', data),
      { name: 'gas', type: 'uint256', value: gas.toString() },
    ],
    notes: ['The target contract on the other chain receives this call from the bridge. Delivery happens once.'],
  }
}

/**
 * Describes an amount for a person: the formatted value and the symbol.
 * It is exported for the confirmation screen and the builders of operator calls.
 */
export function amountMeaning(amount: bigint, token: TokenInfo): string {
  return `${formatUnits(amount, token.decimals)} ${token.symbol}`
}

/** Reads user text as a hex byte string. An empty string is the empty byte string. */
export function parseHexBytes(text: string): Hex {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed === '0x') return '0x'
  if (!isHex(trimmed) || trimmed.length % 2 !== 0) {
    throw new PlanInputError('The data must be hex with an even number of digits, such as 0xabcd.')
  }
  return trimmed
}

/** Checks a user address and returns it checksummed. */
export function parseAddress(text: string, name: string): Address {
  const trimmed = text.trim()
  if (!isAddress(trimmed, { strict: false })) throw new PlanInputError(`The ${name} is not an address.`)
  return getAddress(trimmed)
}

/** Refuses a delivery fee that the receiver or the call data does not carry. */
function requireDeliveryFeeMatch(deliveryFee: DeliveryFeeReview, receiver: Address, mode: RelayMode): void {
  if (mode.kind !== 'call') throw new PlanInputError('A delivery fee needs relayTokensAndCall.')
  if (getAddress(receiver) !== getAddress(deliveryFee.router)) {
    throw new PlanInputError('A delivery fee needs the router of the other chain as the receiver.')
  }
  if (!holdsDirector(mode.data, deliveryFee.director)) throw new PlanInputError('The call data does not hold the fee terms.')
}

/** True when the data is the encoding of the director. The guard of the builders has already refused invalid terms. */
function holdsDirector(data: Hex, director: FeeDirector): boolean {
  try {
    const decoded = decodeFeeDirector(data)
    return (
      decoded.recipient.toLowerCase() === director.recipient.toLowerCase() &&
      decoded.settings === director.settings &&
      decoded.limit === director.limit &&
      decoded.multiplier === director.multiplier
    )
  } catch {
    return false
  }
}

/** The sentences about a delivery fee. The second one repeats what `DeliveryRouter.sol` states about a message that the bridge delivers directly. */
function deliveryFeeNotes(deliveryFee: DeliveryFeeReview): string[] {
  return [
    `The receiver is the router ${getAddress(deliveryFee.router)} on ${deliveryFee.routerChainName}. The tokens go to ${getAddress(deliveryFee.director.recipient)} after the tip.`,
    'The tip goes to the reward address of the delivery router. Anyone can deliver through the router, and the account that signs the delivery receives no tip, so a copied delivery gains the copier nothing. When someone delivers on the bridge directly, no tip is paid, and the recipient gets everything. When the router cannot deliver to the recipient, it hands the tokens to its failed delivery address.',
  ]
}

function bytesArgument(name: string, data: Hex): DisplayArgument {
  const length = (data.length - 2) / 2
  return { name, type: 'bytes', value: data, meaning: `${length} bytes` }
}

function requireAddress(value: string, name: string): void {
  if (!isAddress(value, { strict: false })) throw new PlanInputError(`The ${name} is not an address.`)
}
