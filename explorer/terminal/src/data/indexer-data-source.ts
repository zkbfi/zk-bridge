/**
 * The data source that reads the indexer's HTTP API (`explorer/indexer/src/api`).
 *
 * Conversion rules of that API: block numbers, timestamps, slots and chain identifiers are JSON numbers. Token
 * amounts are decimal strings of base units. This file turns amounts into `bigint` at the edge and never uses a
 * `number` for an amount.
 *
 * The routes in use: `/api/summary`, `/api/heads`, `/api/feed`, `/api/tokens`, `/api/audit`, `/api/fees`,
 * `/api/head-updates` and `/api/delivery-cost`. The indexer serves one pair. A request for another pair name is refused.
 */
import { parseDeliveryCostReport } from '@zk-bridge/shared'
import { getAddress, type Hex } from 'viem'
import type {
  AuditRow,
  ChainSide,
  Direction,
  FeedFilter,
  FeedItem,
  FeedStatus,
  GateStatus,
  LightClientHead,
  PairConfig,
  PairHealth,
  PairSummary,
  ProverReport,
  TokenAmount,
  TokenInfo,
} from '../model/types'
import { FEED_STATUSES } from '../model/types'
import type { DataSource, FeedPage } from './data-source'

/** Fetches a URL and returns the parsed JSON. A test passes a fake. */
export type JsonGetter = (url: string) => Promise<unknown>

/** The answer of the indexer was not what this client expects. */
export class IndexerResponseError extends Error {
  override readonly name = 'IndexerResponseError'
}

/** Input of {@link createIndexerDataSource}. */
export interface IndexerDataSourceInput {
  /** The base URL of the indexer, for example `http://localhost:42069`. */
  readonly baseUrl: string
  readonly pair: PairConfig
  /** Replaces `fetch`. */
  readonly getJson?: JsonGetter
  /** The clock in unix seconds, for the gate staleness rule. */
  readonly now?: () => number
}

/** A confirmed gate epoch older than this counts as stale, in seconds. */
const GATE_STALE_SECONDS = 2 * 3600

const defaultGetJson: JsonGetter = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new IndexerResponseError(`The indexer answered ${response.status} for ${new URL(url).pathname}.`)
  return response.json()
}

