import { afterEach, describe, expect, test } from 'bun:test'
import { createPublicClient, type Address } from 'viem'
import { defaultRpcUrls } from '../../src/config/default-rpc'
import {
  MULTICALL3_ADDRESS,
  BENCH_MILLISECONDS,
  buildRpcTransport,
  isRateLimited,
  resetEndpointState,
  rpcChain,
} from '../../src/chain/rpc-transport'
import { readChainSnapshot, type ReadClient } from '../../src/chain/live-reads'
import { FIXTURE_PAIR, FIXTURE_TOKENS } from '../../src/data/fixtures'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  resetEndpointState()
})

/** Replaces fetch: answers each request from `answer(host, calls)` and records the host and JSON-RPC methods. */
function fakeFetch(answer: (host: string) => Response) {
  const requests: { host: string; methods: string[] }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const host = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).host
    const body = JSON.parse(String(init?.body))
    const calls = Array.isArray(body) ? body : [body]
    requests.push({ host, methods: calls.map((call: { method: string }) => call.method) })
    const response = answer(host)
    if (response.status !== 200) return response
    if ((await response.clone().text()) === 'revert') {
      const errors = calls.map((call: { id: number }) => ({ jsonrpc: '2.0', id: call.id, error: { code: 3, message: 'execution reverted' } }))
      return new Response(JSON.stringify(Array.isArray(body) ? errors : errors[0]), { status: 200 })
    }
    const results = calls.map((call: { id: number }) => ({ jsonrpc: '2.0', id: call.id, result: '0x1' }))
    return new Response(JSON.stringify(Array.isArray(body) ? results : results[0]), { status: 200 })
  }) as typeof fetch
  return requests
}

const sepolia = defaultRpcUrls(11155111)
const hosts = sepolia.map((url) => new URL(url).host)
const [valveHost, publicHost] = hosts as [string, string]
const pulse = defaultRpcUrls(943)

describe('rpcChain', () => {
  test('sets Multicall3 on each supported chain and not on an unknown one', () => {
    for (const id of [1, 369, 11155111, 943]) expect(rpcChain({ id, name: 'x', symbol: 'X' }).contracts?.multicall3?.address).toBe(MULTICALL3_ADDRESS)
    expect(rpcChain({ id: 31337, name: 'x', symbol: 'X' }).contracts).toBeUndefined()
  })
})

/** A clock that moves 100 ms each time it is read, so every request is its own burst. */
function steppingClock() {
  let t = 1_000
  return () => (t += 100)
}

describe('default lists', () => {
  test('valve first, then the public RPCs and publicnode', () => {
    expect(defaultRpcUrls(369).slice(1)).toEqual(['https://rpc.pulsechain.com', 'https://pulsechain-rpc.publicnode.com'])
    expect(defaultRpcUrls(943).slice(1)).toEqual(['https://rpc.v4.testnet.pulsechain.com', 'https://pulsechain-testnet-rpc.publicnode.com'])
    expect(defaultRpcUrls(1).slice(1)).toEqual(['https://ethereum-rpc.publicnode.com'])
  })
})

