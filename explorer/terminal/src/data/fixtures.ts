/**
 * Deterministic fixture data. The dashboard runs on it when the indexer is not available, and the tests use it for
 * snapshots. Every address here is a made-up pattern, not a deployed contract. The clock is a parameter, so a test
 * pins the time.
 */
import type { DeliveryCostReport } from '@zk-bridge/shared'
import { getAddress, type Address, type Hex } from 'viem'
import { auditDifference } from '../model/audit'
import { filterFeed } from '../model/feed-filter'
import type {
  AuditRow,
  Direction,
  FeedFilter,
  FeedItem,
  FeedKind,
  FeedStatus,
  LightClientHead,
  PairConfig,
  PairHealth,
  PairSummary,
  ProverReport,
  TokenInfo,
} from '../model/types'
import type { DataSource, FeedPage } from './data-source'

/** The time that fixtures treat as now, in unix seconds (2026-10-25 12:00:00 UTC). */
export const FIXTURE_NOW = 1_792_929_600

const address = (suffix: string): Address => getAddress(`0x${suffix.padStart(40, '0')}`)
const hash = (seed: number): Hex => `0x${seed.toString(16).padStart(64, '0')}`

/** The sample pair. Addresses are patterns, so no real contract is named. */
export const FIXTURE_PAIR: PairConfig = {
  id: 'eth-pls',
  label: 'Ethereum and PulseChain',
  first: {
    side: 'first',
    chainId: 1,
    name: 'Ethereum',
    nativeSymbol: 'ETH',
    rpcEnvironmentVariable: 'EXPLORER_RPC_URL_1',
    contracts: {
      messageBridge: address('b1'),
      tokenMediator: address('a1'),
      lightClient: address('c1'),
      wrappedNativeRouter: address('d1'),
      wrappedNative: address('e1'),
      gate: address('f1'),
      deliveryRouter: null,
    },
  },
  second: {
    side: 'second',
    chainId: 369,
    name: 'PulseChain',
    nativeSymbol: 'PLS',
    rpcEnvironmentVariable: 'EXPLORER_RPC_URL_369',
    contracts: {
      messageBridge: address('b2'),
      tokenMediator: address('a2'),
      lightClient: address('c2'),
      wrappedNativeRouter: address('d2'),
      wrappedNative: address('e2'),
      gate: address('f2'),
      deliveryRouter: address('aa2'),
    },
  },
}

/** The sample tokens: three native on Ethereum or PulseChain, and their bridged copies. */
export const FIXTURE_TOKENS: readonly TokenInfo[] = [
  { address: address('1001'), symbol: 'USDC', decimals: 6, side: 'first', counterpart: address('2001') },
  { address: address('2001'), symbol: 'zkbUSDC', decimals: 6, side: 'second', counterpart: address('1001') },
  { address: address('1002'), symbol: 'WETH', decimals: 18, side: 'first', counterpart: address('2002') },
  { address: address('2002'), symbol: 'zkbWETH', decimals: 18, side: 'second', counterpart: address('1002') },
  { address: address('2003'), symbol: 'WPLS', decimals: 18, side: 'second', counterpart: address('1003') },
  { address: address('1003'), symbol: 'zkbWPLS', decimals: 18, side: 'first', counterpart: address('2003') },
]

/** A made-up account that the fixtures use as the connected account. */
export const FIXTURE_ACCOUNT: Address = address('abc0')

const FIXTURE_ACCOUNTS: readonly Address[] = [FIXTURE_ACCOUNT, address('abc1'), address('abc2'), address('abc3')]

/** A small linear congruential generator, so the same seed always gives the same rows. */
function sequence(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state
  }
}

const STATUS_CYCLE: readonly FeedStatus[] = [
  'sent',
  'waiting_for_finality',
  'covered',
  'delivered',
  'delivered',
  'delivered',
  'delivered',
  'failed_call',
  'fallback_used',
  'claimable',
]

/** Builds the sample feed relative to a clock. */
export function buildFixtureFeed(nowSeconds: number): readonly FeedItem[] {
  const next = sequence(7)
  return Array.from({ length: 36 }, (_, row) => {
    const kind: FeedKind = row % 5 === 4 ? 'message' : 'token'
    const direction: Direction = next() % 3 === 0 ? 'second-to-first' : 'first-to-second'
    const status = STATUS_CYCLE[row % STATUS_CYCLE.length] ?? 'delivered'
    const sentAt = nowSeconds - 90 - row * 1_450 - (next() % 600)
    const pending = status === 'sent' || status === 'waiting_for_finality' || status === 'covered'
    const token = kind === 'message' ? null : pickToken(direction, next())
    const amount = token === null ? null : BigInt(1 + (next() % 5_000)) * 10n ** BigInt(Math.max(token.decimals - 2, 0))
    return {
      id: hash(0x100 + row),
      kind,
      direction,
      status,
      sender: FIXTURE_ACCOUNTS[next() % FIXTURE_ACCOUNTS.length] ?? FIXTURE_ACCOUNT,
      recipient: FIXTURE_ACCOUNTS[next() % FIXTURE_ACCOUNTS.length] ?? FIXTURE_ACCOUNT,
      token,
      amount,
      sentAt,
      deliveredAt: pending ? null : sentAt + 1_100 + (next() % 900),
      sourceTransactionHash: hash(0x5000 + row),
      destinationTransactionHash: pending ? null : hash(0x9000 + row),
    }
  })
}

function pickToken(direction: Direction, draw: number): TokenInfo {
  const side = direction === 'first-to-second' ? 'first' : 'second'
  const candidates = FIXTURE_TOKENS.filter((token) => token.side === side)
  return candidates[draw % candidates.length] ?? FIXTURE_TOKENS[0]!
}

