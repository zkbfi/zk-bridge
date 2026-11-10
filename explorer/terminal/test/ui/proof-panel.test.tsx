import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import type { EndpointKey } from '@zk-bridge/shared'
import { EMPTY_CONNECTION_SETTINGS } from '@zk-bridge/shared'
import { createConnectionRuntime } from '../../src/data/connection-runtime'
import { FIXTURE_NOW, createFixtureDataSource } from '../../src/data/fixtures'
import type { DataSource } from '../../src/data/data-source'
import type { FlowStep } from '../../src/flow/transaction-flow'
import { ProofModal, directionLabel } from '../../src/ui/proof-panel'
import { fakeChainAccesses, fakeConnections, livePair } from '../support/live-support'
import { EVIDENCE_MESSAGE_ID, evidence } from '../support/evidence-fixture'
import { renderModalAlone } from '../support/modal-harness'
import { boardAnswer, fakeTransport, payloadOf, proofMessage } from '../support/proof-fixtures'
import { renderApp } from './harness'

// The frame is polled for up to five seconds in some tests, and the machine can be busy.
setDefaultTimeout(30_000)

type Opened = Awaited<ReturnType<typeof renderModalAlone>>
let opened: Opened | null = null
let hosts: Awaited<ReturnType<typeof renderApp>> | null = null
afterEach(() => {
  opened?.destroy()
  hosts?.destroy()
  opened = null
  hosts = null
})

const KEY = 'KEYPART123456'
const URLS: Record<EndpointKey, string> = {
  backendUrl: `https://backend.example.test/${KEY}`,
  msgboardIndexerUrl: `https://indexer.example.test/${KEY}`,
  archiveUrl: `https://archive.example.test/${KEY}`,
  msgboardUrl: `https://node.example.test/${KEY}`,
}
const HEAD = 14_099_840n

/** A data source whose stored head, on both chains, is the given slot. */
function dataSourceWithHead(slot: bigint): DataSource {
  const base = createFixtureDataSource({ now: () => FIXTURE_NOW })
  return { ...base, getHeads: async (pairId) => (await base.getHeads(pairId)).map((head) => ({ ...head, storedHeadSlot: slot })) }
}

/** Opens the panel on a live runtime whose environment sets the given endpoints. */
async function openPanel(input: {
  readonly set: readonly EndpointKey[]
  readonly transport: ReturnType<typeof fakeTransport>['transport']
  readonly reviews?: FlowStep[][]
  readonly onReview?: (title: string, steps: readonly FlowStep[]) => void
  readonly closed?: string[]
  readonly dataSource?: DataSource
}) {
  const { pair, sharedPair } = livePair()
  const runtime = createConnectionRuntime({
    pair,
    sharedPair,
    environment: Object.fromEntries(input.set.map((key) => [key, URLS[key]])),
    user: EMPTY_CONNECTION_SETTINGS,
    createConnection: fakeConnections().createConnection,
    createChainAccess: fakeChainAccesses().createChainAccess,
  })
  hosts = await renderApp({ width: 120, height: 40, pair, connection: runtime, dataSource: input.dataSource ?? dataSourceWithHead(HEAD), files: {} })
  opened = await renderModalAlone(
    hosts.services,
    <ProofModal transport={input.transport} refreshMilliseconds={150} onReview={input.onReview ?? ((_title, steps) => input.reviews?.push([...steps]))} onClose={() => input.closed?.push('closed')} />,
  )
  return opened
}

const requestBody = (status: string, error: string | null = null) => ({
  requestId: 'req-0123456789abcdef',
  reason: 'user',
  messageId: null,
  requestedAt: 1,
  jobId: 'job-1',
  direction: 'first-to-second',
  status,
  createdAt: 1,
  updatedAt: 2,
  startSlot: null,
  newSlot: null,
  error,
})

