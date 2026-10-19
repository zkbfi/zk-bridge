import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  http,
  type Account,
  type Chain,
  type HttpTransport,
  type PublicClient,
  type TestClient,
  type WalletClient,
} from 'viem'
import { CHAIN_A_ID, CHAIN_A_PORT, CHAIN_B_ID, CHAIN_B_PORT } from './constants.js'

/** Everything the harness needs to talk to one Anvil chain. */
export interface ChainHandle {
  /** Human name used in messages. */
  readonly name: 'chainA' | 'chainB'
  /** Label that seeds the committee keys, as in the build contract. */
  readonly committeeLabel: 'chainA' | 'chainB'
  readonly chainId: number
  readonly port: number
  readonly rpcUrl: string
  readonly chain: Chain
  readonly publicClient: PublicClient<HttpTransport, Chain>
  readonly testClient: TestClient<'anvil', HttpTransport, Chain>
}

const createChainHandle = (name: ChainHandle['name'], chainId: number, port: number): ChainHandle => {
  const rpcUrl = `http://127.0.0.1:${port}`
  const chain = defineChain({
    id: chainId,
    name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  })
  return {
    name,
    committeeLabel: name,
    chainId,
    port,
    rpcUrl,
    chain,
    publicClient: createPublicClient({ chain, transport: http(rpcUrl) }),
    testClient: createTestClient({ chain, mode: 'anvil', transport: http(rpcUrl) }),
  }
}

/** Chain A: the Ethereum role, chain id 1. */
export const chainA: ChainHandle = createChainHandle('chainA', CHAIN_A_ID, CHAIN_A_PORT)
/** Chain B: the PulseChain role, chain id 369. */
export const chainB: ChainHandle = createChainHandle('chainB', CHAIN_B_ID, CHAIN_B_PORT)

/** Both chains in a fixed order. */
export const bothChains: readonly [ChainHandle, ChainHandle] = [chainA, chainB]

/** Creates a wallet client that signs with the given account on the given chain. */
export const walletFor = (handle: ChainHandle, account: Account): WalletClient<HttpTransport, Chain, Account> =>
  createWalletClient({ account, chain: handle.chain, transport: http(handle.rpcUrl) })

/**
 * Sends a raw JSON-RPC request and returns the result.
 * @throws When the node answers with an error.
 */
export const rpcRequest = async (rpcUrl: string, method: string, params: readonly unknown[] = []): Promise<unknown> => {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = (await response.json()) as { result?: unknown; error?: { message: string } }
  if (body.error) throw new Error(`${method} failed: ${body.error.message}`)
  return body.result
}
