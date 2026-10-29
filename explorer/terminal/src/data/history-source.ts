/**
 * The history read of the terminal. It follows the history page of the dapp: the indexer answers while the connection
 * trusts it, and the chains answer, in part, when it does not. The query text, the filters and the paging are the same.
 * The page of the dapp keeps this logic in `explorer/web/src/views/history-model.ts`. A later change should move the
 * shared part into `explorer/shared`.
 */
import {
  DEFAULT_MAXIMUM_BLOCKS,
  compareHistoryEvents,
  createHttpChainReader,
  encodeHistoryCursor,
  fetchJsonResponse,
  historyEventKey,
  messageOnlyFilterNames,
  parseHistoryEvents,
  picksMessagesOnly,
  scanHistory,
  MESSAGE_STATUSES,
  type ChainReader,
  type ExplorerConnection,
  type HistoryCursor,
  type HistoryEvent,
  type HistoryEventKind,
  type HistoryFilters,
  type HistoryPage,
  type HistoryScan,
  type HttpChainReaderInput,
  type JsonFetcher,
  type MessageStatus,
  type Pair,
} from '@zk-bridge/shared'

/** The most rows in one page. The dapp uses the same size. */
export const HISTORY_PAGE_SIZE = 20

/** The values of the four filters that the terminal offers. Null means no filter. */
export interface HistoryChoices {
  /** The chain where the event happened. */
  readonly chain: number | null
  readonly eventKind: HistoryEventKind | null
  readonly status: MessageStatus | null
  /** `first-to-second` means from the first chain of the pair to the second. */
  readonly direction: 'first-to-second' | 'second-to-first' | null
}

/** The choices with no filter on. */
export const NO_HISTORY_CHOICES: HistoryChoices = { chain: null, eventKind: null, status: null, direction: null }

/** The kinds of event, in the order that the filter cycles through them. */
export const HISTORY_EVENT_KIND_CYCLE: readonly (HistoryEventKind | null)[] = [null, 'sent', 'delivered', 'head-update']

/** The words for each kind of event. */
export const HISTORY_EVENT_LABELS: Readonly<Record<HistoryEventKind, string>> = { sent: 'Sent', delivered: 'Delivered', 'head-update': 'Head update' }

/** The statuses, in the order that the filter cycles through them. */
export const HISTORY_STATUS_CYCLE: readonly (MessageStatus | null)[] = [null, ...MESSAGE_STATUSES]

/**
 * The value after `current` in a cycle that starts at null. A value that is not in the cycle gives the first value.
 *
 * @param values The cycle.
 * @param current The value now.
 */
export function nextInCycle<Value>(values: readonly Value[], current: Value): Value {
  const index = values.indexOf(current)
  return values[(index + 1) % values.length] as Value
}

/**
 * The filters of the indexer query for a set of choices and a page position.
 *
 * @param input The pair, the choices and the cursor of the page (null for the first page).
 */
export function filtersOf(input: { readonly pair: Pair; readonly choices: HistoryChoices; readonly cursor: HistoryCursor | null }): HistoryFilters {
  const [first, second] = input.pair.sides
  const { direction } = input.choices
  return {
    direction:
      direction === null
        ? null
        : direction === 'first-to-second'
          ? { sourceChainId: first.chainId, destinationChainId: second.chainId }
          : { sourceChainId: second.chainId, destinationChainId: first.chainId },
    kind: null,
    statuses: input.choices.status === null ? [] : [input.choices.status],
    token: null,
    address: null,
    from: null,
    to: null,
    limit: HISTORY_PAGE_SIZE,
    chain: input.choices.chain,
    eventKind: input.choices.eventKind,
    cursor: input.cursor,
  }
}

/**
 * The query text of the filters, without the question mark, in a fixed order. It writes only what is set.
 *
 * @param filters The filters.
 */
export function historyQueryOf(filters: HistoryFilters): string {
  const params = new URLSearchParams()
  if (filters.chain !== null) params.set('chain', String(filters.chain))
  if (filters.eventKind !== null) params.set('eventKind', filters.eventKind)
  if (filters.direction !== null) params.set('direction', `${filters.direction.sourceChainId}>${filters.direction.destinationChainId}`)
  if (filters.statuses.length > 0) params.set('status', filters.statuses.join(','))
  params.set('limit', String(filters.limit))
  if (filters.cursor !== null) params.set('cursor', encodeHistoryCursor(filters.cursor))
  return params.toString()
}

