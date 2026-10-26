import { describe, expect, test } from 'bun:test'
import { createAppState, reduceAppState, ACTIONS, FOCUS_AREAS, type AppState } from '../../src/app/app-state'
import { auditDifference, countAuditMismatches, hasAuditMismatch } from '../../src/model/audit'
import { earliestSentAt, filterFeed, matchesFeedFilter } from '../../src/model/feed-filter'
import { EMPTY_FILTER, countActiveFilters, cycleFilterField, filterKey, toFeedFilter } from '../../src/model/filter-state'
import { FIXTURE_AUDIT, FIXTURE_NOW, FIXTURE_TOKENS, buildFixtureFeed } from '../../src/data/fixtures'
import { buildPairConfig, PairConfigError } from '../../src/config/pairs'

describe('audit rules', () => {
  const [usdc, , wpls] = FIXTURE_AUDIT
  test('the escrow must equal the bridged supply plus what is in flight', () => {
    expect(auditDifference(usdc!)).toBe(0n)
    expect(hasAuditMismatch(usdc!)).toBe(false)
  })

  test('a supply above the escrow is a negative difference and is flagged', () => {
    expect(auditDifference(wpls!)).toBe(-300n * 10n ** 18n)
    expect(hasAuditMismatch(wpls!)).toBe(true)
    expect(countAuditMismatches(FIXTURE_AUDIT)).toBe(1)
  })

  test('one base unit of difference is a mismatch: nothing is rounded', () => {
    expect(hasAuditMismatch({ ...usdc!, escrow: usdc!.escrow + 1n })).toBe(true)
  })
})

describe('feed filter', () => {
  const feed = buildFixtureFeed(FIXTURE_NOW)

  test('every key narrows, and keys combine', () => {
    const forward = filterFeed(feed, { direction: 'first-to-second' })
    expect(forward.length).toBeGreaterThan(0)
    expect(forward.every((item) => item.direction === 'first-to-second')).toBe(true)
    const deliveredTokens = filterFeed(feed, { status: 'delivered', kind: 'token' })
    expect(deliveredTokens.every((item) => item.status === 'delivered' && item.kind === 'token')).toBe(true)
    expect(filterFeed(feed, { direction: 'first-to-second', status: 'delivered' }).length).toBeLessThanOrEqual(forward.length)
  })

  test('address matches the sender or the recipient, ignoring letter case', () => {
    const sample = feed[0]!
    expect(matchesFeedFilter(sample, { address: sample.sender.toLowerCase() as `0x${string}` })).toBe(true)
    expect(matchesFeedFilter(sample, { address: sample.recipient.toUpperCase().replace('0X', '0x') as `0x${string}` })).toBe(true)
    expect(matchesFeedFilter(sample, { address: '0x0000000000000000000000000000000000dead00' })).toBe(false)
  })

  test('a message row never matches a token filter, and the time filter is inclusive', () => {
    const message = feed.find((item) => item.kind === 'message')!
    expect(matchesFeedFilter(message, { token: FIXTURE_TOKENS[0]!.address })).toBe(false)
    expect(matchesFeedFilter(message, { sentAtOrAfter: message.sentAt })).toBe(true)
    expect(matchesFeedFilter(message, { sentAtOrAfter: message.sentAt + 1 })).toBe(false)
  })

  test('results come newest first', () => {
    const times = filterFeed(feed, {}).map((item) => item.sentAt)
    expect(times).toEqual([...times].sort((left, right) => right - left))
  })

  test('time ranges convert to a start time', () => {
    expect(earliestSentAt('all', 1_000)).toBeUndefined()
    expect(earliestSentAt('1h', 10_000)).toBe(6_400)
    expect(earliestSentAt('24h', 100_000)).toBe(13_600)
    expect(earliestSentAt('7d', 1_000_000)).toBe(395_200)
  })
})

