/**
 * The one place that builds the RPC transport and the chain definition for every viem client the dapp creates (the
 * terminal chain access, the wagmi config, prices, custom tokens, Explore). Before this, only some of them had a
 * fallback, none of them batched, and the main read path sent one HTTP request per contract call to the valve.city demo key,
 * which answered 429 to more than half of them.
 *
 * What it does:
 * - A chain's default list (rpc.zkb.fi, then the public RPCs) is one pool. A URL the user or the build chose is used alone.
 * - JSON-RPC requests made close together go out as one HTTP request (`batch`).
 * - {@link rpcChain} sets Multicall3 on the chain, so viem folds many `readContract` calls into one `aggregate3` call.
 * - Retries are modest and happen in one layer: inside the pool every endpoint is tried once (moving on is the retry), and
 *   a lone endpoint retries twice with viem's growing delay.
 *
 * The first endpoint, then the fallbacks. Until 2026-11-14 every endpoint of the pool was a shared quota (the valve.city
 * demo key and the public RPCs), so the owner asked to load balance across them ("we should be load balancing across
 * them") and reads went round-robin. The first endpoint is now rpc.zkb.fi, which reads through the server's own key
 * (docs/rpc-proxy.md), so it takes every read while it is available: spreading reads over the public RPCs would bring
 * back the 429s it removes. The public RPCs are the fallbacks, and they still take turns among themselves: requests made
 * in the same burst (within the batch window) go to the same fallback, so batching and multicall still make one HTTP
 * request per burst, and the next burst goes to the next one. An endpoint that answers 429, a 5xx, times out or cannot be
 * reached is benched for {@link BENCH_MILLISECONDS}: its requests go to the others at once, without sending anything to
 * it, and it rejoins afterwards. The bench is shared by every client in the page. A JSON-RPC answer (a revert, an invalid
 * argument) is the node's answer and is not retried elsewhere, with one exception: a request that rpc.zkb.fi refuses
 * (it serves only the dapp's reads, {@link isRefusedByZkbRpc}) goes to the next endpoint at once, and rpc.zkb.fi is not
 * benched for it. viem's `fallback({ rank: true })` was not used: it pings every endpoint in the background, which is
 * extra traffic against the same quotas, and it ranks by speed, not by what an endpoint accepts.
 *
 * Sticky mode, for the transaction path (`sticky: true`). A node that has not seen the block of an approval yet reverts the
 * estimate of the next step ("Execution reverted for an unknown reason" in Estimate Gas Arguments). So the client the
 * transaction flow uses stays on one endpoint: the receipt of a send and the estimate after it come from the same node. It
 * leaves that endpoint only when the endpoint is benched, and then stays on the next one.
 */
import { createTransport, defineChain, http, type Chain, type Transport } from 'viem'
import { DEFAULT_RPC_CHAIN_IDS, defaultRpcUrls, publicRpcUrls } from '../config/default-rpc'

/** Multicall3 has this address on every chain below (Ethereum, PulseChain, Sepolia, PulseChain testnet v4). */
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11'

/** How long an endpoint that failed (429, 5xx, timeout, unreachable) is left out of the pool. */
export const BENCH_MILLISECONDS = 30_000

/** Requests made within this long of each other share one HTTP request (JSON-RPC batch) or one aggregate3 call. */
export const BATCH_WAIT_MILLISECONDS = 20

const BATCH_SIZE = 50

/** Chains where Multicall3 is deployed at the standard address. Checked with eth_getCode on 11155111 and 943. */
const MULTICALL3_CHAIN_IDS: readonly number[] = [1, 369, 11155111, 943]

/** The `batch` option for a viem client: fold concurrent `readContract` calls into one `aggregate3` call. */
export const CLIENT_BATCH = { multicall: { wait: BATCH_WAIT_MILLISECONDS } } as const

/**
 * Defines a chain for a viem client, with Multicall3 set where it is deployed so that batched reads work. When the URL is
 * the chain's default (rpc.zkb.fi), the chain names the public RPCs instead: a wallet that adds the chain
 * (`wallet_addEthereumChain`) takes them from here and sends its transactions there, and rpc.zkb.fi serves reads only.
 * The clients of the page read through their transport, which keeps rpc.zkb.fi first.
 */
export function rpcChain(input: { id: number; name: string; symbol: string; rpcUrl?: string }): Chain {
  const isDefault = input.rpcUrl !== undefined && defaultRpcUrls(input.id)[0] === input.rpcUrl
  const http = input.rpcUrl === undefined ? [] : isDefault ? [...publicRpcUrls(input.id)] : [input.rpcUrl]
  return defineChain({
    id: input.id,
    name: input.name,
    nativeCurrency: { name: input.symbol, symbol: input.symbol, decimals: 18 },
    rpcUrls: { default: { http } },
    ...(MULTICALL3_CHAIN_IDS.includes(input.id) ? { contracts: { multicall3: { address: MULTICALL3_ADDRESS as `0x${string}` } } } : {}),
  })
}

/** Whether an error, or what caused it, is a rate limit answer (HTTP 429 or JSON-RPC code -32005). */
export function isRateLimited(error: unknown): boolean {
  return causeChain(error).some((link) => link.status === 429 || link.code === -32005)
}

type Link = { status?: unknown; code?: unknown; name?: unknown; message?: unknown; details?: unknown }

/** The error and its causes, outermost first. */
function causeChain(error: unknown): Link[] {
  const links: Link[] = []
  for (let current: unknown = error; current !== null && typeof current === 'object' && links.length < 6; current = (current as { cause?: unknown }).cause) {
    links.push(current as Link)
  }
  return links
}

