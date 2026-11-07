/**
 * Live reads from the chains: balances and allowances. They use the RPC endpoints,
 * not the indexer, because a value that a transaction depends on must be current.
 */
import { readRelayGasFacts, type RelayGasFacts } from '@zk-bridge/shared'
import { erc20Abi, isAddress, getAddress, zeroAddress, type Abi, type Address } from 'viem'
import type { ChainConfig, TokenInfo } from '../model/types'
import { deliveryRouterAbi } from '../tx/abis'

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
  /** What the mediator says about the kind of the first message of a relay of this token. */
  readonly relayGas: RelayGasFacts
}

/** The live state of one chain for the connected account. */
export interface ChainSnapshot {
  readonly chain: ChainConfig
  readonly nativeBalance: bigint
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
    const [nativeBalance, positions] = await Promise.all([
      client.getBalance({ address: account }),
      Promise.all(tokens.map((token) => readPosition(client, { chain, account, token }))),
    ])
    return { status: 'ok', snapshot: { chain, nativeBalance, positions } }
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
  const [balance, allowance, relayGas] = await Promise.all([
    readBigint(client, { address: token.address, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    readBigint(client, { address: token.address, abi: erc20Abi, functionName: 'allowance', args: [account, mediator] }),
    cachedRelayGasFacts(client, { chain, mediator, token: token.address }),
  ])
  return { token, balance, allowance, relayGas }
}

/** How long a `unacknowledged` reading is kept. It changes once the first bridge of the token is proven, so it is re-read. */
const UNACKNOWLEDGED_KEEP_MILLISECONDS = 5 * 60_000

interface CachedFacts {
  readonly facts: Promise<RelayGasFacts>
  /** When the entry stops being valid, or Infinity. */
  readonly until: number
}

/** The relay gas facts already read, per client. A new client (new RPC settings) starts empty. */
const relayGasCache = new WeakMap<object, Map<string, CachedFacts>>()

/**
 * Relay gas facts (`nativeTokenAddress`, `isBridgedTokenDeployAcknowledged`) of a token. They do not change with the
 * account or with time (a copy stays a copy; a native token stays native; once the mediator acknowledged the deploy it stays
 * so), but the snapshot is polled every 15 s, so reading them each time was most of the RPC load. They are read once per
 * client, chain, mediator and token. A token that is native and not yet acknowledged can change, so that reading is kept
 * for five minutes only. A failed read is not kept.
 */
function cachedRelayGasFacts(client: ReadClient, input: { chain: ChainConfig; mediator: Address; token: Address }): Promise<RelayGasFacts> {
  let entries = relayGasCache.get(client)
  if (entries === undefined) {
    entries = new Map()
    relayGasCache.set(client, entries)
  }
  const key = `${input.chain.chainId}:${input.mediator}:${input.token}`.toLowerCase()
  const known = entries.get(key)
  if (known !== undefined && known.until > Date.now()) return known.facts
  const facts = readRelayGasFacts(client, { mediator: input.mediator, token: input.token })
  const map = entries
  map.set(key, { facts, until: Infinity })
  facts.then(
    (value) => {
      if (value.kind === 'unacknowledged') map.set(key, { facts, until: Date.now() + UNACKNOWLEDGED_KEEP_MILLISECONDS })
    },
    () => {
      if (map.get(key)?.facts === facts) map.delete(key)
    },
  )
  return facts
}

async function readBigint(
  client: ReadClient,
  parameters: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] },
): Promise<bigint> {
  const value = await client.readContract(parameters)
  if (typeof value === 'bigint') return value
  throw new Error(`${parameters.functionName} did not return an integer`)
}

/**
 * What the delivery router says about the two addresses that it pays: the reward address, which receives the tips, and the
 * failed delivery address, which receives what the router cannot deliver. `unreadable` means the router did not answer
 * `rewardAddress()` or `failedDeliveryAddress()` with an address: the read failed, or the router is of an older version.
 */
export type RouterAddressesReading =
  | { readonly kind: 'read'; readonly rewardAddress: Address; readonly failedDeliveryAddress: Address }
  | { readonly kind: 'unreadable'; readonly reason: string }

/** Reads one address of a delivery router. It throws when the router does not answer with a non-zero address. */
async function readRouterAddress(client: ReadClient, input: { router: Address; functionName: 'rewardAddress' | 'failedDeliveryAddress' }): Promise<Address> {
  const value = await client.readContract({ address: input.router, abi: deliveryRouterAbi, functionName: input.functionName })
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) throw new Error('The router did not return an address.')
  if (value === zeroAddress) throw new Error(`The router returned the zero address for ${input.functionName}().`)
  return getAddress(value)
}

/**
 * Reads `rewardAddress()` and `failedDeliveryAddress()` of a delivery router. It never throws; a failure becomes an
 * `unreadable` result. The zero address is also unreadable: the router of this version refuses it in the constructor,
 * so it is not that router.
 */
export async function readRouterAddresses(client: ReadClient, input: { router: Address }): Promise<RouterAddressesReading> {
  try {
    const rewardAddress = await readRouterAddress(client, { router: input.router, functionName: 'rewardAddress' })
    const failedDeliveryAddress = await readRouterAddress(client, { router: input.router, functionName: 'failedDeliveryAddress' })
    return { kind: 'read', rewardAddress, failedDeliveryAddress }
  } catch (error) {
    return { kind: 'unreadable', reason: error instanceof Error ? error.message.split('\n')[0]! : String(error) }
  }
}