describe('filter state', () => {
  test('cycling wraps in both directions and the address field is left to text entry', () => {
    let state = EMPTY_FILTER
    state = cycleFilterField(state, 'direction', -1, [])
    expect(state.direction).toBe('second-to-first')
    state = cycleFilterField(state, 'direction', 1, [])
    expect(state.direction).toBe('all')
    expect(cycleFilterField(state, 'address', 1, [])).toBe(state)
  })

  test('the token field cycles through the known tokens after all', () => {
    const first = cycleFilterField(EMPTY_FILTER, 'token', 1, FIXTURE_TOKENS)
    expect(first.token).toBe(FIXTURE_TOKENS[0]!.address)
    expect(cycleFilterField(first, 'token', -1, FIXTURE_TOKENS).token).toBe('all')
  })

  test('converts to the filter of a data source, leaving out every unset key', () => {
    expect(toFeedFilter(EMPTY_FILTER, 1_000)).toEqual({})
    const filter = toFeedFilter({ ...EMPTY_FILTER, direction: 'first-to-second', status: 'sent', range: '1h', address: ' 0xabc ' }, 10_000)
    expect(filter).toEqual({ direction: 'first-to-second', status: 'sent', address: '0xabc', sentAtOrAfter: 6_400 })
  })

  test('counts the active filters and gives a different key for a different state', () => {
    expect(countActiveFilters(EMPTY_FILTER)).toBe(0)
    expect(countActiveFilters({ ...EMPTY_FILTER, kind: 'token', address: '0x1' })).toBe(2)
    expect(filterKey(EMPTY_FILTER)).not.toBe(filterKey({ ...EMPTY_FILTER, kind: 'token' }))
  })
})

describe('navigation reducer', () => {
  const start = createAppState('eth-pls')

  test('opens on the pair view with the actions focused', () => {
    expect(start.view).toBe('pair')
    expect(start.focus).toBe('actions')
    expect(start.modal.kind).toBe('none')
  })

  test('focus moves through the three areas and wraps', () => {
    let state: AppState = start
    const seen: string[] = []
    for (let step = 0; step < 4; step += 1) {
      state = reduceAppState(state, { type: 'move-focus', step: 1 })
      seen.push(state.focus)
    }
    expect(seen).toEqual(['filters', 'feed', 'actions', 'filters'])
    expect(reduceAppState(start, { type: 'move-focus', step: -1 }).focus).toBe(FOCUS_AREAS[FOCUS_AREAS.length - 1]!)
  })

  test('the action index wraps and the feed index stays inside the list', () => {
    expect(reduceAppState(start, { type: 'move-action', step: -1 }).actionIndex).toBe(ACTIONS.length - 1)
    expect(reduceAppState(start, { type: 'move-feed', step: 5, count: 3 }).feedIndex).toBe(2)
    expect(reduceAppState(start, { type: 'move-feed', step: -5, count: 3 }).feedIndex).toBe(0)
    expect(reduceAppState(start, { type: 'move-feed', step: 5, count: 0 }).feedIndex).toBe(0)
  })

  test('a filter change returns the feed selection to the top', () => {
    const moved = reduceAppState(start, { type: 'move-feed', step: 4, count: 10 })
    expect(reduceAppState(moved, { type: 'cycle-filter', step: 1, tokens: [] }).feedIndex).toBe(0)
    expect(reduceAppState(moved, { type: 'clear-filters' }).feedIndex).toBe(0)
  })

  test('opening a pair switches to the pair view; opening a modal clears the notice', () => {
    const global = reduceAppState(start, { type: 'show-view', view: 'global' })
    expect(reduceAppState(global, { type: 'open-pair', pairId: 'eth-pls' }).view).toBe('pair')
    const noticed = reduceAppState(start, { type: 'notice', text: 'hello' })
    expect(reduceAppState(noticed, { type: 'open-modal', modal: { kind: 'bridge' } }).notice).toBeNull()
  })
})

describe('pair configuration', () => {
  const section = (chainId: number, tag: string) => ({
    chain_id: chainId,
    bridge: `0x${tag}1`.padEnd(42, '0'),
    mediator: `0x${tag}2`.padEnd(42, '0'),
    light_client: `0x${tag}3`.padEnd(42, '0'),
    native_router: `0x${tag}4`.padEnd(42, '0'),
    wrapped_native: `0x${tag}5`.padEnd(42, '0'),
    gate: `0x${tag}6`.padEnd(42, '0'),
  })

  test('matches deployment sections to chains by chain id, whatever their key', () => {
    const pair = buildPairConfig('eth-pls', { chain_b: section(369, 'b'), chain_a: section(1, 'a') })
    expect(pair.first.chainId).toBe(1)
    expect(pair.second.chainId).toBe(369)
    expect(pair.first.rpcEnvironmentVariable).toBe('EXPLORER_RPC_URL_1')
    expect(pair.first.contracts.deliveryRouter).toBeNull()
  })

  test('refuses an unknown pair, a missing chain and a section without a required address', () => {
    expect(() => buildPairConfig('nope', {})).toThrow(PairConfigError)
    expect(() => buildPairConfig('eth-pls', { a: section(1, 'a') })).toThrow(/chain 369/)
    expect(() => buildPairConfig('eth-pls', { a: { ...section(1, 'a'), mediator: 'bad' }, b: section(369, 'b') })).toThrow(/mediator/)
  })
})