/**
 * Whether rpc.zkb.fi refused the request: it serves only the dapp's reads around zkb.fi contracts, and answers anything
 * else with a JSON-RPC error whose message starts "rpc.zkb.fi refused" (docs/rpc-proxy.md). Another endpoint may serve it.
 */
export function isRefusedByZkbRpc(error: unknown): boolean {
  return causeChain(error).some((link) => [link.details, link.message].some((text) => typeof text === 'string' && text.includes('rpc.zkb.fi refused')))
}

/**
 * Whether the endpoint is at fault and not the call: a rate limit, a server error, a timeout, or no answer at all.
 * A JSON-RPC error (a revert, a bad argument) is the answer of a working node.
 */
export function isEndpointFailure(error: unknown): boolean {
  if (isRateLimited(error)) return true
  return causeChain(error).some(
    (link) => (typeof link.status === 'number' && link.status >= 500) || link.name === 'TimeoutError' || (link.name === 'HttpRequestError' && typeof link.status !== 'number'),
  )
}

/** When each URL may be used again after it failed. Shared by every client in the page, so they all back off together. */
const benchedUntil = new Map<string, number>()

/** Where the next burst goes, per pool. Shared, so separate clients of one chain also take turns. */
const nextEndpoint = new Map<string, number>()

/** Clears the bench and the turns. For tests. */
export function resetEndpointState(): void {
  benchedUntil.clear()
  nextEndpoint.clear()
}

/** Options of {@link buildRpcTransport}. */
export interface RpcTransportOptions {
  /** Stay on one endpoint until it fails. For the transaction path. */
  readonly sticky?: boolean
  /** A clock, for tests. */
  readonly now?: () => number
}

const batching = { batchSize: BATCH_SIZE, wait: BATCH_WAIT_MILLISECONDS }

/** A pool of endpoints as one transport. See the header of this file. */
function pooled(urls: readonly string[], options: RpcTransportOptions): Transport {
  const now = options.now ?? Date.now
  const poolKey = urls[0] as string
  return (parameters) => {
    const endpoints = urls.map((url) => http(url, { batch: batching, retryCount: 0 })({ ...parameters, retryCount: 0 }))
    // Requests of one burst use the endpoint of the burst. A burst ends when none came for the batch window.
    let burstEndpoint = -1
    let lastRequestAt = Number.NEGATIVE_INFINITY
    let stuckTo = 0

    const available = (index: number) => (benchedUntil.get(urls[index] as string) ?? 0) <= now()

    const order = (): number[] => {
      const all = urls.map((_, index) => index)
      if (options.sticky === true) {
        if (!available(stuckTo)) stuckTo = all.find(available) ?? stuckTo
        return [stuckTo, ...all.filter((index) => index !== stuckTo && available(index)), ...all.filter((index) => index !== stuckTo && !available(index))]
      }
      // The fallbacks take turns by burst; the first endpoint goes before them while it is available.
      const fallbacks = all.slice(1)
      const at = now()
      if (burstEndpoint < 0 || at - lastRequestAt > BATCH_WAIT_MILLISECONDS * 2 || !available(burstEndpoint)) {
        const turn = nextEndpoint.get(poolKey) ?? 0
        const offsets = fallbacks.map((_, offset) => (turn + offset) % fallbacks.length)
        const chosen = offsets.find((offset) => available(fallbacks[offset] as number)) ?? turn % fallbacks.length
        burstEndpoint = fallbacks[chosen] as number
        nextEndpoint.set(poolKey, (chosen + 1) % fallbacks.length)
      }
      lastRequestAt = at
      const start = fallbacks.indexOf(burstEndpoint)
      const rotated = fallbacks.map((_, offset) => fallbacks[(start + offset) % fallbacks.length] as number)
      const ready = rotated.filter(available)
      const benched = rotated.filter((index) => !available(index))
      return available(0) ? [0, ...ready, ...benched] : [...ready, 0, ...benched]
    }

    return createTransport(
      {
        key: 'pool',
        name: 'Pool of RPC endpoints',
        type: 'pool',
        retryCount: 0,
        timeout: parameters.timeout,
        async request(args: unknown) {
          let lastError: unknown
          for (const index of order()) {
            // Benched endpoints come last in the order, so they are tried only when every other one failed.
            try {
              return await (endpoints[index] as ReturnType<ReturnType<typeof http>>).request(args as never)
            } catch (error) {
              lastError = error
              // A refusal of rpc.zkb.fi: the next endpoint may serve the request, and rpc.zkb.fi stays in the pool.
              if (isRefusedByZkbRpc(error)) continue
              if (!isEndpointFailure(error)) throw error
              benchedUntil.set(urls[index] as string, now() + BENCH_MILLISECONDS)
            }
          }
          throw lastError
        },
      } as never,
      {},
    ) as ReturnType<Transport>
  }
}

/**
 * The transport for an RPC URL.
 *
 * @param url The RPC URL, or undefined for viem's own default.
 * @param options Sticky mode and a clock for tests.
 */
export function buildRpcTransport(url: string | undefined, options: RpcTransportOptions = {}): Transport {
  if (url === undefined) return http(undefined, { batch: batching })
  const chainId = DEFAULT_RPC_CHAIN_IDS.find((id) => defaultRpcUrls(id)[0] === url)
  if (chainId === undefined) return http(url, { batch: batching, retryCount: 2 })
  return pooled(defaultRpcUrls(chainId), options)
}
