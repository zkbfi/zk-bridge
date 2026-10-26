/**
 * The tests of the Prover setup view: each sends one small request and reports what came back. Every message is
 * redacted, so a key in a URL or a header never reaches the screen or a log.
 *
 * No test starts a proof. The proof test sends a request that the worker must refuse before it proves anything.
 */
import { redactError } from '@zk-bridge/shared/config'
import { describeStatus, failOutcome, fetchClient, passOutcome, testRpcChainId } from '@zk-bridge/shared'
import type { HttpClient, HttpRequest, HttpResponse, TestOutcome } from '@zk-bridge/shared'

export { fetchClient, testRpcChainId }
export type { HttpClient, HttpRequest, HttpResponse, TestOutcome }

/**
 * `GET /ping` on the RunPod endpoint. 200 means the worker is ready and 204 means it is starting.
 */
export async function testEndpointPing(http: HttpClient, input: { endpointUrl: string; apiKey: string }): Promise<TestOutcome> {
  const secrets = [input.apiKey]
  try {
    const response = await http({ url: `${input.endpointUrl.replace(/\/$/, '')}/ping`, method: 'GET', headers: { Authorization: `Bearer ${input.apiKey}` } })
    if (response.status === 200) return passOutcome('The worker answers /ping with 200: ready.')
    if (response.status === 204) return passOutcome('The worker answers /ping with 204: it is starting. Try again in a minute.')
    return failOutcome(describeStatus(response, 'the ping'), secrets)
  } catch (error) {
    return failOutcome(`The ping did not complete: ${redactError(error, secrets)}`, secrets)
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
    if (response.status === 400) return passOutcome('The worker refused the empty request with 400, as it should. No proof ran.')
    if (response.status === 200) return failOutcome('The worker returned a proof for an empty request. That is not expected: check the endpoint.', secrets)
    return failOutcome(describeStatus(response, 'the dry request'), secrets)
  } catch (error) {
    return failOutcome(`The request did not complete: ${redactError(error, secrets)}`, secrets)
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
    if (response.status !== 200) return failOutcome(describeStatus(response, 'msgboard_status'), secrets)
    const answer = JSON.parse(response.text) as { result?: unknown; error?: { message?: string } }
    if (answer.error !== undefined) return failOutcome(`msgboard_status returned an error: ${answer.error.message ?? 'unknown'}`, secrets)
    return passOutcome('msgboard_status answered.')
  } catch (error) {
    return failOutcome(`msgboard_status did not complete: ${redactError(error, secrets)}`, secrets)
  }
}