describe('buildRpcTransport', () => {
  test('a default valve URL is a pool; a chosen URL stays alone', () => {
    expect(buildRpcTransport(sepolia[0])({ retryCount: 0 }).config.type).toBe('pool')
    expect(buildRpcTransport('https://example.org/rpc')({ retryCount: 0 }).config.type).toBe('http')
  })

  test('separate requests are spread round-robin over every endpoint of the pool', async () => {
    const requests = fakeFetch(() => new Response('', { status: 200 }))
    const transport = buildRpcTransport(pulse[0], { now: steppingClock() })({ retryCount: 0 })
    for (let index = 0; index < 6; index += 1) await transport.request({ method: 'eth_chainId' })
    const seen = requests.map((request) => request.host)
    expect(new Set(seen).size).toBe(3)
    expect(seen.slice(0, 3)).toEqual(pulse.map((url) => new URL(url).host))
    expect(seen.slice(3)).toEqual(seen.slice(0, 3))
  })

  test('calls made together are one HTTP request to one endpoint', async () => {
    const requests = fakeFetch(() => new Response('', { status: 200 }))
    const client = createPublicClient({ transport: buildRpcTransport(sepolia[0]) })
    await Promise.all([client.getChainId(), client.getBlockNumber(), client.getGasPrice()])
    expect(requests).toHaveLength(1)
    expect(requests[0]!.methods).toHaveLength(3)
  })

  test('a 429 benches the endpoint: the call moves on and the endpoint gets nothing until the bench ends', async () => {
    let clock = 1_000
    const tick = () => (clock += 100)
    const requests = fakeFetch((host) => (host === valveHost ? new Response('slow down', { status: 429 }) : new Response('', { status: 200 })))
    const transport = buildRpcTransport(sepolia[0], { now: tick })({ retryCount: 0 })
    await transport.request({ method: 'eth_chainId' })
    expect(requests.map((request) => request.host)).toEqual([valveHost, publicHost])
    for (let index = 0; index < 3; index += 1) await transport.request({ method: 'eth_chainId' })
    expect(requests.slice(2).map((request) => request.host)).toEqual([publicHost, publicHost, publicHost])
    clock += BENCH_MILLISECONDS + 1_000
    await transport.request({ method: 'eth_chainId' })
    // The endpoint is tried again (and answers 429 again in this fake, so the call moves on once more).
    expect(requests.slice(-2).map((request) => request.host)).toEqual([valveHost, publicHost])
  })

  test('a server error or an unreachable endpoint is benched too', async () => {
    const requests = fakeFetch((host) => (host === valveHost ? new Response('bad gateway', { status: 502 }) : new Response('', { status: 200 })))
    const transport = buildRpcTransport(sepolia[0], { now: steppingClock() })({ retryCount: 0 })
    await transport.request({ method: 'eth_chainId' })
    await transport.request({ method: 'eth_chainId' })
    expect(requests.filter((request) => request.host === valveHost)).toHaveLength(1)
  })

  test('a revert is the node answer: it is not tried on another endpoint', async () => {
    const requests = fakeFetch(() => new Response('revert', { status: 200 }))
    const transport = buildRpcTransport(sepolia[0], { now: steppingClock() })({ retryCount: 0 })
    await expect(transport.request({ method: 'eth_estimateGas' })).rejects.toThrow()
    expect(requests).toHaveLength(1)
  })

  test('when every endpoint fails the error is thrown', async () => {
    fakeFetch(() => new Response('slow down', { status: 429 }))
    const transport = buildRpcTransport(sepolia[0], { now: steppingClock() })({ retryCount: 0 })
    await expect(transport.request({ method: 'eth_chainId' })).rejects.toThrow()
  })

  test('a chosen URL that answers 429 is not sent to another host', async () => {
    const requests = fakeFetch(() => new Response('slow down', { status: 429 }))
    const transport = buildRpcTransport('https://example.org/rpc')({ retryCount: 0 })
    await expect(transport.request({ method: 'eth_chainId' })).rejects.toThrow()
    expect(new Set(requests.map((request) => request.host))).toEqual(new Set(['example.org']))
  })

  test('sticky mode stays on one endpoint request after request, and leaves it only when it fails', async () => {
    let valveDown = false
    const requests = fakeFetch((host) => (host === valveHost && valveDown ? new Response('x', { status: 503 }) : new Response('', { status: 200 })))
    const transport = buildRpcTransport(sepolia[0], { sticky: true, now: steppingClock() })({ retryCount: 0 })
    for (let index = 0; index < 4; index += 1) await transport.request({ method: 'eth_chainId' })
    expect(new Set(requests.map((request) => request.host))).toEqual(new Set([valveHost]))
    valveDown = true
    for (let index = 0; index < 3; index += 1) await transport.request({ method: 'eth_chainId' })
    expect(requests.slice(4).map((request) => request.host)).toEqual([valveHost, publicHost, publicHost, publicHost])
  })
})

describe('isRateLimited', () => {
  test('finds a 429 or code -32005 in the error or its causes', () => {
    expect(isRateLimited({ status: 429 })).toBe(true)
    expect(isRateLimited({ cause: { cause: { code: -32005 } } })).toBe(true)
    expect(isRateLimited(new Error('x'))).toBe(false)
  })
})

