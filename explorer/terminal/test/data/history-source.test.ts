import { describe, expect, test } from 'bun:test'
import { compareHistoryEvents, redactConnectionText, type ChainReader, type HistoryEvent, type HistoryFilters, type ResolvedSetting } from '@zk-bridge/shared'
import {
  HISTORY_PAGE_SIZE,
  NO_HISTORY_CHOICES,
  filtersOf,
  historyQueryOf,
  nextInCycle,
  pageOfScannedEvents,
  readHistoryPage,
  type HistoryConnection,
  type HistoryScanKeeper,
  type HistoryTransport,
} from '../../src/data/history-source'
import { createFakeChain } from '../../../shared/test/support/fake-chain'
import { FIRST_CHAIN, SECOND_CHAIN, buildScenario } from '../../../shared/test/support/scenario'
import { testPair } from '../../../shared/test/support/fixtures'

const pair = testPair()

const send = (timestamp: number, digit: string, chainId = FIRST_CHAIN): HistoryEvent => ({
  kind: 'sent',
  chainId,
  timestamp: BigInt(timestamp),
  transactionHash: `0x${digit.repeat(64)}`,
  messageId: `0x${digit.repeat(64)}`,
  slot: null,
  status: 'sent',
})
const delivery = (timestamp: number, digit: string, chainId = SECOND_CHAIN): HistoryEvent => ({ ...send(timestamp, digit, chainId), kind: 'delivered', status: 'delivered' })
const headUpdate = (timestamp: number, slot: number, chainId = SECOND_CHAIN): HistoryEvent => ({
  kind: 'head-update',
  chainId,
  timestamp: BigInt(timestamp),
  transactionHash: `0x${'e'.repeat(64)}`,
  messageId: null,
  slot: BigInt(slot),
  status: null,
})

const filters = (changes: Partial<HistoryFilters> = {}): HistoryFilters => ({ ...filtersOf({ pair, choices: NO_HISTORY_CHOICES, cursor: null }), ...changes })

describe('the filters and the query text', () => {
  test('no choice gives a plain page of the standard size', () => {
    const none = filtersOf({ pair, choices: NO_HISTORY_CHOICES, cursor: null })
    expect(none).toMatchObject({ chain: null, eventKind: null, direction: null, statuses: [], limit: HISTORY_PAGE_SIZE, cursor: null })
    expect(historyQueryOf(none)).toBe(`limit=${HISTORY_PAGE_SIZE}`)
  })

  test('each choice reaches the query in a fixed order, and the direction names the chains by identifier', () => {
    const toSecond = filtersOf({ pair, choices: { chain: FIRST_CHAIN, eventKind: 'sent', status: 'delivered', direction: 'first-to-second' }, cursor: null })
    expect(toSecond.direction).toEqual({ sourceChainId: FIRST_CHAIN, destinationChainId: SECOND_CHAIN })
    const toFirst = filtersOf({ pair, choices: { ...NO_HISTORY_CHOICES, direction: 'second-to-first' }, cursor: null })
    expect(toFirst.direction).toEqual({ sourceChainId: SECOND_CHAIN, destinationChainId: FIRST_CHAIN })
    const cursor = { timestamp: 50n, kind: 'sent', key: `0x${'a'.repeat(64)}` } as const
    const query = new URLSearchParams(historyQueryOf({ ...toSecond, cursor }))
    expect([...query.keys()]).toEqual(['chain', 'eventKind', 'direction', 'status', 'limit', 'cursor'])
    expect(query.get('direction')).toBe(`${FIRST_CHAIN}>${SECOND_CHAIN}`)
    expect(query.get('cursor')).toBe(`50:sent:0x${'a'.repeat(64)}`)
  })

  test('a cycle starts at no filter, visits each value and returns to no filter', () => {
    const cycle = [null, 'a', 'b'] as const
    expect([null, 'a', 'b', null].map((value) => nextInCycle(cycle, value))).toEqual(['a', 'b', null, 'a'])
    expect(nextInCycle(cycle, 'unknown' as never)).toBeNull()
  })
})

