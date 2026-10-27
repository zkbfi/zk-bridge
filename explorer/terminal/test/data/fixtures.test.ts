import { describe, expect, test } from 'bun:test'
import {
  FIXTURE_AUDIT,
  FIXTURE_NOW,
  FIXTURE_PAIR,
  FIXTURE_TOKENS,
  buildFixtureFeed,
  buildFixtureHeads,
  buildFixtureProver,
  createFixtureDataSource,
} from '../../src/data/fixtures'

describe('the fixture data source with the default clock', () => {
  const source = createFixtureDataSource()

  test('the clock is the fixed fixture time, so every read is the same on every run', async () => {
    expect(await source.getHeads(FIXTURE_PAIR.id)).toEqual(buildFixtureHeads(FIXTURE_NOW))
    expect(await source.getProver(FIXTURE_PAIR.id)).toEqual(buildFixtureProver(FIXTURE_NOW))
    expect(await source.getDeliveryCost(369)).toMatchObject({ chainId: 369, baseFee: { timestamp: FIXTURE_NOW - 12 } })
  })

  test('lists the one pair with its chain names, and its last activity 90 seconds before now', async () => {
    const [pair, ...others] = await source.listPairs()
    expect(others).toEqual([])
    expect(pair).toMatchObject({
      pairId: FIXTURE_PAIR.id,
      label: FIXTURE_PAIR.label,
      firstChainName: 'Ethereum',
      secondChainName: 'PulseChain',
      gates: { first: 'open', second: 'warn' },
      lastActivityAt: FIXTURE_NOW - 90,
    })
  })

  test('counts a transfer as in flight exactly when it has no delivery time', async () => {
    const summary = await source.getSummary(FIXTURE_PAIR.id)
    const waiting = buildFixtureFeed(FIXTURE_NOW).filter((item) => item.deliveredAt === null)
    expect(summary.inFlight).toBe(waiting.length)
    expect(summary.inFlight).toBeGreaterThan(0)
  })

  test('the volume of one day counts only token transfers sent in the last 86400 seconds', async () => {
    const summary = await source.getSummary(FIXTURE_PAIR.id)
    const recent = buildFixtureFeed(FIXTURE_NOW).filter((item) => item.sentAt >= FIXTURE_NOW - 86_400 && item.token !== null)
    expect(summary.volume24h.transferCount).toBe(recent.length)
    const usdc = FIXTURE_TOKENS[0]!
    const expected = recent.filter((item) => item.token === usdc).reduce((sum, item) => sum + (item.amount ?? 0n), 0n)
    expect(summary.volume24h.byToken).toEqual([{ token: usdc, amount: expected }])
    expect(summary).not.toHaveProperty('feesAccrued')
  })

  test('returns the audit rows and the tokens that the fixtures define', async () => {
    expect(await source.getAudit(FIXTURE_PAIR.id)).toBe(FIXTURE_AUDIT)
    expect(await source.listTokens(FIXTURE_PAIR.id)).toBe(FIXTURE_TOKENS)
  })

  test('pages the feed newest first and says when more rows remain', async () => {
    const all = [...buildFixtureFeed(FIXTURE_NOW)].sort((left, right) => right.sentAt - left.sentAt)
    const page = await source.getFeed(FIXTURE_PAIR.id, {}, 5)
    expect(page.items.map((item) => item.id)).toEqual(all.slice(0, 5).map((item) => item.id))
    expect(page.hasMore).toBe(true)
    const full = await source.getFeed(FIXTURE_PAIR.id, {}, all.length)
    expect(full.items).toHaveLength(all.length)
    expect(full.hasMore).toBe(false)
  })

  test('a filter narrows the feed before the page is cut', async () => {
    const page = await source.getFeed(FIXTURE_PAIR.id, { kind: 'message' }, 100)
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.items.every((item) => item.kind === 'message')).toBe(true)
  })
})

describe('the fixture data source with a clock that moves', () => {
  test('every read follows the clock that the test gives', async () => {
    const later = FIXTURE_NOW + 3_600
    const source = createFixtureDataSource({ now: () => later })
    expect(await source.getHeads(FIXTURE_PAIR.id)).toEqual(buildFixtureHeads(later))
    expect((await source.listPairs())[0]?.lastActivityAt).toBe(later - 90)
  })
})
