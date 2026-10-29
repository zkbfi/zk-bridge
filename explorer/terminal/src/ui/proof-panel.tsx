/**
 * The proof panel: the latest proof of each direction, the backend job behind it, a request for a new proof, and the
 * evidence of a message. It reads what the dapp reads. The msgboard indexer answers first, the msgboard node behind it.
 * The panel holds no secret. It never shows an endpoint, because an endpoint can hold a key.
 */
import { useState } from 'react'
import { PROOF_DIRECTIONS, type ProofDirection, type ResolvedConnection } from '@zk-bridge/shared'
import { useServices } from '../app/services'
import {
  backendClientOf,
  readDirectionJob,
  readEvidence,
  readLatestProof,
  realTransport,
  type BackendTransport,
  type DirectionJob,
  type EndpointSettings,
  type LatestProofReading,
} from '../data/backend-source'
import type { FlowStep } from '../flow/transaction-flow'
import type { PairConfig } from '../model/types'
import { OperatorFileError, planMessageExecution, planProofMessageUpdate } from '../tx/operator'
import { FormView, useForm } from './form-view'
import { useKeyLayer } from './key-router'
import { ModalFrame } from './modals'
import { wrapped } from './prove-view'
import { RichLine, colored, muted, plain, strong, type Line } from './rich-text'
import { theme } from './theme'
import { usePolling } from './use-polling'

/** How often the panel reads again, in milliseconds. */
const REFRESH_MILLISECONDS = 5_000

const NO_ENDPOINTS: EndpointSettings = { backendUrl: null, msgboardIndexerUrl: null, archiveUrl: null, msgboardUrl: null }

/** The endpoints in force, or none in fixture mode. */
const endpointsOf = (resolved: ResolvedConnection | null): EndpointSettings =>
  resolved === null
    ? NO_ENDPOINTS
    : { backendUrl: resolved.backendUrl, msgboardIndexerUrl: resolved.msgboardIndexerUrl, archiveUrl: resolved.archiveUrl, msgboardUrl: resolved.msgboardUrl }

/** What the panel shows for one direction. */
export interface DirectionRow {
  readonly direction: ProofDirection
  readonly reading: LatestProofReading
  readonly job: DirectionJob
}

/** The words for a direction: the source chain, then the destination chain. */
export function directionLabel(pair: PairConfig, direction: ProofDirection): string {
  return direction === 'first-to-second' ? `${pair.first.name} to ${pair.second.name}` : `${pair.second.name} to ${pair.first.name}`
}

/** The lines of one direction: the proof, the job, and the reason that a source gave no answer. */
export function directionLines(pair: PairConfig, row: DirectionRow, index: number, redact: (text: string) => string): readonly Line[] {
  const label = directionLabel(pair, row.direction)
  const proof: Line =
    row.reading.kind === 'found'
      ? [strong(`${index + 1}  ${label}: `), plain(`slot ${row.reading.message.startSlot} to ${row.reading.message.newSlot}, from the ${row.reading.source}`)]
      : [strong(`${index + 1}  ${label}: `), colored('no proof found', theme.warn)]
  const job: Line = [muted('     Backend job: '), plain(redact(jobWords(row.job)))]
  const notes = row.reading.notes.map((note): Line => [muted(`     ${redact(note)}`)])
  return [proof, job, ...notes]
}

function jobWords(job: DirectionJob): string {
  if (job.kind === 'idle') return 'none running'
  if (job.kind === 'unknown') return job.note
  return job.error === null ? job.status : `${job.status} (${job.error})`
}

/** The state of the request that the user made in this panel. */
type RequestState =
  | { readonly kind: 'none' }
  | { readonly kind: 'asking' }
  | { readonly kind: 'refused'; readonly note: string }
  | { readonly kind: 'accepted'; readonly requestId: string; readonly direction: ProofDirection }

type Phase = 'main' | 'evidence'