/** The sample light client heads. */
export function buildFixtureHeads(nowSeconds: number): readonly LightClientHead[] {
  return [
    {
      side: 'first',
      storedHeadSlot: 25_800_000n,
      finalizedSlot: 25_800_096n,
      lagSlots: 96n,
      secondsPerSlot: 10,
      lastUpdateAt: nowSeconds - 1_410,
    },
    {
      side: 'second',
      storedHeadSlot: 14_100_000n,
      finalizedSlot: 14_100_064n,
      lagSlots: 64n,
      secondsPerSlot: 12,
      lastUpdateAt: nowSeconds - 860,
    },
  ]
}

const usdc = FIXTURE_TOKENS[0]!
const weth = FIXTURE_TOKENS[2]!
const wpls = FIXTURE_TOKENS[4]!

/** The sample audit rows. The last row has a mismatch on purpose. */
export const FIXTURE_AUDIT: readonly AuditRow[] = [
  { token: usdc, escrow: 1_250_000_000_000n, bridgedSupply: 1_249_000_000_000n, inFlight: 1_000_000_000n },
  { token: weth, escrow: 812n * 10n ** 18n, bridgedSupply: 800n * 10n ** 18n, inFlight: 12n * 10n ** 18n },
  { token: wpls, escrow: 90_000_000n * 10n ** 18n, bridgedSupply: 90_000_300n * 10n ** 18n, inFlight: 0n },
]

/** The sample prover report. */
export function buildFixtureProver(nowSeconds: number): ProverReport {
  return {
    updates: [
      { side: 'second', slot: 14_100_000n, gasUsed: 98_851n, costWei: 98_851n * 2_000_000_000_000n, transactionHash: hash(0xa001), poster: FIXTURE_ACCOUNT, at: nowSeconds - 840 },
      { side: 'first', slot: 25_800_000n, gasUsed: 118_763n, costWei: 118_763n * 14_000_000_000n, transactionHash: hash(0xa002), poster: FIXTURE_ACCOUNT, at: nowSeconds - 1_390 },
    ],
  }
}

/** Input of {@link createFixtureDataSource}. */
export interface FixtureDataSourceInput {
  /** The clock in unix seconds. Defaults to {@link FIXTURE_NOW}. */
  readonly now?: () => number
}

/**
 * The sample delivery cost report of one chain. The delivery with a callback is measured (40 deliveries, p90). The
 * other two kinds are defaults, so the sample mode shows both kinds of data source line. The base fee is 7 gwei and
 * the native coin costs 2500 dollars, so one delivery pays 8000000000000 wei of a 0.02 dollar proof.
 *
 * @param chainId The chain that the report is for.
 * @param now The clock in unix seconds. The base fee block is 12 seconds old.
 */
export function buildFixtureDeliveryCost(chainId: number, now: number): DeliveryCostReport {
  return {
    chainId,
    baseFee: { wei: '7000000000', blockNumber: 21_000_000, timestamp: now - 12 },
    proofCost: { usd: '0.02', nativeCoinPriceUsd: '2500', deliveriesPerProof: 1, wei: '8000000000000', isEstimate: true },
    kinds: {
      token_callback: { sampleCount: 40, averageGas: '185000', p90Gas: '210000', defaultGas: '300000', isDefault: false },
      token: { sampleCount: 0, averageGas: null, p90Gas: null, defaultGas: '250000', isDefault: true },
      message: { sampleCount: 0, averageGas: null, p90Gas: null, defaultGas: '200000', isDefault: true },
    },
  }
}

/** Creates a data source over the fixture data. */
export function createFixtureDataSource(input: FixtureDataSourceInput = {}): DataSource {
  const now = input.now ?? (() => FIXTURE_NOW)

  function summary(): PairSummary {
    const feed = buildFixtureFeed(now())
    const dayStart = now() - 86_400
    const recent = feed.filter((item) => item.sentAt >= dayStart && item.token !== null)
    const inFlight = feed.filter((item) => item.deliveredAt === null).length
    return {
      pairId: FIXTURE_PAIR.id,
      heads: buildFixtureHeads(now()),
      gates: { first: 'open', second: 'warn' },
      inFlight,
      volume24h: {
        transferCount: recent.length,
        byToken: [{ token: usdc, amount: recent.filter((item) => item.token === usdc).reduce((sum, item) => sum + (item.amount ?? 0n), 0n) }],
      },
    }
  }

  return {
    label: 'fixture',
    async listPairs(): Promise<readonly PairHealth[]> {
      const current = summary()
      return [
        {
          pairId: FIXTURE_PAIR.id,
          label: FIXTURE_PAIR.label,
          firstChainName: FIXTURE_PAIR.first.name,
          secondChainName: FIXTURE_PAIR.second.name,
          heads: current.heads,
          gates: current.gates,
          inFlight: current.inFlight,
          lastActivityAt: now() - 90,
        },
      ]
    },
    async getSummary() {
      return summary()
    },
    async getFeed(_pairId: string, filter: FeedFilter, limit: number): Promise<FeedPage> {
      const rows = filterFeed(buildFixtureFeed(now()), filter)
      return { items: rows.slice(0, limit), hasMore: rows.length > limit }
    },
    async getHeads() {
      return buildFixtureHeads(now())
    },
    async getAudit() {
      return FIXTURE_AUDIT
    },
    async getProver() {
      return buildFixtureProver(now())
    },
    async listTokens() {
      return FIXTURE_TOKENS
    },
    async getDeliveryCost(chainId) {
      return buildFixtureDeliveryCost(chainId, now())
    },
  }
}

/** The audit difference of the fixture row with a mismatch, for tests. */
export const FIXTURE_MISMATCH_DIFFERENCE = auditDifference(FIXTURE_AUDIT[2]!)