/** Creates the data source. */
export function createIndexerDataSource(input: IndexerDataSourceInput): DataSource {
  const { pair } = input
  const base = input.baseUrl.replace(/\/$/, '')
  const getJson = input.getJson ?? defaultGetJson
  const now = input.now ?? (() => Math.floor(Date.now() / 1000))
  const sideOf = (chainId: number): ChainSide => (chainId === pair.first.chainId ? 'first' : 'second')

  function requirePair(pairId: string): void {
    if (pairId !== pair.id) throw new IndexerResponseError(`This indexer serves the pair ${pair.id}, not ${pairId}.`)
  }

  async function loadTokens(): Promise<readonly TokenInfo[]> {
    const body = record(await getJson(`${base}/api/tokens`), 'tokens answer')
    const rows = array(body.tokens, 'tokens').map((row) => record(row, 'token'))
    return rows.map((row) => tokenOf(row, rows, sideOf))
  }

  async function loadHeads(): Promise<readonly LightClientHead[]> {
    const body = record(await getJson(`${base}/api/heads`), 'heads answer')
    return array(body.heads, 'heads').map((head) => headOf(record(head, 'head'), sideOf))
  }

  async function loadGates(): Promise<Readonly<Record<ChainSide, GateStatus>>> {
    const summary = record(await getJson(`${base}/api/summary`), 'summary answer')
    return gatesOf(array(summary.gates, 'gates'), sideOf, now())
  }

  return {
    label: 'indexer',
    async listPairs(): Promise<readonly PairHealth[]> {
      const summary = record(await getJson(`${base}/api/summary`), 'summary answer')
      const heads = array(summary.heads, 'heads').map((head) => headOf(record(head, 'head'), sideOf))
      const inFlight = record(summary.inFlight, 'inFlight')
      return [
        {
          pairId: pair.id,
          label: pair.label,
          firstChainName: pair.first.name,
          secondChainName: pair.second.name,
          heads,
          gates: gatesOf(array(summary.gates, 'gates'), sideOf, now()),
          inFlight: integer(inFlight.total, 'inFlight.total'),
          lastActivityAt: latestUpdate(array(summary.lastHeadUpdates, 'lastHeadUpdates')),
        },
      ]
    },

    async getSummary(pairId): Promise<PairSummary> {
      requirePair(pairId)
      const body = record(await getJson(`${base}/api/summary`), 'summary answer')
      const tokens = await loadTokens()
      const volumeRows = array(body.volume24h, 'volume24h').map((row) => record(row, 'volume row'))
      return {
        pairId,
        heads: array(body.heads, 'heads').map((head) => headOf(record(head, 'head'), sideOf)),
        gates: gatesOf(array(body.gates, 'gates'), sideOf, now()),
        inFlight: integer(record(body.inFlight, 'inFlight').total, 'inFlight.total'),
        volume24h: {
          transferCount: volumeRows.reduce((sum, row) => sum + integer(row.transfers, 'transfers'), 0),
          byToken: volumeRows.flatMap((row) => amountsOf(row, 'volume', tokens, sideOf)),
        },
        feesAccrued: array(body.feesAccrued, 'feesAccrued').flatMap((row) => amountsOf(record(row, 'fee row'), 'accrued', tokens, sideOf)),
      }
    },

    async getFeed(pairId, filter, limit): Promise<FeedPage> {
      requirePair(pairId)
      const body = record(await getJson(`${base}/api/feed?${feedQuery(filter, limit, pair)}`), 'feed answer')
      const items = array(body.items, 'items').map((item) => feedItemOf(record(item, 'feed item'), pair, sideOf))
      return { items, hasMore: typeof body.nextCursor === 'string' }
    },

    async getHeads(pairId) {
      requirePair(pairId)
      return loadHeads()
    },

    async getAudit(pairId): Promise<readonly AuditRow[]> {
      requirePair(pairId)
      const [audit, fees, tokens] = await Promise.all([
        getJson(`${base}/api/audit`),
        getJson(`${base}/api/fees`),
        loadTokens(),
      ])
      const collected = array(record(fees, 'fees answer').balances, 'balances').map((row) => record(row, 'balance row'))
      return array(record(audit, 'audit answer').tokens, 'audit tokens').flatMap((row): AuditRow[] => {
        const entry = record(row, 'audit row')
        const token = tokenFromView(entry.token, tokens, sideOf)
        if (token === null) return []
        const collectedRow = collected.find((candidate) => {
          const view = candidate.token as { address?: string; chainId?: number } | null
          return view?.address?.toLowerCase() === token.address.toLowerCase() && view.chainId === chainIdOf(pair, token.side)
        })
        return [
          {
            token,
            escrow: bigint(entry.escrow, 'escrow'),
            bridgedSupply: bigint(entry.bridgedSupply, 'bridgedSupply'),
            inFlight: bigint(entry.pendingForward, 'pendingForward') + bigint(entry.pendingBackward, 'pendingBackward'),
            accruedFees: bigint(entry.accruedFees, 'accruedFees'),
            collectedFees: collectedRow === undefined ? 0n : bigint(collectedRow.collected, 'collected'),
          },
        ]
      })
    },

    async getProver(pairId): Promise<ProverReport> {
      requirePair(pairId)
      const body = record(await getJson(`${base}/api/head-updates?limit=50`), 'head updates answer')
      return {
        updates: array(body.items, 'items').map((item) => {
          const row = record(item, 'update')
          return {
            side: sideOf(integer(row.chainId, 'chainId')),
            slot: BigInt(integer(row.slot, 'slot')),
            gasUsed: bigint(row.gasUsed, 'gasUsed'),
            costWei: bigint(row.costWei, 'costWei'),
            transactionHash: hex(row.transactionHash, 'transactionHash'),
            poster: getAddress(string(row.poster, 'poster')),
            at: integer(row.timestamp, 'timestamp'),
          }
        }),
      }
    },

    async listTokens(pairId) {
      requirePair(pairId)
      return loadTokens()
    },

    async getDeliveryCost(chainId) {
      const body = await getJson(`${base}/api/delivery-cost?chainId=${encodeURIComponent(String(chainId))}`)
      try {
        return parseDeliveryCostReport(body)
      } catch (error) {
        throw new IndexerResponseError(`The delivery cost answer is not valid: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}

/** Builds the query string of `GET /api/feed` from a filter. */
export function feedQuery(filter: FeedFilter, limit: number, pair: PairConfig): string {
  const parameters = new URLSearchParams()
  if (filter.direction !== undefined) {
    const [from, to] = filter.direction === 'first-to-second' ? [pair.first, pair.second] : [pair.second, pair.first]
    parameters.set('direction', `${from.chainId}>${to.chainId}`)
  }
  if (filter.kind !== undefined) parameters.set('kind', filter.kind)
  if (filter.status !== undefined) parameters.set('status', filter.status)
  if (filter.token !== undefined) parameters.set('token', filter.token)
  if (filter.address !== undefined) parameters.set('address', filter.address)
  if (filter.sentAtOrAfter !== undefined) parameters.set('from', String(filter.sentAtOrAfter))
  parameters.set('limit', String(Math.min(limit, 200)))
  return parameters.toString()
}

function chainIdOf(pair: PairConfig, side: ChainSide): number {
  return side === 'first' ? pair.first.chainId : pair.second.chainId
}

function headOf(row: Record<string, unknown>, sideOf: (chainId: number) => ChainSide): LightClientHead {
  const trackedChainId = integer(row.trackedChainId, 'trackedChainId')
  const stored = nullableInteger(row.storedHeadSlot)
  const finalized = nullableInteger(row.finalizedSlot)
  const lag = nullableInteger(row.lagSlots)
  return {
    side: sideOf(integer(row.chainId, 'chainId')),
    storedHeadSlot: stored === null ? null : BigInt(stored),
    finalizedSlot: finalized === null ? null : BigInt(finalized),
    lagSlots: lag === null ? null : BigInt(lag),
    // PulseChain has 10 second slots and Ethereum has 12 second slots.
    secondsPerSlot: trackedChainId === 369 ? 10 : 12,
    lastUpdateAt: nullableInteger(row.lastUpdateTimestamp),
  }
}

/**
 * The gate status of each side, from the gate state that the indexer folds from events.
 * `sealed` is a sealed gate. No gate data is `unknown`. A gate that is not enforcing yet is `warn`. Sends that are
 * not open are `stop`. A confirmed epoch older than two hours is `stale`. Otherwise `open`.
 */
export function gatesOf(rows: readonly unknown[], sideOf: (chainId: number) => ChainSide, nowSeconds: number): Readonly<Record<ChainSide, GateStatus>> {
  const result: Record<ChainSide, GateStatus> = { first: 'unknown', second: 'unknown' }
  for (const entry of rows) {
    const row = record(entry, 'gate')
    result[sideOf(integer(row.chainId, 'chainId'))] = gateStatusOf(row, nowSeconds)
  }
  return result
}

function gateStatusOf(row: Record<string, unknown>, nowSeconds: number): GateStatus {
  if (row.sealed === true) return 'sealed'
  if (row.sealed === null && row.enforcing === null) return 'unknown'
  if (row.depositsOpen === false) return 'stop'
  if (row.enforcing !== true) return 'warn'
  const confirmed = nullableInteger(row.lastConfirmedTimestamp)
  return confirmed !== null && nowSeconds - confirmed > GATE_STALE_SECONDS ? 'stale' : 'open'
}

function latestUpdate(rows: readonly unknown[]): number | null {
  const times = rows.flatMap((entry) => {
    const update = record(entry, 'last update').update
    return update === null ? [] : [integer(record(update, 'update').timestamp, 'timestamp')]
  })
  return times.length === 0 ? null : Math.max(...times)
}

function tokenOf(row: Record<string, unknown>, rows: readonly Record<string, unknown>[], sideOf: (chainId: number) => ChainSide): TokenInfo {
  const address = getAddress(string(row.address, 'address'))
  const copy = rows.find((candidate) => candidate.isBridgedCopy === true && String(candidate.homeToken).toLowerCase() === address.toLowerCase())
  const counterpart = row.isBridgedCopy === true ? row.homeToken : copy?.address
  return {
    address,
    symbol: typeof row.symbol === 'string' ? row.symbol : `${address.slice(0, 8)}…`,
    // The indexer sets decimals to 18 by assumption when it could not read the token. `metadataRead` tells which.
    decimals: typeof row.decimals === 'number' ? row.decimals : 18,
    side: sideOf(integer(row.chainId, 'chainId')),
    counterpart: typeof counterpart === 'string' ? getAddress(counterpart) : null,
  }
}

function tokenFromView(view: unknown, tokens: readonly TokenInfo[], sideOf: (chainId: number) => ChainSide): TokenInfo | null {
  if (typeof view !== 'object' || view === null) return null
  const row = view as { address?: string; chainId?: number }
  if (typeof row.address !== 'string' || typeof row.chainId !== 'number') return null
  const side = sideOf(row.chainId)
  return tokens.find((token) => token.side === side && token.address.toLowerCase() === row.address!.toLowerCase()) ?? null
}

function amountsOf(
  row: Record<string, unknown>,
  amountKey: string,
  tokens: readonly TokenInfo[],
  sideOf: (chainId: number) => ChainSide,
): TokenAmount[] {
  const token = tokenFromView(row.token, tokens, sideOf)
  return token === null ? [] : [{ token, amount: bigint(row[amountKey], amountKey) }]
}

function feedItemOf(item: Record<string, unknown>, pair: PairConfig, sideOf: (chainId: number) => ChainSide): FeedItem {
  const direction = record(item.direction, 'direction')
  const sent = record(item.sent, 'sent')
  const delivered = item.delivered === null ? null : record(item.delivered, 'delivered')
  const transfer = item.transfer === null ? null : record(item.transfer, 'transfer')
  const sourceToken = transfer === null ? null : viewToken(transfer.sourceToken, sideOf)
  const status = string(item.status, 'status')
  if (!(FEED_STATUSES as readonly string[]).includes(status)) throw new IndexerResponseError(`Unknown status "${status}".`)
  const directionName: Direction = integer(direction.sourceChainId, 'sourceChainId') === pair.first.chainId ? 'first-to-second' : 'second-to-first'
  return {
    id: hex(item.messageId, 'messageId'),
    kind: item.kind === 'token' ? 'token' : 'message',
    direction: directionName,
    status: status as FeedStatus,
    sender: getAddress(string(transfer?.sender ?? item.sender, 'sender')),
    recipient: getAddress(string(transfer?.recipient ?? item.executor, 'recipient')),
    token: sourceToken,
    amount: transfer === null || transfer.value === null ? null : bigint(transfer.value, 'value'),
    // The API gives no fee per transfer. The audit and summary views carry fee totals.
    fee: null,
    sentAt: integer(sent.timestamp, 'sent.timestamp'),
    deliveredAt: delivered === null ? null : nullableInteger(delivered.timestamp),
    sourceTransactionHash: hex(sent.transactionHash, 'sent.transactionHash'),
    destinationTransactionHash: delivered === null || delivered.transactionHash === null ? null : hex(delivered.transactionHash, 'delivered.transactionHash'),
  }
}

function viewToken(view: unknown, sideOf: (chainId: number) => ChainSide): TokenInfo | null {
  if (typeof view !== 'object' || view === null) return null
  const row = view as Record<string, unknown>
  return {
    address: getAddress(string(row.address, 'token.address')),
    symbol: typeof row.symbol === 'string' ? row.symbol : `${String(row.address).slice(0, 8)}…`,
    decimals: typeof row.decimals === 'number' ? row.decimals : 18,
    side: sideOf(integer(row.chainId, 'token.chainId')),
    counterpart: null,
  }
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
  throw new IndexerResponseError(`The ${what} is not an object.`)
}

function array(value: unknown, what: string): unknown[] {
  if (Array.isArray(value)) return value
  throw new IndexerResponseError(`The ${what} is not a list.`)
}

function string(value: unknown, what: string): string {
  if (typeof value === 'string') return value
  throw new IndexerResponseError(`The ${what} is not text.`)
}

function integer(value: unknown, what: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  throw new IndexerResponseError(`The ${what} is not an integer.`)
}

function nullableInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

/** Amounts arrive as decimal strings. A JSON number is refused, because it may have lost digits. */
function bigint(value: unknown, what: string): bigint {
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value)
  throw new IndexerResponseError(`The amount ${what} is not a decimal string.`)
}

function hex(value: unknown, what: string): Hex {
  if (typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value)) return value.toLowerCase() as Hex
  throw new IndexerResponseError(`The ${what} is not hex.`)
}
