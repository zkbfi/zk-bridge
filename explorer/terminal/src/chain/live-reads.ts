/**
 * Live reads from the chains: balances, allowances, claimable amounts and the fee rate. They use the RPC endpoints,
 * not the indexer, because a value that a transaction depends on must be current.
 */
import { erc20Abi, type Abi, type Address } from 'viem'
import type { ChainConfig, TokenInfo } from '../model/types'
import { tokenMediatorAbi } from '../tx/abis'

/** The part of a viem public client that the reads need. */
export interface ReadClient {
  getBalance(parameters: { address: Address }): Promise<bigint>
  readContract(parameters: {
    address: Address
    abi: Abi
    functionName: string
    args?: readonly unknown[]
  }): Promise<unknown>
}

/** What the connected account holds of one token on one chain. */
export interface TokenPosition {
  readonly token: TokenInfo
  readonly balance: bigint
  /** The allowance the account gave the token mediator. */
  readonly allowance: bigint
  /** The amount the mediator holds for the account to claim. */
  readonly claimable: bigint
}

/** The live state of one chain for the connected account. */
export interface ChainSnapshot {
  readonly chain: ChainConfig
  readonly nativeBalance: bigint
  /** The fee rate of the mediator, 1e18-scaled. */
  readonly feeRate: bigint
  /** The fee ceiling of the mediator, 1e18-scaled. */
  readonly feeCeiling: bigint
  readonly positions: readonly TokenPosition[]
}

/** A snapshot, or the reason that it could not be read. One dead endpoint must not blank the other chain. */
export type ChainSnapshotResult =
  | { readonly status: 'ok'; readonly snapshot: ChainSnapshot }
  | { readonly status: 'error'; readonly chain: ChainConfig; readonly message: string }

/** Input of {@link readChainSnapshot}. */
export interface SnapshotInput {
  readonly chain: ChainConfig
  readonly account: Address
  /** The tokens to read. Tokens of the other chain are ignored. */
  readonly tokens: readonly TokenInfo[]
}

/** Reads the snapshot of one chain. It never throws; an error becomes an `error` result. */
export async function readChainSnapshot(client: ReadClient, input: SnapshotInput): Promise<ChainSnapshotResult> {
  const { chain, account } = input
  const mediator = chain.contracts.tokenMediator
  const tokens = input.tokens.filter((token) => token.side === chain.side)
  try {
    const [nativeBalance, feeRate, feeCeiling, positions] = await Promise.all([
      client.getBalance({ address: account }),
      readBigint(client, { address: mediator, abi: tokenMediatorAbi, functionName: 'feeRate' }),
      readBigint(client, { address: mediator, abi: tokenMediatorAbi, functionName: 'feeCeiling' }),
      Promise.all(tokens.map((token) => readPosition(client, { chain, account, token }))),
    ])
    return { status: 'ok', snapshot: { chain, nativeBalance, feeRate, feeCeiling, positions } }
  } catch (error) {
    return { status: 'error', chain, message: error instanceof Error ? error.message : String(error) }
  }
}

async function readPosition(
  client: ReadClient,
  input: { chain: ChainConfig; account: Address; token: TokenInfo },
): Promise<TokenPosition> {
  const { chain, account, token } = input
  const mediator = chain.contracts.tokenMediator
  const [balance, allowance, claimable] = await Promise.all([
    readBigint(client, { address: token.address, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    readBigint(client, { address: token.address, abi: erc20Abi, functionName: 'allowance', args: [account, mediator] }),
    readBigint(client, { address: mediator, abi: tokenMediatorAbi, functionName: 'claimable', args: [token.address, account] }),
  ])
  return { token, balance, allowance, claimable }
}

async function readBigint(
  client: ReadClient,
  parameters: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] },
): Promise<bigint> {
  const value = await client.readContract(parameters)
  if (typeof value === 'bigint') return value
  throw new Error(`${parameters.functionName} did not return an integer`)
}