describe('the proof panel reads the latest proof', () => {
  test('the proof panel shows the latest proof from the msgboard indexer, then the board when the indexer is down', async () => {
    const fromIndexer = proofMessage({ newSlot: 14_100_000n })
    const fromBoard = proofMessage({ direction: 'second-to-first', startSlot: HEAD, newSlot: 14_100_064n })
    const { transport, posts } = fakeTransport({
      get: async (url) => {
        if (url.includes('/proofs/latest/first-to-second')) return { status: 200, body: { payload: payloadOf(fromIndexer) } }
        if (url.includes('/proofs/latest/')) return { status: 503, body: { error: 'module not built' } }
        return { status: 200, body: { direction: 'first-to-second', job: null } }
      },
      post: async () => boardAnswer('second-to-first', [payloadOf(fromBoard)]),
    })
    const view = await openPanel({ set: ['backendUrl', 'msgboardIndexerUrl', 'msgboardUrl'], transport })
    const frame = await view.until('from the msgboard node')
    expect(frame).toContain('1  Ethereum to PulseChain: slot 14099840 to 14100000, from the msgboard indexer')
    expect(frame).toContain('2  PulseChain to Ethereum: slot 14099840 to 14100064, from the msgboard node')
    expect(frame).toContain('The msgboard indexer is not built on this backend.')
    expect(frame).toContain('Backend job: none running')
    expect(new Set(posts)).toEqual(new Set([URLS.msgboardUrl]))
    expect(frame).not.toContain(KEY)
  })

  test('with no endpoint set, each direction says why it has no proof', async () => {
    const { transport } = fakeTransport({})
    const view = await openPanel({ set: [], transport })
    const frame = await view.until('No msgboard node is set.')
    expect(frame).toContain('no proof found')
    expect(frame).toContain('No msgboard indexer is set.')
    expect(frame).toContain('Backend job: No backend is set.')
    expect(directionLabel(hosts!.services.pair, 'second-to-first')).toBe('PulseChain to Ethereum')
  })

  test('when the stored head cannot be read, the board proof that reaches furthest shows', async () => {
    const unreadable: DataSource = { ...dataSourceWithHead(HEAD), getHeads: async () => Promise.reject(new Error('indexer down')) }
    const far = proofMessage({ startSlot: 14_000_000n, newSlot: 14_200_000n })
    const { transport } = fakeTransport({ post: async () => boardAnswer('first-to-second', [payloadOf(proofMessage()), payloadOf(far)]) })
    const view = await openPanel({ set: ['msgboardUrl'], transport, dataSource: unreadable })
    expect(await view.until('from the msgboard node')).toContain('slot 14000000 to 14200000, from the msgboard node')
  })

  test('a proof is not posted when the head moved after the panel read it, and the reason shows', async () => {
    const reviews: FlowStep[][] = []
    let head = HEAD
    const base = dataSourceWithHead(HEAD)
    const moving: DataSource = { ...base, getHeads: async (pairId) => (await base.getHeads(pairId)).map((entry) => ({ ...entry, storedHeadSlot: head })) }
    const { transport } = fakeTransport({ get: async () => ({ status: 200, body: { payload: payloadOf(proofMessage()) } }) })
    const view = await openPanel({ set: ['msgboardIndexerUrl'], transport, reviews, dataSource: moving })
    await view.until('from the msgboard indexer')
    head = HEAD + 32n
    await view.press('3')
    expect(await view.until('Request a new proof')).toContain(`The light client head is now at slot ${HEAD + 32n}`)
    expect(reviews).toEqual([])
  })

  test('a proof is not posted when the head cannot be read', async () => {
    const reviews: FlowStep[][] = []
    let readable = true
    const base = dataSourceWithHead(HEAD)
    const failing: DataSource = { ...base, getHeads: async (pairId) => (readable ? base.getHeads(pairId) : Promise.reject(new Error('rpc down'))) }
    const { transport } = fakeTransport({ get: async () => ({ status: 200, body: { payload: payloadOf(proofMessage()) } }) })
    const view = await openPanel({ set: ['msgboardIndexerUrl'], transport, reviews, dataSource: failing })
    await view.until('from the msgboard indexer')
    readable = false
    await view.press('3')
    expect(await view.until('cannot be read')).toContain('The light client head cannot be read')
    expect(reviews).toEqual([])
  })

  test('the job status of a direction shows, with its error when the job failed', async () => {
    const job = { jobId: 'job-9', direction: 'first-to-second', status: 'failed', createdAt: 1, updatedAt: 2, startSlot: null, newSlot: null, error: 'out of memory' }
    const { transport } = fakeTransport({ get: async (url) => (url.includes('/directions/') ? { status: 200, body: { direction: 'first-to-second', job } } : { status: 404, body: null }) })
    const view = await openPanel({ set: ['backendUrl'], transport })
    expect(await view.until('failed (out of memory)')).toContain('Backend job: failed (out of memory)')
  })

  test('a proof posts as an update through the review, and a direction with no proof says so', async () => {
    const reviews: FlowStep[][] = []
    const { transport } = fakeTransport({ get: async () => ({ status: 200, body: { payload: payloadOf(proofMessage()) } }) })
    const view = await openPanel({ set: ['msgboardIndexerUrl'], transport, reviews })
    await view.until('from the msgboard indexer')
    await view.press('3')
    expect(reviews).toHaveLength(1)
    expect(reviews[0]![0]!.plan.functionSignature).toBe('update(bytes,bytes)')
    expect(reviews[0]![0]!.plan.chain.chainId).toBe(369)
  })

  test('a review that cannot open shows its reason with any keyed endpoint hidden', async () => {
    const { transport } = fakeTransport({ get: async () => ({ status: 200, body: { payload: payloadOf(proofMessage()) } }) })
    const onReview = () => {
      throw new Error(`cannot plan against ${URLS.backendUrl}`)
    }
    const view = await openPanel({ set: ['msgboardIndexerUrl'], transport, onReview })
    await view.until('from the msgboard indexer')
    await view.press('3')
    const frame = await view.until('cannot plan against')
    expect(frame).toContain('cannot plan against')
    expect(frame).not.toContain(KEY)
  })

  test('a direction with no proof says so and opens no review', async () => {
    const reviews: FlowStep[][] = []
    const { transport } = fakeTransport({ get: async () => ({ status: 404, body: null }) })
    const view = await openPanel({ set: ['msgboardIndexerUrl'], transport, reviews })
    await view.until('holds no usable proof')
    await view.press('4')
    expect(reviews).toEqual([])
    expect(view.frame()).toContain('There is no proof to post for this direction.')
  })

  test('Escape closes the panel', async () => {
    const closed: string[] = []
    const view = await openPanel({ set: [], transport: fakeTransport({}).transport, closed })
    await view.press('escape')
    expect(closed).toEqual(['closed'])
  })
})

