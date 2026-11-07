/**
 * Access to the chains for the dashboard: reads of the account state and the clients that the transaction flow uses.
 * One implementation talks to RPC endpoints. The fixture implementation answers from memory, so the dashboard and
 * its tests run with no network.
 */
import { createPublicClient, type Address, type Hash } from 'viem'
import type { FlowChainClient } from '../flow/transaction-flow'
import type { ChainConfig, PairConfig, TokenInfo } from '../model/types'
import { buildRpcTransport, CLIENT_BATCH, rpcChain } from './rpc-transport'
import { readChainSnapshot, readRouterAddresses, type ChainSnapshotResult, type ReadClient, type RouterAddressesReading } from './live-reads'

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

/**
 * Creates the client of one chain from its description and its RPC URL. A test passes a fake. `balanced` (the default)
 * spreads reads over the endpoints; `sticky` stays on one endpoint, for the transaction flow (see `rpc-transport.ts`).
 */
export type RpcClientFactory = (chain: ChainConfig, url: string, mode?: 'balanced' | 'sticky') => RpcClient

/** What the dashboard needs from the chains. */
export interface ChainAccess {
  /** `rpc` for real endpoints, `fixture` when nothing reaches a chain. */
  readonly mode: 'rpc' | 'fixture'
  /** Reads the account state of both chains. */
  readSnapshots(input: { account: Address; tokens: readonly TokenInfo[] }): Promise<readonly ChainSnapshotResult[]>
  /** The native balance of each address on both chains. A chain that cannot be read gives null. */
  nativeBalances(addresses: readonly Address[]): Promise<readonly NativeBalances[]>
  /** Reads the reward address and the failed delivery address of a delivery router on a chain. It never throws. */
  readRouterAddresses(input: { chainId: number; router: Address }): Promise<RouterAddressesReading>
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
  const clients = new Map<string, RpcClient>()

  function clientOf(chain: ChainConfig, mode: 'balanced' | 'sticky' = 'balanced'): RpcClient {
    const clientKey = `${mode}:${chain.chainId}`
    const existing = clients.get(clientKey)
    if (existing !== undefined) return existing
    const url = environment[chain.rpcEnvironmentVariable]
    if (url === undefined || url === '') {
      throw new MissingRpcError(`Set ${chain.rpcEnvironmentVariable} to the RPC URL of ${chain.name}.`)
    }
    const created = mode === 'balanced' ? createClient(chain, url) : createClient(chain, url, mode)
    clients.set(clientKey, created)
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
    async readRouterAddresses({ chainId, router }) {
      try {
        return await readRouterAddresses(clientOf(chainById(chainId)), { router })
      } catch (error) {
        return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) }
      }
    },
    flowClient(chainId) {
      // One endpoint for a whole transaction sequence: the estimate after an approval must reach the node that saw the receipt.
      return clientOf(chainById(chainId), 'sticky')
    },
  }
}

/**
 * The default client factory: a viem public client over HTTP. A default valve.city URL has the public RPC behind it, calls
 * made together share one HTTP request, and reads fold into Multicall3 (see `rpc-transport.ts`). It opens no connection
 * until a call.
 */
function createViemClient(chain: ChainConfig, url: string, mode: 'balanced' | 'sticky' = 'balanced'): RpcClient {
  const client = createPublicClient({
    chain: rpcChain({ id: chain.chainId, name: chain.name, symbol: chain.nativeSymbol, rpcUrl: url }),
    transport: buildRpcTransport(url, { sticky: mode === 'sticky' }),
    batch: CLIENT_BATCH,
  })
  // The viem client has the methods of both interfaces. Its own types are wider than the two narrow interfaces.
  return client as unknown as RpcClient
}

/** A fake hash for fixture sends. */
export const FIXTURE_TRANSACTION_HASH: Hash = `0x${'f1'.repeat(32)}`