/** The modal of the proof panel. */
export function ProofModal(props: {
  readonly onReview: (title: string, steps: readonly FlowStep[]) => void
  readonly onClose: () => void
  /** Replaces the network reads. A test passes fakes. */
  readonly transport?: BackendTransport
  /** How often the panel reads again, in milliseconds. A test makes it short. */
  readonly refreshMilliseconds?: number
}) {
  const { pair, connection, dataSource } = useServices()
  const transport = props.transport ?? realTransport
  const refreshMilliseconds = props.refreshMilliseconds ?? REFRESH_MILLISECONDS
  const [phase, setPhase] = useState<Phase>('main')
  const [request, setRequest] = useState<RequestState>({ kind: 'none' })
  const [notice, setNotice] = useState<string | null>(null)
  const endpointsNow = (): EndpointSettings => endpointsOf(connection === null ? null : connection.resolved())
  const redact = (text: string): string => (connection === null ? text : connection.redact(text))
  const settingsKey = Object.values(endpointsNow()).map((setting) => setting?.value ?? '-').join('|')

  const rows = usePolling(
    async (): Promise<readonly DirectionRow[]> => {
      const endpoints = endpointsNow()
      const client = backendClientOf(endpoints, transport)
      const heads = await dataSource.getHeads(pair.id).catch(() => [])
      return Promise.all(
        PROOF_DIRECTIONS.map(async (direction) => {
          const destination = direction === 'first-to-second' ? 'second' : 'first'
          const headSlot = heads.find((head) => head.side === destination)?.storedHeadSlot ?? null
          const [reading, job] = await Promise.all([readLatestProof({ endpoints, pair: pair.id, direction, headSlot, transport }), readDirectionJob(client, direction)])
          return { direction, reading, job }
        }),
      )
    },
    `proofs|${pair.id}|${settingsKey}`,
    refreshMilliseconds,
  )

  const ask = (direction: ProofDirection) => {
    const client = backendClientOf(endpointsNow(), transport)
    if (client === null) return setNotice('No backend is set. Set it in Connections (key 5).')
    setNotice(null)
    setRequest({ kind: 'asking' })
    client
      .requestProof({ pair: pair.id, direction, reason: 'user' })
      .then((answer) =>
        setRequest('refused' in answer ? { kind: 'refused', note: `The backend asks you to wait ${answer.retryAfterSeconds} seconds.` } : { kind: 'accepted', requestId: answer.requestId, direction }),
      )
      .catch((error: unknown) => setRequest({ kind: 'refused', note: redact(error instanceof Error ? error.message : String(error)) }))
  }

  const post = (direction: ProofDirection) => {
    const row = rows.data?.find((candidate) => candidate.direction === direction)
    if (row === undefined || row.reading.kind !== 'found') return setNotice('There is no proof to post for this direction.')
    // The decode of the message already checked its public values against its slots, so the planner cannot refuse it.
    props.onReview('Post a light client update', [{ plan: planProofMessageUpdate(row.reading.message, pair), skippable: false }])
  }

  useKeyLayer(
    'modal',
    (key) => {
      if (key.name === 'escape') props.onClose()
      else if (key.sequence === '1') ask('first-to-second')
      else if (key.sequence === '2') ask('second-to-first')
      else if (key.sequence === '3') post('first-to-second')
      else if (key.sequence === '4') post('second-to-first')
      else if (key.name === 'e') setPhase('evidence')
      return true
    },
    { enabled: phase === 'main' ? 'on' : 'off' },
  )

  const client = backendClientOf(endpointsNow(), transport)
  return (
    <ModalFrame title="Proofs, requests and evidence" width={100} height={24}>
      <RichLine line={[muted('Latest proof of each direction (the msgboard indexer first, the msgboard node behind it)')]} />
      {rows.data === null ? <RichLine line={[muted(rows.error === null ? 'Reading the latest proofs…' : redact(rows.error))]} /> : null}
      {(rows.data ?? []).flatMap((row, index) => directionLines(pair, row, index, redact)).map((line, index) => <RichLine key={index} line={line} />)}
      <RichLine line={[]} />
      <RequestLines request={request} client={client} pair={pair} refreshMilliseconds={refreshMilliseconds} redact={redact} />
      <box flexGrow={1} />
      <RichLine line={[colored(notice ?? ' ', theme.warn)]} />
      <RichLine line={[strong('1 2', theme.accent), plain(' ask the backend for a proof  '), strong('3 4', theme.accent), plain(' post the proof as an update  '), strong('e', theme.accent), plain(' evidence of a message')]} />
      <RichLine line={[muted('Esc closes.')]} />
      {phase === 'evidence' ? <EvidenceForm endpoints={endpointsNow()} transport={transport} onReview={props.onReview} onBack={() => setPhase('main')} /> : null}
    </ModalFrame>
  )
}