describe('asking the backend for a proof', () => {
  test('request a proof shows the request status as it changes', async () => {
    let reads = 0
    const statuses = ['queued', 'proving', 'published']
    const { transport, posts } = fakeTransport({
      get: async (url) => {
        if (url.includes('/requests/')) return { status: 200, body: requestBody(statuses[Math.min(reads++, statuses.length - 1)]!) }
        return { status: 200, body: { direction: 'first-to-second', job: null } }
      },
      post: async (_url, body) => ({ status: 202, body: { requestId: 'req-0123456789abcdef', jobId: JSON.parse(body).direction } }),
    })
    const view = await openPanel({ set: ['backendUrl'], transport })
    await view.press('1')
    expect(await view.until('queued')).toContain('Request req-01234567 for Ethereum to PulseChain: queued')
    expect(await view.until('proving')).toContain('proving')
    expect(await view.until('published')).toContain('published')
    expect(posts).toEqual([`${URLS.backendUrl}/requests`])
  })

  test('a failed request shows the reason of the backend', async () => {
    const { transport } = fakeTransport({
      get: async (url) => (url.includes('/requests/') ? { status: 200, body: requestBody('failed', 'the prover ran out of memory') } : { status: 200, body: { direction: 'first-to-second', job: null } }),
      post: async () => ({ status: 202, body: { requestId: 'req-0123456789abcdef', jobId: 'job-1' } }),
    })
    const view = await openPanel({ set: ['backendUrl'], transport })
    await view.press('2')
    expect(await view.until('the prover ran out of memory')).toContain('PulseChain to Ethereum: failed')
  })

  test('a failure reason that holds a keyed endpoint URL reaches the screen with the key hidden', async () => {
    const { transport } = fakeTransport({
      get: async (url) =>
        url.includes('/requests/')
          ? { status: 200, body: requestBody('failed', `could not reach ${URLS.backendUrl}/jobs`) }
          : { status: 200, body: { direction: 'first-to-second', job: null } },
      post: async () => ({ status: 202, body: { requestId: 'req-0123456789abcdef', jobId: 'job-1' } }),
    })
    const view = await openPanel({ set: ['backendUrl'], transport })
    await view.press('2')
    const frame = await view.until('could not reach')
    expect(frame).not.toContain(KEY)
  })

  test('a request that waits for its first status says so', async () => {
    const { transport } = fakeTransport({
      get: async (url) => (url.includes('/requests/') ? Promise.reject(new Error('slow')) : { status: 200, body: { direction: 'first-to-second', job: null } }),
      post: async () => ({ status: 202, body: { requestId: 'req-0123456789abcdef', jobId: 'job-1' } }),
    })
    const view = await openPanel({ set: ['backendUrl'], transport })
    await view.press('1')
    expect(await view.until('slow')).toContain('Request req-01234567')
  })

  test('a rate limit shows how long to wait', async () => {
    const { transport } = fakeTransport({
      get: async () => ({ status: 200, body: { direction: 'first-to-second', job: null } }),
      post: async () => ({ status: 429, body: { error: 'rate-limited', retryAfterSeconds: 30 } }),
    })
    const view = await openPanel({ set: ['backendUrl'], transport })
    await view.press('1')
    expect(await view.until('wait 30 seconds')).toContain('The backend asks you to wait 30 seconds.')
  })

  test('a backend that sees nothing to prove says so', async () => {
    const { transport } = fakeTransport({
      get: async () => ({ status: 200, body: { direction: 'first-to-second', job: null } }),
      post: async () => ({ status: 409, body: { error: 'nothing-to-prove' } }),
    })
    const view = await openPanel({ set: ['backendUrl'], transport })
    await view.press('1')
    expect(await view.until('No proof is needed')).toContain('No proof is needed now: no message waits and the light client head is fresh.')
  })

  test('a backend that cannot check its chain indexer shows how long to wait', async () => {
    const { transport } = fakeTransport({
      get: async () => ({ status: 200, body: { direction: 'first-to-second', job: null } }),
      post: async () => ({ status: 503, body: { error: 'cannot-check', retryAfterSeconds: 30 } }),
    })
    const view = await openPanel({ set: ['backendUrl'], transport })
    await view.press('1')
    expect(await view.until('could not check')).toContain('The backend could not check whether a proof is needed. Try again in 30 seconds.')
  })

  test('a backend that fails shows a sentence with no URL', async () => {
    const { transport } = fakeTransport({
      get: async () => ({ status: 200, body: { direction: 'first-to-second', job: null } }),
      post: async () => ({ status: 500, body: null }),
    })
    const view = await openPanel({ set: ['backendUrl'], transport })
    await view.press('1')
    const frame = await view.until('status 500')
    expect(frame).toContain('the backend answered a proof request with status 500')
    expect(frame).not.toContain(KEY)
  })

  test('with no backend set, asking tells you where to set it', async () => {
    const view = await openPanel({ set: [], transport: fakeTransport({}).transport })
    await view.press('1')
    expect(view.frame()).toContain('No backend is set. Set it in Connections (key 5).')
  })
})

