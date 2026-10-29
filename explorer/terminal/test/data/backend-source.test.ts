import { describe, expect, test } from 'bun:test'
import { backendClientOf, readDirectionJob, readEvidence, readLatestProof } from '../../src/data/backend-source'
import { boardAnswer, endpoints, fakeTransport, payloadOf, proofMessage } from '../support/proof-fixtures'

const INDEXER = 'https://indexer.example.test/KEYPART123456'
const NODE = 'https://node.example.test/KEYPART123456'
const BACKEND = 'https://backend.example.test'
const ARCHIVE = 'https://archive.example.test/KEYPART123456'
const HEAD = 14_099_840n

const latest = (set: Parameters<typeof endpoints>[0], transport: ReturnType<typeof fakeTransport>['transport'], headSlot: bigint | null = HEAD) =>
  readLatestProof({ endpoints: endpoints(set), pair: 'eth-pls', direction: 'first-to-second', headSlot, transport })

describe('the latest proof from the msgboard indexer', () => {
  test('the proof of the indexer wins, and the board is not asked', async () => {
    const message = proofMessage()
    const { transport, gets, posts } = fakeTransport({ get: async () => ({ status: 200, body: { payload: payloadOf(message), receivedAt: 1 } }) })
    const reading = await latest({ msgboardIndexerUrl: INDEXER, msgboardUrl: NODE }, transport)
    expect(reading).toEqual({ kind: 'found', source: 'msgboard indexer', message, notes: [] })
    expect(gets).toEqual([`${INDEXER}/proofs/latest/first-to-second`])
    expect(posts).toEqual([])
  })

  test('a 404 from a working indexer is an answer: no usable proof, and the board is not asked, so nothing stale shows', async () => {
    const stale = proofMessage({ newSlot: 14_100_064n })
    const { transport, posts } = fakeTransport({ get: async () => ({ status: 404, body: { error: 'no usable proof' } }), post: async () => boardAnswer('first-to-second', [payloadOf(stale)]) })
    const reading = await latest({ msgboardIndexerUrl: INDEXER, msgboardUrl: NODE }, transport)
    expect(reading).toEqual({ kind: 'none', notes: ['The msgboard indexer holds no usable proof.'] })
    expect(posts).toEqual([])
  })

  test.each([
    ['a 503 says the module is not built', async () => ({ status: 503, body: { error: 'module not built' } }), 'The msgboard indexer is not built on this backend.'],
    ['another status is named', async () => ({ status: 500, body: null }), 'The msgboard indexer answered with status 500.'],
    ['an answer with no payload is of an unknown shape', async () => ({ status: 200, body: { nothing: true } }), 'The msgboard indexer gave an answer of an unknown shape.'],
    ['a payload that does not decode is named', async () => ({ status: 200, body: { payload: '0x1234' } }), 'The msgboard indexer gave a proof that does not decode (wrong-version).'],
    ['a proof for the other direction is refused', async () => ({ status: 200, body: { payload: payloadOf(proofMessage({ direction: 'second-to-first' })) } }), 'The msgboard indexer gave a proof for another route.'],
    ['a failure to connect is named', async () => Promise.reject(new Error(`cannot reach ${INDEXER}`)), 'The msgboard indexer did not answer.'],
  ])('%s, and the board answers instead', async (_name, answer, note) => {
    const onBoard = proofMessage({ newSlot: 14_100_032n })
    const { transport } = fakeTransport({ get: answer, post: async () => boardAnswer('first-to-second', [payloadOf(onBoard)]) })
    const reading = await latest({ msgboardIndexerUrl: INDEXER, msgboardUrl: NODE }, transport)
    expect(reading).toEqual({ kind: 'found', source: 'msgboard node', message: onBoard, notes: [note] })
  })
})

