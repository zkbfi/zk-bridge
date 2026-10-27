import { describe, expect, test } from 'bun:test'
import { FIXTURE_PAIR } from '../../src/data/fixtures'
import { IndexerResponseError, createIndexerDataSource, feedQuery, gatesOf } from '../../src/data/indexer-data-source'

// Answers in the shape of explorer/indexer/src/api: block numbers, timestamps, slots and chain identifiers are JSON
// numbers, and token amounts are decimal strings.
const usdcHome = '0x00000000000000000000000000000000000a0001'
const usdcCopy = '0x00000000000000000000000000000000000b0001'

const tokens = {
  tokens: [
    { chainId: 1, address: usdcHome, symbol: 'USDC', name: 'USD Coin', decimals: 6, metadataRead: true, isBridgedCopy: false, homeChainId: 1, homeToken: usdcHome },
    { chainId: 369, address: usdcCopy, symbol: 'zkbUSDC', name: 'USD Coin from Ethereum', decimals: 6, metadataRead: true, isBridgedCopy: true, homeChainId: 1, homeToken: usdcHome },
    { chainId: 1, address: '0x00000000000000000000000000000000000a0002', symbol: null, name: null, decimals: 18, metadataRead: false, isBridgedCopy: false, homeChainId: 1, homeToken: '0x00000000000000000000000000000000000a0002' },
  ],
}

const head = (chainId: number, trackedChainId: number, stored: number | null, finalized: number | null) => ({
  chainId,
  trackedChainId,
  storedHeadSlot: stored,
  finalizedSlot: finalized,
  lagSlots: stored === null || finalized === null ? null : finalized - stored,
  lastUpdateTimestamp: 1_000,
})

const summary = {
  pair: 'eth-pls',
  now: 2_000,
  heads: [head(1, 369, 100, 150), head(369, 1, 500, null)],
  gates: [
    { chainId: 1, sealed: false, enforcing: true, depositsOpen: true, lastConfirmedTimestamp: 1_990 },
    { chainId: 369, sealed: null, enforcing: null, depositsOpen: false, lastConfirmedTimestamp: null },
  ],
  inFlight: { total: 3, byStatus: {}, byDirection: {} },
  volume24h: [{ chainId: 1, token: { chainId: 1, address: usdcHome }, volume: '12345678901234567890', transfers: 4 }],
  lastHeadUpdates: [{ chainId: 1, update: { timestamp: 1_800 } }, { chainId: 369, update: null }],
}

const feedItem = {
  messageId: `0x${'1'.repeat(64)}`,
  kind: 'token',
  status: 'waiting_for_finality',
  direction: { sourceChainId: 1, destinationChainId: 369, label: '1>369' },
  sender: '0x00000000000000000000000000000000000000aa',
  executor: '0x00000000000000000000000000000000000000bb',
  gasLimit: 250000,
  sent: { transactionHash: `0x${'2'.repeat(64)}`, blockNumber: 5, timestamp: 1_900 },
  covered: null,
  delivered: null,
  transfer: {
    sourceToken: { chainId: 1, address: usdcHome, symbol: 'USDC', decimals: 6 },
    sender: '0x00000000000000000000000000000000000000aa',
    recipient: '0x00000000000000000000000000000000000000cc',
    value: '9007199254740993',
  },
}

function source(answers: Record<string, unknown>, urls: string[] = []) {
  return createIndexerDataSource({
    baseUrl: 'http://indexer.test/',
    pair: FIXTURE_PAIR,
    now: () => 2_000,
    getJson: async (url) => {
      urls.push(url)
      const path = new URL(url).pathname
      if (!(path in answers)) throw new Error(`no answer for ${path}`)
      return answers[path]
    },
  })
}