describe('evidence from the archive', () => {
  const sequence = evidence({}, livePair().pair)
  const archive = (answer: { status: number; body: unknown }) => fakeTransport({ get: async () => answer })

  test('evidence from the archive opens the execute sequence', async () => {
    const reviews: FlowStep[][] = []
    const view = await openPanel({ set: ['archiveUrl'], transport: archive({ status: 200, body: JSON.parse(sequence) }).transport, reviews })
    await view.press('e')
    await view.type(EVIDENCE_MESSAGE_ID)
    await view.press('return')
    await view.waitFor(() => reviews.length > 0)
    expect(reviews).toHaveLength(1)
    expect(reviews[0]!.map((step) => step.skippable)).toEqual([true, false])
    expect(reviews[0]![1]!.plan.functionName).toBe('executeMessage')
  })

  test('a message that the archive does not hold shows the reason and keeps the form', async () => {
    const reviews: FlowStep[][] = []
    const view = await openPanel({ set: ['archiveUrl'], transport: archive({ status: 404, body: null }).transport, reviews })
    await view.press('e')
    await view.type(EVIDENCE_MESSAGE_ID)
    await view.press('return')
    expect(await view.until('holds no evidence')).toContain('The archive holds no evidence for this message.')
    expect(reviews).toEqual([])
  })

  test('evidence that names a delivered message is refused with the reason of the planner', async () => {
    const delivered = JSON.parse(evidence({ alreadyDelivered: true, deliveryStatus: 'succeeded' }, livePair().pair))
    const view = await openPanel({ set: ['archiveUrl'], transport: archive({ status: 200, body: delivered }).transport })
    await view.press('e')
    await view.type(EVIDENCE_MESSAGE_ID)
    await view.press('return')
    expect(await view.until('already delivered')).toContain('The message is already delivered')
  })

  test('evidence for another message than the one asked for is refused with the reason', async () => {
    const reviews: FlowStep[][] = []
    const view = await openPanel({ set: ['archiveUrl'], transport: archive({ status: 200, body: JSON.parse(sequence) }).transport, reviews })
    await view.press('e')
    await view.type(`0x${'f'.repeat(64)}`)
    await view.press('return')
    expect(await view.until('different message')).toContain('The evidence is for a different message.')
    expect(reviews).toEqual([])
  })

  test('Escape on the form goes back to the panel', async () => {
    const view = await openPanel({ set: ['archiveUrl'], transport: archive({ status: 404, body: null }).transport })
    await view.press('e')
    expect(view.frame()).toContain('Evidence from the archive')
    await view.press('escape')
    await view.waitFor(() => !view.frame().includes('Evidence from the archive'))
    expect(view.frame()).not.toContain('Evidence from the archive')
    expect(view.frame()).toContain('Proofs, requests and evidence')
  })
})

