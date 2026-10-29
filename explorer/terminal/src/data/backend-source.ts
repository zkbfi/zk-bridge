/**
 * The reads of the terminal that the dapp also makes: the latest proof (the msgboard indexer first, the msgboard node
 * behind it), the evidence of a message (the archive), and the backend (proof requests and their status).
 *
 * Every endpoint is configured and never discovered. An endpoint with no setting is skipped, and the reading says so.
 * No text that this file returns holds a URL, because a URL can hold a key. A failure shows as a fixed phrase.
 */
import {
  fetchJsonResponse,
  tryDecodeProofMessage,
  proofCategory,
  type EndpointKey,
  type JsonFetcher,
  type ProofDirection,
  type ProofMessage,
  type ResolvedConnection,
} from '@zk-bridge/shared'
import { createBackendClient, type BackendClient } from '@zk-bridge/shared/backend-client'
import { postJsonResponse, readBoardMessages, type BoardJsonFetcher } from '@zk-bridge/shared/msgboard-http'
import type { Hex } from 'viem'

/** The two reads of the network that this file makes. A test passes fakes. */
export interface BackendTransport {
  readonly fetchJson: JsonFetcher
  /** Posts a JSON body. `postJsonResponse` of the msgboard code fits it. */
  readonly postJson: BoardJsonFetcher
}

/** The transport that uses `fetch`. */
export const realTransport: BackendTransport = { fetchJson: fetchJsonResponse, postJson: postJsonResponse }

/** The endpoints that this file reads: only the resolved URLs matter, so a test passes just these. */
export type EndpointSettings = Pick<ResolvedConnection, EndpointKey>

/** The place that a proof came from. */
export type ProofSource = 'msgboard indexer' | 'msgboard node'

/** What the search for the latest proof found. `notes` say, without any URL, why a source did not answer. */
export type LatestProofReading =
  | { readonly kind: 'found'; readonly source: ProofSource; readonly message: ProofMessage; readonly notes: readonly string[] }
  | { readonly kind: 'none'; readonly notes: readonly string[] }

const HASH = /^0x[0-9a-fA-F]{64}$/

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** A message that is for this pair and this direction. A proof for another route must never pass. */
const isForRoute = (message: ProofMessage, pair: string, direction: ProofDirection): boolean => message.pair === pair && message.direction === direction

type SourceAnswer =
  | { readonly kind: 'found'; readonly message: ProofMessage }
  | { readonly kind: 'missing'; readonly note: string }
  | { readonly kind: 'empty'; readonly note: string }

/** Reads `GET /proofs/latest/:direction` of the msgboard indexer. 404 is an answer: the indexer holds no usable proof. */
async function fromMsgboardIndexer(input: { readonly baseUrl: string; readonly pair: string; readonly direction: ProofDirection; readonly transport: BackendTransport }): Promise<SourceAnswer> {
  const prefix = 'The msgboard indexer'
  let response
  try {
    response = await input.transport.fetchJson(`${input.baseUrl}/proofs/latest/${input.direction}`)
  } catch {
    return { kind: 'missing', note: `${prefix} did not answer.` }
  }
  if (response.status === 404) return { kind: 'empty', note: `${prefix} holds no usable proof.` }
  if (response.status === 503) return { kind: 'missing', note: `${prefix} is not built on this backend.` }
  if (response.status !== 200) return { kind: 'missing', note: `${prefix} answered with status ${response.status}.` }
  const body = response.body
  const payload = isRecord(body) && typeof body.payload === 'string' ? body.payload : null
  if (payload === null) return { kind: 'missing', note: `${prefix} gave an answer of an unknown shape.` }
  const decoded = tryDecodeProofMessage(payload as Hex)
  if (!decoded.ok) return { kind: 'missing', note: `${prefix} gave a proof that does not decode (${decoded.reason}).` }
  if (!isForRoute(decoded.message, input.pair, input.direction)) return { kind: 'missing', note: `${prefix} gave a proof for another route.` }
  return { kind: 'found', message: decoded.message }
}

/**
 * Reads the proofs now on the msgboard node and keeps the best one: the proof that starts at the stored head of the
 * destination chain and reaches furthest. When the head is unknown, the proof that reaches furthest wins.
 */
async function fromMsgboardNode(input: { readonly baseUrl: string; readonly pair: string; readonly direction: ProofDirection; readonly headSlot: bigint | null; readonly transport: BackendTransport }): Promise<SourceAnswer> {
  const prefix = 'The msgboard node'
  let messages
  try {
    messages = await readBoardMessages({ boardUrl: input.baseUrl, category: proofCategory(input.pair, input.direction), fetchJson: input.transport.postJson })
  } catch {
    return { kind: 'missing', note: `${prefix} did not give its messages.` }
  }
  const proofs = messages
    .map((message) => tryDecodeProofMessage(message.data))
    .flatMap((result) => (result.ok && isForRoute(result.message, input.pair, input.direction) ? [result.message] : []))
  const atHead = proofs.filter((proof) => input.headSlot === null || proof.startSlot === input.headSlot)
  const best = atHead.reduce<ProofMessage | null>((current, proof) => (current === null || proof.newSlot > current.newSlot ? proof : current), null)
  if (best === null) return { kind: 'empty', note: `${prefix} holds no proof that starts at the stored head.` }
  return { kind: 'found', message: best }
}