const otherChainOf = (pair: Pair, chainId: number): number => (pair.sides.find((side) => side.chainId !== chainId) as Pair['sides'][number]).chainId

/** True when an event is on the direction: a send leaves the source, a delivery arrives, a head update sits on the destination. */
function matchesDirection(pair: Pair, event: HistoryEvent, direction: NonNullable<HistoryFilters['direction']>): boolean {
  if (event.kind === 'head-update') return event.chainId === direction.destinationChainId
  const source = event.kind === 'sent' ? event.chainId : otherChainOf(pair, event.chainId)
  const destination = event.kind === 'sent' ? otherChainOf(pair, event.chainId) : event.chainId
  return source === direction.sourceChainId && destination === direction.destinationChainId
}

function keepsEvent(pair: Pair, filters: HistoryFilters, event: HistoryEvent): boolean {
  // A head update belongs to no message, so a message filter leaves it out, as the indexer does.
  if (event.kind === 'head-update' && picksMessagesOnly(filters)) return false
  if (filters.chain !== null && event.chainId !== filters.chain) return false
  if (filters.eventKind !== null && event.kind !== filters.eventKind) return false
  return filters.direction === null || matchesDirection(pair, event, filters.direction)
}

/** A stand-in event at the position of a cursor, to compare the real events with it. */
function eventAtCursor(cursor: HistoryCursor): HistoryEvent {
  const isHead = cursor.kind === 'head-update'
  const [chainText, slotText] = cursor.key.split('-') as [string, string]
  return {
    kind: cursor.kind,
    chainId: isHead ? Number(chainText) : 0,
    timestamp: cursor.timestamp,
    transactionHash: `0x${'00'.repeat(32)}`,
    messageId: isHead ? null : (cursor.key as HistoryEvent['messageId']),
    slot: isHead ? BigInt(slotText) : null,
    status: null,
  }
}

/**
 * Cuts one page out of the events that the chains gave. It applies the filters that the chains can apply (chain, kind of
 * event and direction), skips what the cursor has passed, and sets the next cursor as the indexer does.
 *
 * @param pair The pair.
 * @param events Every event, newest first.
 * @param filters The filters, with the page size and the cursor.
 */
export function pageOfScannedEvents(pair: Pair, events: readonly HistoryEvent[], filters: HistoryFilters): HistoryPage {
  const marker = filters.cursor === null ? null : eventAtCursor(filters.cursor)
  const kept = events.filter((event) => keepsEvent(pair, filters, event) && (marker === null || compareHistoryEvents(event, marker) > 0))
  const items = kept.slice(0, filters.limit)
  const last = items[items.length - 1]
  const nextCursor = last !== undefined && kept.length > filters.limit ? encodeHistoryCursor({ timestamp: last.timestamp, kind: last.kind, key: historyEventKey(last) }) : null
  return { items, nextCursor, partial: true }
}

/** The part of a live connection that the read uses. */
export type HistoryConnection = Pick<ExplorerConnection, 'baseUrl' | 'run' | 'resolved' | 'redact'>

/**
 * Scans of the chains that are kept, so a new page or a new filter does not read the chains again. The key is the pair,
 * the chains and the block limit. A failed scan leaves the map, so the next read tries again.
 */
export type HistoryScanKeeper = Map<string, Promise<HistoryScan>>

/** What a read gives. */
export interface HistoryReading {
  readonly page: HistoryPage
  /** Which source answered. */
  readonly source: 'indexer' | 'rpc'
  /** The filters that are on and that this source did not apply. */
  readonly unappliedFilters: readonly string[]
  /** The chains that the scan did not read to the start of their history, with the lowest block each read. */
  readonly readBack: readonly { readonly chainId: number; readonly block: bigint }[]
}

/** The network parts of a read. A test passes fakes. */
export interface HistoryTransport {
  readonly fetchJson: JsonFetcher
  readonly createReader: (input: HttpChainReaderInput) => ChainReader
}

/** The transport that uses `fetch` and viem. */
export const realHistoryTransport: HistoryTransport = { fetchJson: fetchJsonResponse, createReader: createHttpChainReader }

