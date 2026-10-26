import { afterEach, describe, expect, test } from 'bun:test'
import { fetchClient, testDryProofRequest, testEndpointPing, testMsgboardStatus, testRpcChainId, type HttpClient } from '../../src/config/connection-tests'

const API_KEY = 'rpa_TESTONLY1234567890abcdefghijkl'
const RPC_KEY = 'vk_TESTONLY0987654321zyxwvu'
const endpointUrl = 'https://abc123.api.runpod.ai'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

/** Replaces `fetch` and records the arguments of each call. */
function stubFetch(answer: Response) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return answer
  }) as unknown as typeof fetch
  return calls
}

/** An HTTP client that fails the way a dead network does, with the secret in the message. */
const unreachable =
  (secret: string): HttpClient =>
  async () => {
    throw new Error(`connect ECONNREFUSED ${secret}`)
  }

describe('fetchClient', () => {
  test('sends the method, the headers and the body, with a time limit, and returns the status and the text', async () => {
    const calls = stubFetch(new Response('hello', { status: 201 }))
    const result = await fetchClient({ url: 'http://x.test/a', method: 'POST', headers: { 'X-One': '1' }, body: '{"a":1}' })
    expect(result).toEqual({ status: 201, text: 'hello' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://x.test/a')
    expect(calls[0]!.init.method).toBe('POST')
    expect(calls[0]!.init.headers).toEqual({ 'X-One': '1' })
    expect(calls[0]!.init.body).toBe('{"a":1}')
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal)
  })

  test('leaves out the headers and the body when the request has none', async () => {
    const calls = stubFetch(new Response('', { status: 204 }))
    await fetchClient({ url: 'http://x.test/b', method: 'GET' })
    expect('headers' in calls[0]!.init).toBe(false)
    expect('body' in calls[0]!.init).toBe(false)
    expect(calls[0]!.init.method).toBe('GET')
  })

  test('keeps only the first 2000 characters of the text, so a large page cannot flood the screen', async () => {
    stubFetch(new Response('a'.repeat(2_500), { status: 200 }))
    const result = await fetchClient({ url: 'http://x.test/c', method: 'GET' })
    expect(result.text).toBe('a'.repeat(2_000))
  })
})

describe('a request that does not complete', () => {
  test('the ping reports the failure and redacts the key', async () => {
    const outcome = await testEndpointPing(unreachable(API_KEY), { endpointUrl, apiKey: API_KEY })
    expect(outcome.ok).toBe('fail')
    expect(outcome.message.startsWith('The ping did not complete: connect ECONNREFUSED')).toBe(true)
    expect(outcome.message).not.toContain(API_KEY)
  })

  test('the dry proof request reports the failure and redacts the key', async () => {
    const outcome = await testDryProofRequest(unreachable(API_KEY), { endpointUrl, apiKey: API_KEY })
    expect(outcome.ok).toBe('fail')
    expect(outcome.message.startsWith('The request did not complete: connect ECONNREFUSED')).toBe(true)
    expect(outcome.message).not.toContain(API_KEY)
  })

  test('the msgboard test reports the failure and redacts the keyed URL', async () => {
    const url = `https://one.valve.city/rpc/${RPC_KEY}/evm/369`
    const outcome = await testMsgboardStatus(unreachable(url), { url })
    expect(outcome.ok).toBe('fail')
    expect(outcome.message.startsWith('msgboard_status did not complete: connect ECONNREFUSED')).toBe(true)
    expect(outcome.message).not.toContain(RPC_KEY)
  })
})

describe('the wording of a refused status', () => {
  const answering = (status: number, text: string): HttpClient => async () => ({ status, text })

  test('403 points to the key and 404 points to the address', async () => {
    expect((await testEndpointPing(answering(403, ''), { endpointUrl, apiKey: API_KEY })).message).toBe('The server refused the ping with 403: check the API key.')
    expect((await testEndpointPing(answering(404, ''), { endpointUrl, apiKey: API_KEY })).message).toBe('The server answered the ping with 404: check the address.')
  })

  test('503, or a body that says no workers are available, reports that no worker is ready', async () => {
    expect((await testEndpointPing(answering(503, ''), { endpointUrl, apiKey: API_KEY })).message).toBe('No worker is available now (503). Wait for one to start.')
    expect((await testEndpointPing(answering(500, 'No Workers Available'), { endpointUrl, apiKey: API_KEY })).message).toBe('No worker is available now (500). Wait for one to start.')
  })

  test('any other status shows the status and the first 120 characters of the body', async () => {
    const outcome = await testEndpointPing(answering(500, 'x'.repeat(300)), { endpointUrl, apiKey: API_KEY })
    expect(outcome).toEqual({ ok: 'fail', message: `The server answered the ping with 500: ${'x'.repeat(120)}` })
  })

  test('the chain identifier test fails on a status that is not 200, and on an answer with no result', async () => {
    const input = { rpcUrl: 'https://rpc.test', expectedChainId: 1 }
    expect((await testRpcChainId(answering(502, 'bad'), input)).message).toBe('The server answered eth_chainId with 502: bad')
    expect(await testRpcChainId(answering(200, '{}'), input)).toEqual({ ok: 'fail', message: 'The node returned no chain identifier.' })
  })
})