describe('the latest proof from the msgboard node', () => {
  test('keeps the proof that starts at the stored head and reaches furthest, and drops the rest', async () => {
    const short = proofMessage({ newSlot: 14_100_000n })
    const far = proofMessage({ newSlot: 14_100_064n })
    const wrongStart = proofMessage({ startSlot: 14_099_000n, newSlot: 14_200_000n })
    const wrongDirection = proofMessage({ direction: 'second-to-first', newSlot: 14_300_000n })
    const { transport } = fakeTransport({
      post: async () => boardAnswer('first-to-second', [payloadOf(short), payloadOf(wrongStart), payloadOf(far), payloadOf(wrongDirection), '0xdead']),
    })
    const reading = await latest({ msgboardUrl: NODE }, transport)
    expect(reading).toEqual({ kind: 'found', source: 'msgboard node', message: far, notes: ['No msgboard indexer is set.'] })
  })

  test('with no stored head known, the proof that reaches furthest wins', async () => {
    const near = proofMessage({ newSlot: 14_100_000n })
    const wrongStart = proofMessage({ startSlot: 14_099_000n, newSlot: 14_200_000n })
    const { transport } = fakeTransport({ post: async () => boardAnswer('first-to-second', [payloadOf(near), payloadOf(wrongStart)]) })
    const reading = await latest({ msgboardUrl: NODE }, transport, null)
    expect(reading.kind === 'found' && reading.message).toEqual(wrongStart)
  })

  test('says so when no proof starts at the stored head', async () => {
    const wrongStart = proofMessage({ startSlot: 14_099_000n })
    const { transport } = fakeTransport({ post: async () => boardAnswer('first-to-second', [payloadOf(wrongStart)]) })
    expect(await latest({ msgboardUrl: NODE }, transport)).toEqual({ kind: 'none', notes: ['No msgboard indexer is set.', 'The msgboard node holds no proof that starts at the stored head.'] })
  })

  test('says so when the node does not answer, and the note holds no URL', async () => {
    const { transport } = fakeTransport({ post: async () => Promise.reject(new Error(`cannot reach ${NODE}`)) })
    const reading = await latest({ msgboardUrl: NODE }, transport)
    expect(reading).toEqual({ kind: 'none', notes: ['No msgboard indexer is set.', 'The msgboard node did not give its messages.'] })
    expect(JSON.stringify(reading)).not.toContain('KEYPART123456')
  })

  test('with no indexer and no node, says that both are unset and reads nothing', async () => {
    const { transport, gets, posts } = fakeTransport({})
    expect(await latest({}, transport)).toEqual({ kind: 'none', notes: ['No msgboard indexer is set.', 'No msgboard node is set.'] })
    expect([...gets, ...posts]).toEqual([])
  })

  test('a down indexer and no node says why the indexer gave nothing', async () => {
    const { transport } = fakeTransport({ get: async () => ({ status: 503, body: null }) })
    expect(await latest({ msgboardIndexerUrl: INDEXER }, transport)).toEqual({ kind: 'none', notes: ['The msgboard indexer is not built on this backend.', 'No msgboard node is set.'] })
  })
})

describe('evidence from the archive', () => {
  const messageId = `0x${'ab'.repeat(32)}`
  const read = (set: Parameters<typeof endpoints>[0], transport: ReturnType<typeof fakeTransport>['transport'], id = messageId) => readEvidence({ endpoints: endpoints(set), messageId: id, transport })

  test('returns the evidence text exactly as the JSON it received', async () => {
    const body = { schemaVersion: 2, message: { messageId } }
    const { transport, gets } = fakeTransport({ get: async () => ({ status: 200, body }) })
    expect(await read({ archiveUrl: ARCHIVE }, transport, `  ${messageId}  `)).toEqual({ kind: 'found', text: JSON.stringify(body) })
    expect(gets).toEqual([`${ARCHIVE}/evidence/${messageId}`])
  })

  test.each([
    ['a 404', async () => ({ status: 404, body: null }), 'The archive holds no evidence for this message.'],
    ['a 503', async () => ({ status: 503, body: null }), 'The archive is not built on this backend.'],
    ['another status', async () => ({ status: 500, body: null }), 'The archive answered with status 500.'],
    ['a body that is not an object', async () => ({ status: 200, body: 'text' }), 'The archive answered with status 200.'],
    ['a failure to connect', async () => Promise.reject(new Error(`cannot reach ${ARCHIVE}`)), 'The archive did not answer.'],
  ])('%s gives a plain note', async (_name, answer, note) => {
    const { transport } = fakeTransport({ get: answer })
    expect(await read({ archiveUrl: ARCHIVE }, transport)).toEqual({ kind: 'none', note })
  })

  test('refuses an unset archive and an identifier of the wrong form before any request', async () => {
    const { transport, gets } = fakeTransport({})
    expect(await read({}, transport)).toEqual({ kind: 'none', note: 'No archive is set. Set it in Connections.' })
    expect(await read({ archiveUrl: ARCHIVE }, transport, '0x12')).toEqual({ kind: 'none', note: 'A message identifier is 0x and 64 hex digits.' })
    expect(gets).toEqual([])
  })
})

describe('the backend', () => {
  test('there is no client without a backend setting', () => {
    expect(backendClientOf(endpoints(), fakeTransport({}).transport)).toBeNull()
  })

  const job = (answer: { status: number; body: unknown }) => {
    const { transport } = fakeTransport({ get: async () => answer })
    return readDirectionJob(backendClientOf(endpoints({ backendUrl: BACKEND }), transport), 'first-to-second')
  }
  const jobBody = (status: string, error: string | null) => ({
    direction: 'first-to-second',
    job: { jobId: 'job-1', direction: 'first-to-second', status, createdAt: 1, updatedAt: 2, startSlot: null, newSlot: null, error },
  })

  test('the job status of a direction is the status word of the newest job', async () => {
    expect(await job({ status: 200, body: jobBody('proving', null) })).toEqual({ kind: 'job', status: 'proving', error: null })
    expect(await job({ status: 200, body: jobBody('failed', 'out of memory') })).toEqual({ kind: 'job', status: 'failed', error: 'out of memory' })
  })

  test('a direction with no job is idle, and a failure is a value, not a throw', async () => {
    expect(await job({ status: 200, body: { direction: 'first-to-second', job: null } })).toEqual({ kind: 'idle' })
    expect(await job({ status: 500, body: null })).toEqual({ kind: 'unknown', note: 'The backend did not give the job status.' })
    expect(await readDirectionJob(null, 'first-to-second')).toEqual({ kind: 'unknown', note: 'No backend is set.' })
  })
})