async function readFromIndexer(input: { readonly connection: HistoryConnection; readonly filters: HistoryFilters; readonly transport: HistoryTransport; readonly signal: AbortSignal | undefined }): Promise<HistoryReading> {
  input.signal?.throwIfAborted()
  const response = await input.transport.fetchJson(`${input.connection.baseUrl}/api/history?${historyQueryOf(input.filters)}`, input.signal)
  input.signal?.throwIfAborted()
  if (response.status !== 200) throw new Error(`The indexer answered ${response.status} for the history.`)
  const page = parseHistoryEvents(response.body)
  if (page === null) throw new Error('The indexer gave an answer for the history that is not a page of the history.')
  return { page, source: 'indexer', unappliedFilters: [], readBack: [] }
}

function keptScan(input: { readonly scans: HistoryScanKeeper | undefined; readonly key: string; readonly scan: () => Promise<HistoryScan> }): Promise<HistoryScan> {
  const { scans, key, scan } = input
  if (scans === undefined) return scan()
  const running = scans.get(key) ?? scan()
  scans.set(key, running)
  running.catch(() => scans.delete(key))
  return running
}

async function readFromChains(input: { readonly connection: HistoryConnection; readonly pair: Pair | undefined; readonly filters: HistoryFilters; readonly transport: HistoryTransport; readonly scans: HistoryScanKeeper | undefined; readonly signal: AbortSignal | undefined }): Promise<HistoryReading> {
  const { pair, connection } = input
  if (pair === undefined) throw new Error('This connection has no deployment, so it cannot read the chains.')
  const readers = new Map<number, ChainReader>()
  const urls: string[] = []
  for (const side of pair.sides) {
    const url = connection.resolved.rpcUrls[side.chainId]?.value
    if (url === undefined) throw new Error(`No endpoint is set for ${side.name}.`)
    urls.push(url)
    readers.set(side.chainId, input.transport.createReader({ chainId: side.chainId, name: side.name, url }))
  }
  const scan = () => scanHistory({ pair, readers, fromBlock: 0n, maximumBlocks: DEFAULT_MAXIMUM_BLOCKS, ...(input.signal === undefined ? {} : { signal: input.signal }) })
  const key = [pair.name, ...urls, DEFAULT_MAXIMUM_BLOCKS].join('|')
  const scanned = await keptScan({ scans: input.scans, key, scan })
  return {
    page: pageOfScannedEvents(pair, scanned.items, input.filters),
    source: 'rpc',
    unappliedFilters: messageOnlyFilterNames(input.filters),
    readBack: scanned.coverage.filter((entry) => !entry.reachedStart).map((entry) => ({ chainId: entry.chainId, block: entry.scannedFromBlock })),
  }
}

/**
 * Reads one page of the history. The indexer answers while the connection trusts it. Otherwise the chains answer, and
 * the page is marked partial.
 *
 * @param input The connection, the pair (null in a fake that has none), the filters, the transport and the signal.
 */
export function readHistoryPage(input: {
  readonly connection: HistoryConnection
  readonly pair: Pair | undefined
  readonly filters: HistoryFilters
  readonly transport: HistoryTransport
  /** Keeps the scan of the chains between reads. */
  readonly scans?: HistoryScanKeeper
  readonly signal?: AbortSignal
}): Promise<HistoryReading> {
  const { connection, pair, filters, transport, scans, signal } = input
  return connection
    .run({
      viaIndexer: () => readFromIndexer({ connection, filters, transport, signal }),
      viaRpc: () => readFromChains({ connection, pair, filters, transport, scans, signal }),
      ...(signal === undefined ? {} : { signal }),
    })
    .catch((error: unknown) => {
      throw redactedError(error, connection.redact)
    })
}

/**
 * The same error with its message redacted. A reader of the chains can put a URL with a key into an error, and the
 * screen must never show it.
 *
 * @param error What was thrown.
 * @param redact The redactor of the connection.
 */
function redactedError(error: unknown, redact: (text: string) => string): Error {
  const message = redact(error instanceof Error ? error.message : String(error))
  const clean = new Error(message)
  if (error instanceof Error) clean.name = error.name
  return clean
}
