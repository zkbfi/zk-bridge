/**
 * Transaction building. Every function here is pure: it takes configuration and user input and returns a
 * {@link PlannedTransaction}. Nothing here reads a chain, signs, or sends, and nothing imports the terminal library,
 * so the later web interface can reuse this file as it is.
 */
import { encodeFunctionData, erc20Abi, getAddress, isAddress, isHex, type Address, type Hex } from 'viem'
import { feeOf, formatRateAsPercent, formatUnits } from '../format/amounts'
import type { ChainConfig, TokenInfo } from '../model/types'
import { messageBridgeAbi, tokenMediatorAbi, wrappedNativeRouterAbi } from './abis'

/** One line of the argument list of a transaction, as the confirmation screen shows it. */
export interface DisplayArgument {
  readonly name: string
  readonly type: string
  /** The exact value: a checksummed address, a decimal integer, or hex. */
  readonly value: string
  /** A reading of the value for a person: a token amount, a percentage, or a symbol. Absent when there is none. */
  readonly meaning?: string
}

/** A fee that the contract charges, as far as the dashboard can compute it before sending. */
export interface ChargedFee {
  readonly token: TokenInfo
  /** The rate, 1e18-scaled. */
  readonly rate: bigint
  /** The amount that the contract takes, in base units. */
  readonly amount: bigint
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
  readonly charge: ChargedFee | null
  /** Plain sentences that the confirmation screen shows below the arguments. */
  readonly notes: readonly string[]
}

/** A named failure of input validation. The message tells the user what to fix. */
export class PlanInputError extends Error {
  override readonly name = 'PlanInputError'
}

/** How a token relay delivers and what it does when the recipient cannot be paid. */
export type RelayMode =
  | { readonly kind: 'plain' }
  | { readonly kind: 'call'; readonly data: Hex }
  | {
      readonly kind: 'fallback'
      readonly data: Hex
      readonly fallbackRecipient: Address
      /** The highest fee rate that the sender accepts, 1e18-scaled. Absent means the contract default: no limit. */
      readonly maxFeeRate?: bigint
    }

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
    charge: null,
    notes: ['This allows the mediator to pull exactly this amount. It is not an unlimited allowance.'],
  }
}

/** Input of {@link planRelay}. */
export interface RelayInput {
  readonly chain: ChainConfig
  readonly token: TokenInfo
  readonly receiver: Address
  /** The amount to pull from the sender, in base units. */
  readonly amount: bigint
  readonly mode: RelayMode
  /** The current fee rate of the mediator, 1e18-scaled, as read from the chain. */
  readonly currentFeeRate: bigint
}

/**
 * Plans `relayTokens`, `relayTokensAndCall` or `relayTokensWithFallback` on the token mediator.
 *
 * The fallback mode picks the six-argument overload when a `maxFeeRate` is set. That overload reverts when the fee
 * rate rises above the limit, so a sender is never charged more than they accepted.
 *
 * @throws PlanInputError for a zero amount, a zero receiver, or a fee limit below the current fee rate.
 */
export function planRelay(input: RelayInput): PlannedTransaction {
  const { chain, token, receiver, amount, mode, currentFeeRate } = input
  if (amount <= 0n) throw new PlanInputError('The amount must be above zero.')
  requireAddress(receiver, 'receiver')
  const fee = feeOf(amount, currentFeeRate)
  const charge: ChargedFee = { token, rate: currentFeeRate, amount: fee }
  const common = { chain, to: chain.contracts.tokenMediator, contractLabel: 'TokenMediator', value: 0n, charge }
  const tokenArgument = { name: 'token', type: 'address', value: getAddress(token.address), meaning: token.symbol }
  const receiverArgument = { name: 'receiver', type: 'address', value: getAddress(receiver) }
  const amountArgument = {
    name: 'value',
    type: 'uint256',
    value: amount.toString(),
    meaning: amountMeaning(amount, token),
  }
  const notes = relayNotes({ token, amount, fee, currentFeeRate })

  if (mode.kind === 'plain') {
    return {
      ...common,
      title: `Relay ${token.symbol} to the other chain`,
      functionSignature: 'relayTokens(address,address,uint256)',
      functionName: 'relayTokens',
      data: encodeFunctionData({
        abi: tokenMediatorAbi,
        functionName: 'relayTokens',
        args: [token.address, receiver, amount],
      }),
      arguments: [tokenArgument, receiverArgument, amountArgument],
      notes: [...notes, 'If the receiver cannot be paid there, the release goes to the sender at the same address.'],
    }
  }

  if (mode.kind === 'call') {
    return {
      ...common,
      title: `Relay ${token.symbol} and call the receiver`,
      functionSignature: 'relayTokensAndCall(address,address,uint256,bytes)',
      functionName: 'relayTokensAndCall',
      data: encodeFunctionData({
        abi: tokenMediatorAbi,
        functionName: 'relayTokensAndCall',
        args: [token.address, receiver, amount, mode.data],
      }),
      arguments: [tokenArgument, receiverArgument, amountArgument, bytesArgument('data', mode.data)],
      notes: [...notes, 'The receiver gets a call to onTokenBridged with this data, even when the data is empty.'],
    }
  }

  const fallbackArgument = {
    name: 'fallbackRecipient',
    type: 'address',
    value: getAddress(mode.fallbackRecipient),
  }
  const baseArguments = [
    tokenArgument,
    receiverArgument,
    amountArgument,
    bytesArgument('data', mode.data),
    fallbackArgument,
  ]
  if (mode.maxFeeRate === undefined) {
    return {
      ...common,
      title: `Relay ${token.symbol} with a fallback recipient`,
      functionSignature: 'relayTokensWithFallback(address,address,uint256,bytes,address)',
      functionName: 'relayTokensWithFallback',
      data: encodeFunctionData({
        abi: tokenMediatorAbi,
        functionName: 'relayTokensWithFallback',
        args: [token.address, receiver, amount, mode.data, mode.fallbackRecipient],
      }),
      arguments: baseArguments,
      notes: [...notes, 'No fee limit is set: any fee up to the contract ceiling applies.'],
    }
  }
  if (mode.maxFeeRate < currentFeeRate) {
    throw new PlanInputError('The fee limit is below the current fee rate, so the call would revert.')
  }
  return {
    ...common,
    title: `Relay ${token.symbol} with a fallback recipient and a fee limit`,
    functionSignature: 'relayTokensWithFallback(address,address,uint256,bytes,address,uint256)',
    functionName: 'relayTokensWithFallback',
    data: encodeFunctionData({
      abi: tokenMediatorAbi,
      functionName: 'relayTokensWithFallback',
      args: [token.address, receiver, amount, mode.data, mode.fallbackRecipient, mode.maxFeeRate],
    }),
    arguments: [
      ...baseArguments,
      { name: 'maxFeeRate', type: 'uint256', value: mode.maxFeeRate.toString(), meaning: rateMeaning(mode.maxFeeRate) },
    ],
    notes: [...notes, 'The call reverts if the fee rate rises above the limit before it is mined.'],
  }
}