describe('indexer data source', () => {
  test('keeps amounts as bigint, including a value above 2^53', async () => {
    const result = await source({ '/api/feed': { items: [feedItem], nextCursor: null } }).getFeed('eth-pls', {}, 50)
    expect(result.items[0]?.amount).toBe(9_007_199_254_740_993n)
    expect(result.items[0]?.status).toBe('waiting_for_finality')
    expect(result.items[0]?.direction).toBe('first-to-second')
    expect(result.items[0]?.deliveredAt).toBeNull()
    expect(result.hasMore).toBe(false)
  })

  test('refuses an amount that arrives as a JSON number, because digits may be lost', async () => {
    const lossy = { ...feedItem, transfer: { ...feedItem.transfer, value: 9007199254740993 } }
    await expect(source({ '/api/feed': { items: [lossy], nextCursor: null } }).getFeed('eth-pls', {}, 50)).rejects.toBeInstanceOf(IndexerResponseError)
  })

  test('refuses an unknown status instead of showing a wrong one', async () => {
    const odd = { ...feedItem, status: 'teleported' }
    await expect(source({ '/api/feed': { items: [odd], nextCursor: null } }).getFeed('eth-pls', {}, 50)).rejects.toThrow(/Unknown status/)
  })

  test('maps the summary: heads with unknown finality stay unknown, gates get a status, volume stays exact', async () => {
    const result = await source({ '/api/summary': summary, '/api/tokens': tokens }).getSummary('eth-pls')
    expect(result.inFlight).toBe(3)
    expect(result.heads[0]).toMatchObject({ side: 'first', storedHeadSlot: 100n, finalizedSlot: 150n, lagSlots: 50n, secondsPerSlot: 10 })
    // The second head has no finalized slot: it must not be shown as a lag of zero.
    expect(result.heads[1]).toMatchObject({ side: 'second', finalizedSlot: null, lagSlots: null, secondsPerSlot: 12 })
    expect(result.gates).toEqual({ first: 'open', second: 'unknown' })
    expect(result.volume24h.byToken[0]?.amount).toBe(12_345_678_901_234_567_890n)
    expect(result.volume24h.transferCount).toBe(4)
    expect(result).not.toHaveProperty('feesAccrued')
  })

  test('takes the slot length from the chain that the light client tracks, including the testnets', async () => {
    const tracked = (trackedChainIds: [number, number]) => ({
      ...summary,
      heads: [head(1, trackedChainIds[0], 100, 150), head(369, trackedChainIds[1], 500, 600)],
    })
    const read = async (trackedChainIds: [number, number]) =>
      (await source({ '/api/summary': tracked(trackedChainIds), '/api/tokens': tokens }).getSummary('eth-pls')).heads.map((entry) => entry.secondsPerSlot)
    expect(await read([943, 11155111])).toEqual([10, 12])
    expect(await read([11155111, 943])).toEqual([12, 10])
  })

  test('tokens carry their counterpart and fall back to 18 decimals when the indexer could not read them', async () => {
    const list = await source({ '/api/tokens': tokens }).listTokens('eth-pls')
    expect(list[0]).toMatchObject({ symbol: 'USDC', side: 'first', decimals: 6 })
    expect(list[0]?.counterpart?.toLowerCase()).toBe(usdcCopy)
    expect(list[1]?.counterpart?.toLowerCase()).toBe(usdcHome)
    expect(list[2]?.decimals).toBe(18)
  })

  test('the audit sums both pending directions into in flight and carries no fee column', async () => {
    const audit = {
      tokens: [
        {
          token: { chainId: 1, address: usdcHome },
          escrow: '1000',
          bridgedSupply: '900',
          pendingForward: '60',
          pendingBackward: '40',
        },
      ],
    }
    const rows = await source({ '/api/audit': audit, '/api/tokens': tokens }).getAudit('eth-pls')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({ token: expect.objectContaining({ address: usdcHome }), escrow: 1000n, bridgedSupply: 900n, inFlight: 100n })
  })

  test('the prover report holds head updates only', async () => {
    const updates = {
      items: [
        { chainId: 369, slot: 14100000, transactionHash: `0x${'a'.repeat(64)}`, timestamp: 1_800, gasUsed: '98851', costWei: '197702000000000000', poster: '0x00000000000000000000000000000000000000aa' },
      ],
    }
    const report = await source({ '/api/head-updates': updates }).getProver('eth-pls')
    expect(Object.keys(report)).toEqual(['updates'])
    expect(report.updates[0]).toMatchObject({ side: 'second', slot: 14_100_000n, gasUsed: 98_851n, costWei: 197_702_000_000_000_000n })
  })

  test('refuses a pair that this indexer does not serve', async () => {
    await expect(source({}).getSummary('other-pair')).rejects.toThrow(/serves the pair eth-pls/)
  })

  test('the pair list shows the health of the pair with its last activity', async () => {
    const [health] = await source({ '/api/summary': summary }).listPairs()
    expect(health).toMatchObject({ pairId: 'eth-pls', inFlight: 3, lastActivityAt: 1_800 })
  })
})

describe('feed query', () => {
  test('sends direction as source>destination chain identifiers, and caps the limit', () => {
    const query = new URLSearchParams(
      feedQuery({ direction: 'second-to-first', kind: 'token', status: 'delivered', token: '0x00000000000000000000000000000000000a0001', address: '0x00000000000000000000000000000000000000aa', sentAtOrAfter: 1_234 }, 500, FIXTURE_PAIR),
    )
    expect(query.get('direction')).toBe('369>1')
    expect(query.get('kind')).toBe('token')
    expect(query.get('status')).toBe('delivered')
    expect(query.get('from')).toBe('1234')
    expect(query.get('limit')).toBe('200')
    expect(new URLSearchParams(feedQuery({}, 10, FIXTURE_PAIR)).has('direction')).toBe(false)
  })
})