describe('request count of a snapshot poll', () => {
  const chain = FIXTURE_PAIR.first
  const account: Address = '0x00000000000000000000000000000000000000a9'
  const tokens = FIXTURE_TOKENS.filter((token) => token.side === chain.side)

  function countingClient(): ReadClient & { readonly reads: string[] } {
    const reads: string[] = []
    return {
      reads,
      async getBalance() {
        reads.push('getBalance')
        return 1n
      },
      async readContract({ functionName }) {
        reads.push(functionName)
        if (functionName === 'nativeTokenAddress') return '0x0000000000000000000000000000000000000000'
        if (functionName === 'isBridgedTokenDeployAcknowledged') return true
        return 5n
      },
    }
  }

  test('the second poll does not read the relay gas facts again', async () => {
    const client = countingClient()
    await readChainSnapshot(client, { chain, account, tokens })
    const first = client.reads.length
    expect(first).toBe(1 + tokens.length * 4)
    await readChainSnapshot(client, { chain, account, tokens })
    expect(client.reads.length - first).toBe(1 + tokens.length * 2)
    expect(client.reads.slice(first).filter((name) => name === 'nativeTokenAddress')).toHaveLength(0)
  })

  test('a failed fact read is read again on the next poll', async () => {
    let fail = true
    const client: ReadClient = {
      async getBalance() {
        return 1n
      },
      async readContract({ functionName }) {
        if (functionName === 'nativeTokenAddress') {
          if (fail) throw new Error('429')
          return '0x0000000000000000000000000000000000000001'
        }
        return 5n
      },
    }
    expect((await readChainSnapshot(client, { chain, account, tokens })).status).toBe('error')
    fail = false
    expect((await readChainSnapshot(client, { chain, account, tokens })).status).toBe('ok')
  })

  test('over a real viem client, N tokens are a handful of HTTP requests (multicall + batching)', async () => {
    const requests: string[][] = []
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      const calls = Array.isArray(body) ? body : [body]
      requests.push(calls.map((call: { method: string }) => call.method))
      const results = calls.map((call: { id: number; method: string; params: unknown[] }) => {
        let result = '0x1'
        if (call.method === 'eth_call') {
          // aggregate3 -> an array of N successful results, each a 32 byte word (0x..01)
          const data = (call.params[0] as { data: string }).data
          if (data.startsWith('0x82ad56cb')) result = aggregate3Answer(countCalls(data))
        }
        return { jsonrpc: '2.0', id: call.id, result }
      })
      return new Response(JSON.stringify(Array.isArray(body) ? results : results[0]), { status: 200 })
    }) as typeof fetch
    const { createPublicClient } = await import('viem')
    const { CLIENT_BATCH } = await import('../../src/chain/rpc-transport')
    const client = createPublicClient({
      chain: rpcChain({ id: chain.chainId, name: chain.name, symbol: chain.nativeSymbol }),
      transport: buildRpcTransport('https://example.org/rpc'),
      batch: CLIENT_BATCH,
    })
    const result = await readChainSnapshot(client as unknown as ReadClient, { chain, account, tokens })
    // Every token's balanceOf, allowance and nativeTokenAddress plus the native balance fold into one aggregate3 eth_call.
    // (The fake answers every token as a copy, so no second round is needed.)
    expect(result.status).toBe('ok')
    expect(requests).toEqual([['eth_call']])
  })
})

/** The number of calls in aggregate3 calldata, read from the array length word at offset 0x20 of the arguments. */
function countCalls(data: string): number {
  return Number(BigInt(`0x${data.slice(10 + 64, 10 + 128)}`))
}

/** An aggregate3 return value with `count` results, each success with a 32 byte value of 1. */
function aggregate3Answer(count: number): string {
  const word = (value: bigint) => value.toString(16).padStart(64, '0')
  const element = word(1n) + word(64n) + word(32n) + word(1n)
  const offsets: string[] = []
  const bodies: string[] = []
  let offset = count * 32
  for (let index = 0; index < count; index += 1) {
    offsets.push(word(BigInt(offset)))
    bodies.push(element)
    offset += element.length / 2
  }
  return `0x${word(32n)}${word(BigInt(count))}${offsets.join('')}${bodies.join('')}`
}