/** Input of {@link planWrapAndRelay}. */
export interface WrapAndRelayInput {
  readonly chain: ChainConfig
  readonly receiver: Address
  /** The native coin to wrap and relay, in wei. */
  readonly value: bigint
}

/** Plans `wrapAndRelayTokens(receiver)` on the wrapped-native router. The coin travels as the call value. */
export function planWrapAndRelay(input: WrapAndRelayInput): PlannedTransaction {
  const { chain, receiver, value } = input
  const router = chain.contracts.wrappedNativeRouter
  if (router === null) throw new PlanInputError(`${chain.name} has no wrapped-native router in this deployment.`)
  if (value <= 0n) throw new PlanInputError('The amount must be above zero.')
  requireAddress(receiver, 'receiver')
  return {
    title: `Wrap ${chain.nativeSymbol} and relay it to the other chain`,
    chain,
    to: router,
    contractLabel: 'WETHOmnibridgeRouter',
    functionSignature: 'wrapAndRelayTokens(address)',
    functionName: 'wrapAndRelayTokens',
    data: encodeFunctionData({ abi: wrappedNativeRouterAbi, functionName: 'wrapAndRelayTokens', args: [receiver] }),
    value,
    arguments: [{ name: 'receiver', type: 'address', value: getAddress(receiver) }],
    charge: null,
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
    charge: null,
    notes: ['The target contract on the other chain receives this call from the bridge. Delivery happens once.'],
  }
}

/** Input of {@link planClaim}. */
export interface ClaimInput {
  readonly chain: ChainConfig
  readonly token: TokenInfo
  readonly account: Address
  /** The claimable balance, in base units, as read from the chain. */
  readonly claimable: bigint
}

/** Plans `claim(token, account)` on the token mediator. Anyone may call it, and it pays only `account`. */
export function planClaim(input: ClaimInput): PlannedTransaction {
  const { chain, token, account, claimable } = input
  if (claimable <= 0n) throw new PlanInputError(`Nothing is claimable in ${token.symbol} for this account.`)
  return {
    title: `Claim ${token.symbol}`,
    chain,
    to: chain.contracts.tokenMediator,
    contractLabel: 'TokenMediator',
    functionSignature: 'claim(address,address)',
    functionName: 'claim',
    data: encodeFunctionData({ abi: tokenMediatorAbi, functionName: 'claim', args: [token.address, account] }),
    value: 0n,
    arguments: [
      { name: 'token', type: 'address', value: getAddress(token.address), meaning: token.symbol },
      { name: 'account', type: 'address', value: getAddress(account) },
    ],
    charge: null,
    notes: [`The mediator pays ${amountMeaning(claimable, token)} to the account.`],
  }
}

/**
 * Describes an amount for a person: the formatted value and the symbol.
 * It is exported for the confirmation screen and the builders of operator calls.
 */
export function amountMeaning(amount: bigint, token: TokenInfo): string {
  return `${formatUnits(amount, token.decimals)} ${token.symbol}`
}

/** Describes a 1e18-scaled rate as an exact percentage. */
export function rateMeaning(rate: bigint): string {
  return formatRateAsPercent(rate)
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

function bytesArgument(name: string, data: Hex): DisplayArgument {
  const length = (data.length - 2) / 2
  return { name, type: 'bytes', value: data, meaning: `${length} bytes` }
}

function relayNotes(input: { token: TokenInfo; amount: bigint; fee: bigint; currentFeeRate: bigint }): string[] {
  const { token, amount, fee, currentFeeRate } = input
  const net = amount - fee
  return [
    `Fee rate ${formatRateAsPercent(currentFeeRate)}: the mediator takes ${amountMeaning(fee, token)}. ` +
      `${amountMeaning(net, token)} reaches the other chain.`,
  ]
}

function requireAddress(value: string, name: string): void {
  if (!isAddress(value, { strict: false })) throw new PlanInputError(`The ${name} is not an address.`)
}
