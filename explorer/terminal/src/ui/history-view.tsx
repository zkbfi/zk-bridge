/**
 * The history of sends, deliveries and light client head updates, as a pageable list with filters. It reads what the
 * history page of the dapp reads: the indexer first, the chains by RPC when the indexer cannot answer. A page from the
 * chains is partial, and the screen says so and names the filters it could not apply.
 */
import { useEffect, useRef, useState } from 'react'
import { encodeHistoryCursor, parseHistoryCursor, type HistoryCursor, type HistoryEvent } from '@zk-bridge/shared'
import { useServices } from '../app/services'
import {
  HISTORY_EVENT_KIND_CYCLE,
  HISTORY_EVENT_LABELS,
  HISTORY_STATUS_CYCLE,
  NO_HISTORY_CHOICES,
  filtersOf,
  nextInCycle,
  readHistoryPage,
  realHistoryTransport,
  type HistoryChoices,
  type HistoryReading,
  type HistoryScanKeeper,
  type HistoryTransport,
} from '../data/history-source'
import { fitColumn } from '../format/text'
import { formatTimestamp, shortenHex } from '../format/text'
import type { PairConfig } from '../model/types'
import { useKeyLayer } from './key-router'
import { ModalFrame } from './modals'
import { RichLine, colored, muted, plain, strong, type Line } from './rich-text'
import { theme } from './theme'
import { usePolling } from './use-polling'

const DIRECTION_CYCLE = [null, 'first-to-second', 'second-to-first'] as const

/** The name of a chain of the pair by its identifier. */
function chainName(pair: PairConfig, chainId: number): string {
  return [pair.first, pair.second].find((chain) => chain.chainId === chainId)?.name ?? String(chainId)
}

/** The words of the filter line. */
export function choiceLine(pair: PairConfig, choices: HistoryChoices): Line {
  const direction = choices.direction === null ? 'all' : choices.direction === 'first-to-second' ? `${pair.first.name} to ${pair.second.name}` : `${pair.second.name} to ${pair.first.name}`
  return [
    muted('Chain '),
    plain(choices.chain === null ? 'all' : chainName(pair, choices.chain)),
    muted('   Event '),
    plain(choices.eventKind === null ? 'all' : HISTORY_EVENT_LABELS[choices.eventKind]),
    muted('   Status '),
    plain(choices.status ?? 'all'),
    muted('   Direction '),
    plain(direction),
  ]
}

/** One row of the list: the time, the kind, the chain, what the event is about and the status. */
export function eventLine(pair: PairConfig, event: HistoryEvent): Line {
  const about = event.messageId === null ? `slot ${event.slot}` : shortenHex(event.messageId, 6)
  return [
    muted(`${formatTimestamp(Number(event.timestamp))}  `),
    plain(fitColumn(HISTORY_EVENT_LABELS[event.kind], 13)),
    plain(fitColumn(chainName(pair, event.chainId), 12)),
    plain(fitColumn(about, 22)),
    plain(event.status ?? '-'),
  ]
}

/** The lines under the list that say where the page came from and what it leaves out. */
export function sourceLines(pair: PairConfig, reading: HistoryReading): readonly Line[] {
  if (reading.source === 'indexer') return [[muted('From the indexer.')]]
  const lines: Line[] = [[colored('From the chains. This page is partial: a send has a status only when its delivery was scanned.', theme.warn)]]
  if (reading.unappliedFilters.length > 0) lines.push([colored(`Not applied by the chains: ${reading.unappliedFilters.join(', ')}.`, theme.warn)])
  for (const entry of reading.readBack) lines.push([muted(`${chainName(pair, entry.chainId)} was read back to block ${entry.block}. Older events are not listed.`)])
  return lines
}

/** The modal of the history. */
export function HistoryModal(props: {
  readonly onClose: () => void
  /** Replaces the network reads. A test passes fakes. */
  readonly transport?: HistoryTransport
}) {
  const { pair, connection } = useServices()
  const transport = props.transport ?? realHistoryTransport
  const [choices, setChoices] = useState<HistoryChoices>(NO_HISTORY_CHOICES)
  // The cursor that starts each page. The first page starts at no cursor.
  const [cursors, setCursors] = useState<readonly (HistoryCursor | null)[]>([null])
  const scans = useRef<HistoryScanKeeper>(new Map())
  const leaving = useRef(new AbortController())
  useEffect(() => () => leaving.current.abort(new Error('The history closed.')), [])

  const cursor = cursors[cursors.length - 1] ?? null
  const sharedPair = connection?.sharedPair
  const reading = usePolling(
    async () => {
      if (connection === null || sharedPair === undefined) throw new Error('The history needs a live connection. Fixture data has none.')
      return readHistoryPage({ connection: connection.connection(), pair: sharedPair, filters: filtersOf({ pair: sharedPair, choices, cursor }), transport, scans: scans.current, signal: leaving.current.signal })
    },
    `history|${JSON.stringify(choices)}|${cursor === null ? 'first' : encodeHistoryCursor(cursor)}`,
    0,
  )

  const change = (next: HistoryChoices) => {
    setChoices(next)
    setCursors([null])
  }
  const chainCycle = [null, pair.first.chainId, pair.second.chainId]

  useKeyLayer('modal', (key) => {
    if (key.name === 'escape') props.onClose()
    else if (key.name === 'c') change({ ...choices, chain: nextInCycle(chainCycle, choices.chain) })
    else if (key.name === 'e') change({ ...choices, eventKind: nextInCycle(HISTORY_EVENT_KIND_CYCLE, choices.eventKind) })
    else if (key.name === 's') change({ ...choices, status: nextInCycle(HISTORY_STATUS_CYCLE, choices.status) })
    else if (key.name === 'd') change({ ...choices, direction: nextInCycle(DIRECTION_CYCLE, choices.direction) })
    else if (key.name === 'x') change(NO_HISTORY_CHOICES)
    else if (key.name === 'n') {
      const next = reading.data?.page.nextCursor
      const parsed = next === null || next === undefined ? null : parseHistoryCursor(next)
      if (parsed !== null) setCursors([...cursors, parsed])
    } else if (key.name === 'p') setCursors(cursors.length > 1 ? cursors.slice(0, -1) : cursors)
    else if (key.name === 'r') reading.refresh()
    return true
  })

  const data = reading.data
  const items = data?.page.items ?? []
  return (
    <ModalFrame title="History" width={100} height={28}>
      <RichLine line={choiceLine(pair, choices)} />
      <RichLine line={[muted(`Page ${cursors.length}${data?.page.nextCursor === null || data === null ? ' (the last page)' : ''}`)]} />
      {data === null ? <RichLine line={[reading.error === null ? colored('Reading the history…', theme.pending) : colored(reading.error, theme.bad)]} /> : null}
      {data !== null && items.length === 0 ? <RichLine line={[muted('No event matches.')]} /> : null}
      {items.map((event, index) => (
        <RichLine key={`${event.transactionHash}-${index}`} line={eventLine(pair, event)} />
      ))}
      <box flexGrow={1} />
      {data === null ? null : sourceLines(pair, data).map((line, index) => <RichLine key={index} line={line} />)}
      {data !== null && reading.error !== null ? <RichLine line={[colored(`The last read failed: ${reading.error}`, theme.warn)]} /> : null}
      <RichLine line={[strong('c e s d', theme.accent), plain(' change a filter  '), strong('x', theme.accent), plain(' clear  '), strong('n p', theme.accent), plain(' next or previous page  '), strong('r', theme.accent), plain(' read again  Esc closes')]} />
    </ModalFrame>
  )
}