/**
 * Finds the latest proof of a direction. The msgboard indexer answers first. When it is not set, does not answer, or is
 * not built, the msgboard node answers. An answer of "no usable proof" from a working indexer ends the search, because
 * the indexer drops a proof once the head moves past it, and the board may still hold an old one.
 *
 * @param input The endpoints in force, the pair name, the direction, the stored head slot of the destination chain
 * (null when unknown) and the transport.
 */
export async function readLatestProof(input: {
  readonly endpoints: EndpointSettings
  readonly pair: string
  readonly direction: ProofDirection
  readonly headSlot: bigint | null
  readonly transport: BackendTransport
}): Promise<LatestProofReading> {
  const notes: string[] = []
  const indexer = input.endpoints.msgboardIndexerUrl
  if (indexer === null) notes.push('No msgboard indexer is set.')
  if (indexer !== null) {
    const answer = await fromMsgboardIndexer({ baseUrl: indexer.value, pair: input.pair, direction: input.direction, transport: input.transport })
    if (answer.kind === 'found') return { kind: 'found', source: 'msgboard indexer', message: answer.message, notes }
    notes.push(answer.note)
    if (answer.kind === 'empty') return { kind: 'none', notes }
  }
  const node = input.endpoints.msgboardUrl
  if (node === null) return { kind: 'none', notes: [...notes, 'No msgboard node is set.'] }
  const answer = await fromMsgboardNode({ baseUrl: node.value, pair: input.pair, direction: input.direction, headSlot: input.headSlot, transport: input.transport })
  if (answer.kind === 'found') return { kind: 'found', source: 'msgboard node', message: answer.message, notes }
  return { kind: 'none', notes: [...notes, answer.note] }
}

/** What the archive gave for a message. `text` is the JSON of the evidence, as the planner reads it. */
export type EvidenceReading = { readonly kind: 'found'; readonly text: string } | { readonly kind: 'none'; readonly note: string }

/**
 * Asks the archive for the evidence of a message. A 404 means the archive holds none. A 503 means the archive is not
 * built. The evidence text is not checked here: the operator planner checks it against the chains of the pair.
 *
 * @param input The endpoints in force, the message identifier and the transport.
 */
export async function readEvidence(input: { readonly endpoints: EndpointSettings; readonly messageId: string; readonly transport: BackendTransport }): Promise<EvidenceReading> {
  const archive = input.endpoints.archiveUrl
  if (archive === null) return { kind: 'none', note: 'No archive is set. Set it in Connections.' }
  const messageId = input.messageId.trim()
  if (!HASH.test(messageId)) return { kind: 'none', note: 'A message identifier is 0x and 64 hex digits.' }
  let response
  try {
    response = await input.transport.fetchJson(`${archive.value}/evidence/${messageId}`)
  } catch {
    return { kind: 'none', note: 'The archive did not answer.' }
  }
  if (response.status === 404) return { kind: 'none', note: 'The archive holds no evidence for this message.' }
  if (response.status === 503) return { kind: 'none', note: 'The archive is not built on this backend.' }
  if (response.status !== 200 || !isRecord(response.body)) return { kind: 'none', note: `The archive answered with status ${response.status}.` }
  return { kind: 'found', text: JSON.stringify(response.body) }
}

/**
 * A client for the backend, or null when no backend is set.
 *
 * @param endpoints The endpoints in force.
 * @param transport The transport.
 */
export function backendClientOf(endpoints: EndpointSettings, transport: BackendTransport): BackendClient | null {
  const backend = endpoints.backendUrl
  if (backend === null) return null
  return createBackendClient({ baseUrl: backend.value, fetchJson: transport.fetchJson, postJson: transport.postJson })
}

/** The job of a direction as the panel shows it: the status word, or the reason that none shows. */
export type DirectionJob = { readonly kind: 'job'; readonly status: string; readonly error: string | null } | { readonly kind: 'idle' } | { readonly kind: 'unknown'; readonly note: string }

/**
 * The newest job of a direction. A failure is a value, so one direction that fails does not hide the other.
 *
 * @param client The backend client, or null when no backend is set.
 * @param direction The direction.
 */
export async function readDirectionJob(client: BackendClient | null, direction: ProofDirection): Promise<DirectionJob> {
  if (client === null) return { kind: 'unknown', note: 'No backend is set.' }
  try {
    const answer = await client.directionStatus(direction)
    return answer.job === null ? { kind: 'idle' } : { kind: 'job', status: answer.job.status, error: answer.job.error }
  } catch {
    return { kind: 'unknown', note: 'The backend did not give the job status.' }
  }
}