describe('gate status', () => {
  const sideOf = (chainId: number) => (chainId === 1 ? ('first' as const) : ('second' as const))
  test('maps sealed, stop, warn, stale, open and unknown', () => {
    const rows = [
      { chainId: 1, sealed: true, enforcing: true, depositsOpen: true, lastConfirmedTimestamp: 1_000 },
      { chainId: 369, sealed: false, enforcing: false, depositsOpen: true, lastConfirmedTimestamp: null },
    ]
    expect(gatesOf(rows, sideOf, 2_000)).toEqual({ first: 'sealed', second: 'warn' })
    expect(gatesOf([{ chainId: 1, sealed: false, enforcing: true, depositsOpen: false }], sideOf, 2_000).first).toBe('stop')
    expect(gatesOf([{ chainId: 1, sealed: false, enforcing: true, depositsOpen: true, lastConfirmedTimestamp: 1_000 }], sideOf, 1_000 + 3 * 3600).first).toBe('stale')
    expect(gatesOf([{ chainId: 1, sealed: false, enforcing: true, depositsOpen: true, lastConfirmedTimestamp: 1_000 }], sideOf, 2_000).first).toBe('open')
    expect(gatesOf([], sideOf, 2_000)).toEqual({ first: 'unknown', second: 'unknown' })
  })
})

describe('the coverage block of an answer from the RPC source', () => {
  const auditAnswer = {
    tokens: [{ token: { chainId: 1, address: usdcHome }, escrow: '1000', accruedFees: '5', bridgedSupply: '900', pendingForward: '0', pendingBackward: '0' }],
  }
  const coverage = (extra: Record<string, unknown>) => ({ complete: false, coveredFrom: 1_700, partial: [], ...extra })

  test('a summary names the partial figures that this client knows, and drops a name that it does not know', async () => {
    const answer = { ...summary, coverage: coverage({ partial: ['volume24h', 'inFlight', 'a-figure-from-a-newer-source'] }) }
    const result = await source({ '/api/summary': answer, '/api/tokens': tokens }).getSummary('eth-pls')
    expect(result.partial).toEqual(['volume24h', 'inFlight'])
  })

  test('a summary without a coverage block has no partial field, so the figures read as complete', async () => {
    const result = await source({ '/api/summary': summary, '/api/tokens': tokens }).getSummary('eth-pls')
    expect('partial' in result).toBe(false)
  })

  test('a summary whose coverage names no figure has no partial field either', async () => {
    const answer = { ...summary, coverage: coverage({ complete: true, partial: [] }) }
    const result = await source({ '/api/summary': answer, '/api/tokens': tokens }).getSummary('eth-pls')
    expect('partial' in result).toBe(false)
  })

  test('a feed page carries coveredFrom only when the history is incomplete', async () => {
    const partial = await source({ '/api/feed': { items: [feedItem], nextCursor: null, coverage: coverage({ coveredFrom: 1_234 }) } }).getFeed('eth-pls', {}, 50)
    expect(partial.coveredFrom).toBe(1_234)
    const complete = await source({ '/api/feed': { items: [feedItem], nextCursor: null, coverage: coverage({ complete: true, coveredFrom: 1_234 }) } }).getFeed('eth-pls', {}, 50)
    expect('coveredFrom' in complete).toBe(false)
    const indexer = await source({ '/api/feed': { items: [feedItem], nextCursor: null } }).getFeed('eth-pls', {}, 50)
    expect('coveredFrom' in indexer).toBe(false)
  })

  test('an audit row is partial when the coverage names the audit, and complete otherwise', async () => {
    const answers = (block: unknown) => ({ '/api/audit': { ...auditAnswer, ...(block === undefined ? {} : { coverage: block }) }, '/api/tokens': tokens })
    const partial = await source(answers(coverage({ partial: ['audit'] }))).getAudit('eth-pls')
    expect(partial[0]?.partial).toBe(true)
    const otherFigure = await source(answers(coverage({ partial: ['feed'] }))).getAudit('eth-pls')
    expect('partial' in otherFigure[0]!).toBe(false)
    const indexer = await source(answers(undefined)).getAudit('eth-pls')
    expect('partial' in indexer[0]!).toBe(false)
  })

  test('a coverage block that is malformed is refused, not trusted', async () => {
    await expect(source({ '/api/feed': { items: [], nextCursor: null, coverage: { complete: false, coveredFrom: 'yesterday', partial: [] } } }).getFeed('eth-pls', {}, 5)).rejects.toThrow()
    await expect(source({ '/api/feed': { items: [], nextCursor: null, coverage: { complete: false, coveredFrom: 1, partial: 'feed' } } }).getFeed('eth-pls', {}, 5)).rejects.toThrow()
  })
})