function RequestLines(props: { readonly request: RequestState; readonly client: ReturnType<typeof backendClientOf>; readonly pair: PairConfig; readonly refreshMilliseconds: number; readonly redact: (text: string) => string }) {
  const { request, client, pair, refreshMilliseconds, redact } = props
  if (request.kind === 'none') return <RichLine line={[muted('No request made yet.')]} />
  if (request.kind === 'asking') return <RichLine line={[colored('Asking the backend…', theme.pending)]} />
  if (request.kind === 'refused') return <RichLine line={[colored(request.note, theme.bad)]} />
  return <AcceptedRequest requestId={request.requestId} direction={request.direction} client={client} pair={pair} refreshMilliseconds={refreshMilliseconds} redact={redact} />
}

function AcceptedRequest(props: {
  readonly requestId: string
  readonly direction: ProofDirection
  readonly client: ReturnType<typeof backendClientOf>
  readonly pair: PairConfig
  readonly refreshMilliseconds: number
  readonly redact: (text: string) => string
}) {
  const { requestId, direction, client, pair, refreshMilliseconds, redact } = props
  const status = usePolling(
    async () => {
      if (client === null) throw new Error('No backend is set.')
      return client.requestStatus(requestId)
    },
    `request|${requestId}`,
    refreshMilliseconds,
  )
  const state = status.data === null ? (status.error === null ? 'waiting for the first status…' : redact(status.error)) : status.data.status
  const detail = status.data?.error == null ? null : redact(status.data.error)
  return (
    <>
      <RichLine line={[strong('Request '), plain(`${requestId.slice(0, 12)} for ${directionLabel(pair, direction)}: `), colored(state, status.data?.status === 'failed' ? theme.bad : theme.good)]} />
      {detail === null ? null : wrapped(detail).map((text, index) => <RichLine key={index} line={[colored(text, theme.bad)]} />)}
    </>
  )
}

/** The reason shown when a server sends evidence for a message other than the one asked for. */
const EVIDENCE_FOR_OTHER_MESSAGE = 'The evidence is for a different message.'

/** Tells whether the identifier in the evidence is the identifier that the user asked for. The comparison ignores case. */
function isEvidenceForMessage(evidenceMessageId: string, requestedId: string): boolean {
  return evidenceMessageId.toLowerCase() === requestedId.toLowerCase()
}

/** The small form that asks for a message identifier and opens the execute sequence from the archive evidence. */
function EvidenceForm(props: {
  readonly endpoints: EndpointSettings
  readonly transport: BackendTransport
  readonly onReview: (title: string, steps: readonly FlowStep[]) => void
  readonly onBack: () => void
}) {
  const { pair, connection } = useServices()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'yes' | 'no'>('no')
  const redact = (text: string): string => (connection === null ? text : connection.redact(text))
  const form = useForm({
    specs: [{ kind: 'text', name: 'messageId', label: 'Message identifier', placeholder: '0x and 64 hex digits', hint: 'The archive holds evidence for messages sent and not yet delivered.' }],
    enabled: busy === 'yes' ? 'off' : 'on',
    onSubmit: (values) => {
      setBusy('yes')
      setError(null)
      const requestedId = (values.messageId ?? '').trim()
      readEvidence({ endpoints: props.endpoints, messageId: requestedId, transport: props.transport })
        .then((reading) => {
          if (reading.kind === 'none') throw new OperatorFileError(reading.note)
          const sequence = planMessageExecution(reading.text, pair)
          if (!isEvidenceForMessage(sequence.summary.messageId, requestedId)) throw new OperatorFileError(EVIDENCE_FOR_OTHER_MESSAGE)
          props.onReview(`Execute message ${sequence.summary.messageId.slice(0, 12)}…`, sequence.steps.map((step) => ({ plan: step.plan, skippable: step.role === 'prerequisite' })))
        })
        .catch((caught: unknown) => {
          setError(redact(caught instanceof Error ? caught.message : String(caught)))
          setBusy('no')
        })
    },
    onCancel: props.onBack,
  })
  return (
    <ModalFrame title="Evidence from the archive" width={96} height={10}>
      <FormView form={form} width={92} />
      <RichLine line={[colored(busy === 'yes' ? 'Asking the archive…' : (error ?? ' '), busy === 'yes' ? theme.pending : theme.bad)]} />
      <RichLine line={[muted('Enter reads the evidence and shows the transactions. Esc goes back.')]} />
    </ModalFrame>
  )
}