describe('a page cut from events that the chains gave', () => {
  const events = [send(500, '5'), delivery(400, '4'), headUpdate(300, 9), send(200, '2'), delivery(100, '1')].sort(compareHistoryEvents)

  test('pages of the standard size follow the cursor, and the last page has no next cursor', () => {
    const first = pageOfScannedEvents(pair, events, filters({ limit: 2 }))
    expect(first.items).toHaveLength(2)
    expect(first.partial).toBe(true)
    expect(first.nextCursor).not.toBeNull()
    const cursor = { timestamp: first.items[1]!.timestamp, kind: first.items[1]!.kind, key: first.items[1]!.messageId! }
    const second = pageOfScannedEvents(pair, events, filters({ limit: 2, cursor }))
    expect(second.items.map((item) => item.timestamp)).toEqual([300n, 200n])
    const headCursor = { timestamp: 300n, kind: 'head-update', key: `${SECOND_CHAIN}-9` } as const
    const last = pageOfScannedEvents(pair, events, filters({ limit: 2, cursor: headCursor }))
    expect(last.items.map((item) => item.timestamp)).toEqual([200n, 100n])
    expect(last.nextCursor).toBeNull()
  })

  test('an empty result is an empty page', () => {
    expect(pageOfScannedEvents(pair, events, filters({ chain: 56 }))).toEqual({ items: [], nextCursor: null, partial: true })
  })

  test('chain and kind of event filters apply', () => {
    expect(pageOfScannedEvents(pair, events, filters({ chain: FIRST_CHAIN })).items.map((item) => item.kind)).toEqual(['sent', 'sent'])
    expect(pageOfScannedEvents(pair, events, filters({ eventKind: 'head-update' })).items.map((item) => item.kind)).toEqual(['head-update'])
  })

  test('the direction keeps a send that leaves the source, a delivery that arrives, and a head update on the destination', () => {
    const toSecond = pageOfScannedEvents(pair, events, filters({ direction: { sourceChainId: FIRST_CHAIN, destinationChainId: SECOND_CHAIN } })).items
    expect(toSecond.map((item) => `${item.kind}@${item.chainId}`)).toEqual([`sent@${FIRST_CHAIN}`, `delivered@${SECOND_CHAIN}`, `head-update@${SECOND_CHAIN}`, `sent@${FIRST_CHAIN}`, `delivered@${SECOND_CHAIN}`])
    const backwards = [send(90, '7', SECOND_CHAIN), delivery(80, '8', FIRST_CHAIN)]
    const toFirst = pageOfScannedEvents(pair, [...events, ...backwards].sort(compareHistoryEvents), filters({ direction: { sourceChainId: SECOND_CHAIN, destinationChainId: FIRST_CHAIN } })).items
    expect(toFirst.map((item) => `${item.kind}@${item.chainId}`)).toEqual([`sent@${SECOND_CHAIN}`, `delivered@${FIRST_CHAIN}`])
  })

  test('a message filter leaves out the head updates, as the indexer does', () => {
    expect(pageOfScannedEvents(pair, events, filters({ statuses: ['delivered'] })).items.some((item) => item.kind === 'head-update')).toBe(false)
  })
})

