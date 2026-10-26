/**
 * Access to the chains for the dashboard: reads of the account state and the clients that the transaction flow uses.
 * One implementation talks to RPC endpoints. The fixture implementation answers from memory, so the dashboard and
 * its tests run with no network.
 */
import { createPublicClient, defineChain, http, type Address, type Hash } from 'viem'
import type { FlowChainClient } from '../flow/transaction-flow'
import type { ChainConfig, PairConfig, TokenInfo } from '../model/types'
import { readChainSnapshot, readRewardAddress, type ChainSnapshotResult, type ReadClient, type RewardAddressReading } from './live-reads'

/** The RPC URL of a chain is not set. */
export class MissingRpcError extends Error {
  override readonly name = 'MissingRpcError'
}

/** The native balance of one address on each chain of the pair. Null means the chain could not be read. */
export interface NativeBalances {
  readonly first: bigint | null
  readonly second: bigint | null
}

/** What the chain access needs from the client of one chain: the reads and the transaction flow calls. */
export type RpcClient = ReadClient & FlowChainClient

/** Creates the client of one chain from its description and its RPC URL. A test passes a fake. */
export type RpcClientFactory = (chain: ChainConfig, url: string) => RpcClient

/** What the dashboard needs from the chains. */
export interface ChainAccess {
  /** `rpc` for real endpoints, `fixture` when nothing reaches a chain. */
  readonly mode: 'rpc' | 'fixture'
  /** Reads the account state of both chains. */
  readSnapshots(input: { account: Address; tokens: readonly TokenInfo[] }): Promise<readonly ChainSnapshotResult[]>
  /** The native balance of each address on both chains. A chain that cannot be read gives null. */
  nativeBalances(addresses: readonly Address[]): Promise<readonly NativeBalances[]>
  /** Reads the address that receives the tips of a fee router on a chain. It never throws. */
  readRewardAddress(input: { chainId: number; router: Address }): Promise<RewardAddressReading>
  /** The client for the transaction flow of a chain. It throws {@link MissingRpcError} when the URL is not set. */
  flowClient(chainId: number): FlowChainClient
}

/**
 * Creates chain access over RPC endpoints.
 *
 * @param pair The pair. Each chain names the environment variable of its RPC URL.
 * @param environment The environment that holds the URLs. They stay out of every file and every log.
 * @param createClient Creates the client of one chain. The default uses viem over HTTP.
 */
export function createRpcChainAccess(
  pair: PairConfig,
  environment: Record<string, string | undefined>,
  createClient: RpcClientFactory = createViemClient,
): ChainAccess {
  const clients = new Map<number, RpcClient>()

  function clientOf(chain: ChainConfig): RpcClient {
    const existing = clients.get(chain.chainId)
    if (existing !== undefined) return existing
    const url = environment[chain.rpcEnvironmentVariable]
    if (url === undefined || url === '') {
      throw new MissingRpcError(`Set ${chain.rpcEnvironmentVariable} to the RPC URL of ${chain.name}.`)
    }
    const created = createClient(chain, url)
    clients.set(chain.chainId, created)
    return created
  }

  function chainById(chainId: number): ChainConfig {
    const chain = [pair.first, pair.second].find((candidate) => candidate.chainId === chainId)
    if (chain === undefined) throw new Error(`Chain ${chainId} is not in pair ${pair.id}.`)
    return chain
  }

  return {
    mode: 'rpc',
    async readSnapshots({ account, tokens }) {
      return Promise.all(
        [pair.first, pair.second].map(async (chain): Promise<ChainSnapshotResult> => {
          try {
            return await readChainSnapshot(clientOf(chain), { chain, account, tokens })
          } catch (error) {
            return { status: 'error', chain, message: error instanceof Error ? error.message : String(error) }
          }
        }),
      )
    },
    async nativeBalances(addresses) {
      const balanceOn = async (chain: ChainConfig, address: Address): Promise<bigint | null> => {
        try {
          return await clientOf(chain).getBalance({ address })
        } catch {
          return null
        }
      }
      return Promise.all(
        addresses.map(async (address) => ({
          first: await balanceOn(pair.first, address),
          second: await balanceOn(pair.second, address),
        })),
      )
    },
    async readRewardAddress({ chainId, router }) {
      try {
        return await readRewardAddress(clientOf(chainById(chainId)), { router })
      } catch (error) {
        return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) }
      }
    },
    flowClient(chainId) {
      return clientOf(chainById(chainId))
    },
  }
}

/** The default client factory: a viem public client over HTTP with batched multicall. It opens no connection until a call. */
function createViemClient(chain: ChainConfig, url: string): RpcClient {
  const client = createPublicClient({
    chain: defineChain({
      id: chain.chainId,
      name: chain.name,
      nativeCurrency: { name: chain.nativeSymbol, symbol: chain.nativeSymbol, decimals: 18 },
      rpcUrls: { default: { http: [url] } },
    }),
    transport: http(url),
    batch: { multicall: true },
  })
  // The viem client has the methods of both interfaces. Its own types are wider than the two narrow interfaces.
  return client as unknown as RpcClient
}

/** A fake hash for fixture sends. */
export const FIXTURE_TRANSACTION_HASH: Hash = `0x${'f1'.repeat(32)}`
