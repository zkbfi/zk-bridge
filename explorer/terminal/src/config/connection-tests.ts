/**
 * The tests of the Prover setup view: each sends one small request and reports what came back. Every message is
 * redacted, so a key in a URL or a header never reaches the screen or a log.
 *
 * No test starts a proof. The proof test sends a request that the worker must refuse before it proves anything.
 */
import { redactError, redactSecrets } from '@zk-bridge/shared/config'

/** One HTTP request. */
export interface HttpRequest {
  readonly url: string
  readonly method: 'GET' | 'POST'
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
}

/** One HTTP answer. */
export interface HttpResponse {
  readonly status: number
  readonly text: string
}

/** Sends a request. A test passes a fake. */
export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>

/** The outcome of one test. */
export interface TestOutcome {
  readonly ok: 'pass' | 'fail'
  /** One redacted sentence for the screen. */
  readonly message: string
}

/** The longest that a test waits, in milliseconds. */
const TIMEOUT_MILLISECONDS = 15_000

/** The HTTP client that uses `fetch`, with a time limit. */
export const fetchClient: HttpClient = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    ...(request.headers === undefined ? {} : { headers: { ...request.headers } }),
    ...(request.body === undefined ? {} : { body: request.body }),
    signal: AbortSignal.timeout(TIMEOUT_MILLISECONDS),
  })
  return { status: response.status, text: (await response.text()).slice(0, 2_000) }
}

function pass(message: string): TestOutcome {
  return { ok: 'pass', message }
}

function fail(message: string, secrets: readonly string[]): TestOutcome {
  return { ok: 'fail', message: redactSecrets(message, secrets) }
}

/**
 * `GET /ping` on the RunPod endpoint. 200 means the worker is ready and 204 means it is starting.
 */
export async function testEndpointPing(http: HttpClient, input: { endpointUrl: string; apiKey: string }): Promise<TestOutcome> {
  const secrets = [input.apiKey]
  try {
    const response = await http({ url: `${input.endpointUrl.replace(/\/$/, '')}/ping`, method: 'GET', headers: { Authorization: `Bearer ${input.apiKey}` } })
    if (response.status === 200) return pass('The worker answers /ping with 200: ready.')
    if (response.status === 204) return pass('The worker answers /ping with 204: it is starting. Try again in a minute.')
    return fail(describeStatus(response, 'the ping'), secrets)
  } catch (error) {
    return fail(`The ping did not complete: ${redactError(error, secrets)}`, secrets)
  }
}

/**
 * A dry proof request. It sends `POST /prove` with a program key of zeros. The worker refuses it with 400 before it
 * proves anything, which shows that the address, the key and the route work, and costs no GPU time.
 */
export async function testDryProofRequest(http: HttpClient, input: { endpointUrl: string; apiKey: string }): Promise<TestOutcome> {
  const secrets = [input.apiKey]
  const body = JSON.stringify({ programKey: `0x${'00'.repeat(32)}`, statementKind: 'lightClient', guestInput: '0x' })
  try {
    const response = await http({
      url: `${input.endpointUrl.replace(/\/$/, '')}/prove`,
      method: 'POST',
      headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
      body,
    })
    if (response.status === 400) return pass('The worker refused the empty request with 400, as it should. No proof ran.')
    if (response.status === 200) return fail('The worker returned a proof for an empty request. That is not expected: check the endpoint.', secrets)
    return fail(describeStatus(response, 'the dry request'), secrets)
  } catch (error) {
    return fail(`The request did not complete: ${redactError(error, secrets)}`, secrets)
  }
}

/** `eth_chainId` on an RPC URL. The answer must equal the chain that the setup names. */
export async function testRpcChainId(http: HttpClient, input: { rpcUrl: string; expectedChainId: number }): Promise<TestOutcome> {
  const secrets = [input.rpcUrl]
  try {
    const response = await http({
      url: input.rpcUrl,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    })
    if (response.status !== 200) return fail(describeStatus(response, 'eth_chainId'), secrets)
    const answer = JSON.parse(response.text) as { result?: unknown }
    if (typeof answer.result !== 'string') return fail('The node returned no chain identifier.', secrets)
    const found = Number.parseInt(answer.result, 16)
    if (found !== input.expectedChainId) return fail(`The node is on chain ${found}, not chain ${input.expectedChainId}.`, secrets)
    return pass(`The node reports chain ${found}.`)
  } catch (error) {
    return fail(`eth_chainId did not complete: ${redactError(error, secrets)}`, secrets)
  }
}

/** `msgboard_status` as a JSON-RPC call over HTTP. A WebSocket URL is tested with the same call through `socket`. */
export async function testMsgboardStatus(
  http: HttpClient,
  input: { url: string },
): Promise<TestOutcome> {
  const secrets = [input.url]
  const httpUrl = input.url.replace(/^ws(s?):\/\//, 'http$1://')
  try {
    const response = await http({
      url: httpUrl,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'msgboard_status', params: [] }),
    })
    if (response.status !== 200) return fail(describeStatus(response, 'msgboard_status'), secrets)
    const answer = JSON.parse(response.text) as { result?: unknown; error?: { message?: string } }
    if (answer.error !== undefined) return fail(`msgboard_status returned an error: ${answer.error.message ?? 'unknown'}`, secrets)
    return pass('msgboard_status answered.')
  } catch (error) {
    return fail(`msgboard_status did not complete: ${redactError(error, secrets)}`, secrets)
  }
}

function describeStatus(response: HttpResponse, what: string): string {
  if (response.status === 401 || response.status === 403) return `The server refused ${what} with ${response.status}: check the API key.`
  if (response.status === 404) return `The server answered ${what} with 404: check the address.`
  if (response.status === 503 || /no workers available/i.test(response.text)) return `No worker is available now (${response.status}). Wait for one to start.`
  return `The server answered ${what} with ${response.status}: ${response.text.slice(0, 120)}`
}