describe('reading a page', () => {
  const setting = (value: string): ResolvedSetting => ({ value, source: 'user' })
  const connectionOf = (route: 'indexer' | 'rpc', rpc: Record<number, ResolvedSetting | null> = { [FIRST_CHAIN]: setting('https://one.example.test/KEY1'), [SECOND_CHAIN]: setting('https://two.example.test/KEY2') }): HistoryConnection => ({
    baseUrl: 'https://indexer.example.test',
    resolved: { indexerUrl: setting('https://indexer.example.test'), rpcUrls: rpc, backendUrl: null, msgboardIndexerUrl: null, archiveUrl: null, msgboardUrl: null },
    run: (operations) => (route === 'indexer' ? operations.viaIndexer() : operations.viaRpc()),
    redact: (text) => redactConnectionText(text, Object.values(rpc).flatMap((entry) => (entry === null ? [] : [entry.value]))),
  })

  const indexerPage = { items: [{ kind: 'sent', chainId: 1, timestamp: 100, transactionHash: `0x${'1'.repeat(64)}`, messageId: `0x${'2'.repeat(64)}`, slot: null, status: 'sent' }], nextCursor: null, partial: false }

  test('the indexer page comes back as it is, with the query of the filters', async () => {
    const urls: string[] = []
    const transport: HistoryTransport = { fetchJson: async (url) => (urls.push(url), { status: 200, body: indexerPage }), createReader: () => { throw new Error('no reader expected') } }
    const reading = await readHistoryPage({ connection: connectionOf('indexer'), pair, filters: filters({ chain: FIRST_CHAIN }), transport })
    expect(reading.source).toBe('indexer')
    expect(reading.unappliedFilters).toEqual([])
    expect(reading.page.items).toHaveLength(1)
    expect(urls).toEqual([`https://indexer.example.test/api/history?chain=${FIRST_CHAIN}&limit=${HISTORY_PAGE_SIZE}`])
  })

  test('a status other than 200 and a body that is not a page are errors with a plain sentence', async () => {
    const answer = (status: number, body: unknown): HistoryTransport => ({ fetchJson: async () => ({ status, body }), createReader: () => { throw new Error('none') } })
    await expect(readHistoryPage({ connection: connectionOf('indexer'), pair, filters: filters(), transport: answer(500, null) })).rejects.toThrow('The indexer answered 500 for the history.')
    await expect(readHistoryPage({ connection: connectionOf('indexer'), pair, filters: filters(), transport: answer(200, { nothing: 1 }) })).rejects.toThrow('not a page of the history')
  })

  test('a reader that has already left stops the read before the request', async () => {
    const controller = new AbortController()
    controller.abort(new Error('left'))
    const transport: HistoryTransport = { fetchJson: async () => { throw new Error('no request expected') }, createReader: () => { throw new Error('none') } }
    await expect(readHistoryPage({ connection: connectionOf('indexer'), pair, filters: filters(), transport, signal: controller.signal })).rejects.toThrow('left')
  })

  test('a signal that aborts during the request stops the read after it', async () => {
    const controller = new AbortController()
    const transport: HistoryTransport = { fetchJson: async () => (controller.abort(new Error('left')), { status: 200, body: indexerPage }), createReader: () => { throw new Error('none') } }
    await expect(readHistoryPage({ connection: connectionOf('indexer'), pair, filters: filters(), transport, signal: controller.signal })).rejects.toThrow('left')
  })

  const scenario = buildScenario(pair)
  const readersOf = (): HistoryTransport['createReader'] => (input) => createFakeChain(scenario, input.chainId) as ChainReader
  const fromChains: HistoryTransport = { fetchJson: async () => { throw new Error('no indexer expected') }, createReader: readersOf() }

  test('from the chains the page is partial and names the filters that the chains cannot apply', async () => {
    const reading = await readHistoryPage({ connection: connectionOf('rpc'), pair, filters: filters({ statuses: ['delivered'] }), transport: fromChains })
    expect(reading.source).toBe('rpc')
    expect(reading.page.partial).toBe(true)
    expect(reading.unappliedFilters).toEqual(['status'])
    expect(reading.page.items.length).toBeGreaterThan(0)
    expect(reading.page.items.every((item) => item.kind !== 'head-update')).toBe(true)
  })

  test('the keeper holds one scan for all pages, and a failed scan leaves it', async () => {
    const scans: HistoryScanKeeper = new Map()
    const first = await readHistoryPage({ connection: connectionOf('rpc'), pair, filters: filters({ limit: 2 }), transport: fromChains, scans })
    const second = await readHistoryPage({ connection: connectionOf('rpc'), pair, filters: filters({ limit: 2, chain: SECOND_CHAIN }), transport: fromChains, scans })
    expect(scans.size).toBe(1)
    expect(second.page.items.every((item) => item.chainId === SECOND_CHAIN)).toBe(true)
    expect(first.page.nextCursor).not.toBeNull()

    const broken: HistoryTransport = { ...fromChains, createReader: () => ({ ...createFakeChain(scenario, FIRST_CHAIN), getBlock: async () => { throw new Error('node down') } }) as ChainReader }
    const failing: HistoryScanKeeper = new Map()
    await expect(readHistoryPage({ connection: connectionOf('rpc'), pair, filters: filters(), transport: broken, scans: failing })).rejects.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(failing.size).toBe(0)
  })

  test('an error of the chain scan reaches the caller with the keyed URL hidden', async () => {
    const leaking: HistoryTransport = { ...fromChains, createReader: () => ({ ...createFakeChain(scenario, FIRST_CHAIN), getBlock: async () => { throw new Error('POST https://one.example.test/KEY1 failed') } }) as ChainReader }
    const caught = await readHistoryPage({ connection: connectionOf('rpc'), pair, filters: filters(), transport: leaking }).then(
      () => new Error('no error'),
      (error: unknown) => error as Error,
    )
    expect(caught.message).toContain('failed')
    expect(caught.message).not.toContain('KEY1')
  })

  test('a chain that is read only part way back says how far back it was read', async () => {
    const grown: HistoryTransport = {
      ...fromChains,
      createReader: (input) => {
        const chain = createFakeChain(scenario, input.chainId)
        chain.setHead(5_000_000n)
        return chain
      },
    }
    const reading = await readHistoryPage({ connection: connectionOf('rpc'), pair, filters: filters(), transport: grown })
    expect(reading.page.items).toEqual([])
    expect(reading.readBack.map((entry) => entry.chainId).sort()).toEqual([FIRST_CHAIN, SECOND_CHAIN])
    expect(reading.readBack.every((entry) => entry.block > 4_000_000n)).toBe(true)
  })

  test('a chain with no endpoint, and a connection with no pair, are plain errors', async () => {
    await expect(readHistoryPage({ connection: connectionOf('rpc', { [FIRST_CHAIN]: setting('https://one.example.test/KEY1') }), pair, filters: filters(), transport: fromChains })).rejects.toThrow('No endpoint is set for')
    await expect(readHistoryPage({ connection: connectionOf('rpc'), pair: undefined, filters: filters(), transport: fromChains })).rejects.toThrow('no deployment')
  })
})