describe('the panel inside the app', () => {
  test('the r key opens the panel in fixture mode, with every endpoint unset and no request sent, and Escape closes it', async () => {
    hosts = await renderApp({ width: 120, height: 40 })
    await hosts.press('r')
    await hosts.settle(60)
    expect(hosts.frame()).toContain('Proofs, requests and evidence')
    expect(hosts.frame()).toContain('No msgboard indexer is set.')
    await hosts.press('ESCAPE')
    expect(hosts.frame()).not.toContain('Proofs, requests and evidence')
  })
  test('a proof posted from the panel closes it and opens the review of the update', async () => {
    const { pair, sharedPair } = livePair()
    const runtime = createConnectionRuntime({
      pair,
      sharedPair,
      environment: { msgboardIndexerUrl: URLS.msgboardIndexerUrl },
      user: EMPTY_CONNECTION_SETTINGS,
      createConnection: fakeConnections().createConnection,
      createChainAccess: fakeChainAccesses().createChainAccess,
    })
    const realFetch = globalThis.fetch
    // The fixture data source stores slot 14100000 on the second chain, so the proof starts there.
    const fromHead = proofMessage({ startSlot: 14_100_000n, newSlot: 14_100_064n })
    globalThis.fetch = (async () => new Response(JSON.stringify({ payload: payloadOf(fromHead) }), { status: 200 })) as unknown as typeof fetch
    try {
      hosts = await renderApp({ width: 120, height: 40, pair, connection: runtime })
      await hosts.press('r')
      for (let attempt = 0; attempt < 100 && !hosts.frame().includes('from the msgboard indexer'); attempt += 1) await hosts.settle(50)
      await hosts.press('3')
      await hosts.settle(100)
      expect(hosts.frame()).not.toContain('Proofs, requests and evidence')
      expect(hosts.frame()).toContain('Post a light client update')
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
