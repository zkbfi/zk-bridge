/**
 * Pure functions that turn data into the text of the views. No rendering happens here, so a unit test can check each
 * number and column without a terminal.
 */
import { formatUnits } from '../format/amounts'
import { fitColumn, fitColumnRight, formatAge, formatClock, formatDuration, shortenHex } from '../format/text'
import { auditDifference, countAuditMismatches, countUnverifiedRows, hasAuditMismatch, isUnverifiedRow } from '../model/audit'
import type {
  AuditRow,
  ChainConfig,
  ChainSide,
  FeedItem,
  FeedStatus,
  LightClientHead,
  PairConfig,
  PairSummary,
  PartialFigure,
  TokenAmount,
  UpdateGasRecord,
} from '../model/types'
import type { PairLayout } from './layout'
import { colored, muted, plain, strong, type Line } from './rich-text'
import { statusColor, theme } from './theme'

/** The short status words of the feed. Each is at most nine characters, so a column can hold them. */
export const STATUS_LABELS: Readonly<Record<FeedStatus, string>> = {
  sent: 'sent',
  waiting_for_finality: 'waiting',
  covered: 'covered',
  delivered: 'delivered',
  failed_call: 'failed',
  fallback_used: 'fallback',
  claimable: 'claimable',
}

/** Formats a slot number with thousands separators. */
export function formatSlot(slot: bigint): string {
  return formatUnits(slot, 0, { groupThousands: true })
}

/** Formats an amount for a table: grouped, at most four fraction digits, with the symbol. */
export function formatAmountWithSymbol(amount: bigint, decimals: number, symbol: string): string {
  return `${formatUnits(amount, decimals, { groupThousands: true, maximumFractionDigits: 4 })} ${symbol}`
}

/** Formats token amounts as `1,250 USDC · 0.8 WETH`, or a dash for none. */
export function formatTokenAmounts(amounts: readonly TokenAmount[]): string {
  if (amounts.length === 0) return '-'
  return amounts.map((entry) => formatAmountWithSymbol(entry.amount, entry.token.decimals, entry.token.symbol)).join(' | ')
}

/** The lag of a head as slots and time, for example `96 slots (16m 00s)`. */
export function formatLag(head: LightClientHead): string {
  if (head.lagSlots === null) return 'unknown'
  return `${formatSlot(head.lagSlots)} slots (${formatDuration(Number(head.lagSlots) * head.secondsPerSlot)})`
}

/** The chain config of a side. */
export function chainOf(pair: PairConfig, side: ChainSide): ChainConfig {
  return side === 'first' ? pair.first : pair.second
}

/** The other side. */
export function otherSide(side: ChainSide): ChainSide {
  return side === 'first' ? 'second' : 'first'
}

/** One line per light client head for the footer. The chain that stores the head names the chain it tracks. */
export function headLines(
  heads: readonly LightClientHead[],
  context: { pair: PairConfig; now: number; layout: PairLayout },
): readonly Line[] {
  const { pair, now, layout } = context
  return (['first', 'second'] as const).map((side): Line => {
    const head = heads.find((candidate) => candidate.side === side)
    const holder = chainOf(pair, side)
    const tracked = chainOf(pair, otherSide(side))
    if (head === undefined) return [strong(holder.name), muted(` stores no head of ${tracked.name} yet`)]
    const updated = head.lastUpdateAt === null ? 'never' : formatAge(now, head.lastUpdateAt)
    if (layout.mode === 'wide') {
      return [
        strong(holder.name),
        muted(` stores ${tracked.name}:  head `),
        plain(head.storedHeadSlot === null ? '-' : formatSlot(head.storedHeadSlot)),
        muted('  finalized '),
        plain(head.finalizedSlot === null ? '-' : formatSlot(head.finalizedSlot)),
        muted('  lag '),
        colored(formatLag(head), lagColor(head)),
        muted('  updated '),
        plain(updated),
      ]
    }
    return [
      strong(holder.nativeSymbol),
      muted(`<-${tracked.nativeSymbol} head `),
      plain(head.storedHeadSlot === null ? '-' : formatSlot(head.storedHeadSlot)),
      muted(' fin '),
      plain(head.finalizedSlot === null ? '-' : formatSlot(head.finalizedSlot)),
      muted(' lag '),
      colored(formatLag(head), lagColor(head)),
      muted(' '),
      plain(updated),
    ]
  })
}

function lagColor(head: LightClientHead): string {
  if (head.lagSlots === null) return theme.muted
  const seconds = Number(head.lagSlots) * head.secondsPerSlot
  if (seconds >= 6 * 3600) return theme.bad
  if (seconds >= 3600) return theme.warn
  return theme.good
}

/** The note that follows a summary with a partial figure. */
export const PARTIAL_SUMMARY_NOTE = '(RPC: recent history only)'

/** The figures of the summary that a partial answer can make wrong. */
const SUMMARY_FIGURES: readonly PartialFigure[] = ['volume24h', 'inFlight']

/** The mark that goes before a figure that is a lower bound. Empty for a complete figure. */
function lowerBound(summary: PairSummary, figure: PartialFigure): string {
  return summary.partial?.includes(figure) === true ? '>=' : ''
}

/**
 * The two lines of the summary bar. A figure that the RPC source read in part has a leading `>=`, and a note says why.
 */
export function summaryLines(summary: PairSummary, context: { pair: PairConfig; now: number; layout: PairLayout }): readonly Line[] {
  const { pair, layout } = context
  const volume = summary.volume24h
  const gates = (['first', 'second'] as const).flatMap((side): Line => [
    muted(` ${layout.mode === 'wide' ? chainOf(pair, side).name : chainOf(pair, side).nativeSymbol} `),
    colored(summary.gates[side], statusColor(summary.gates[side])),
  ])
  const volumeMark = lowerBound(summary, 'volume24h')
  const first: Line = [
    strong(pair.id),
    muted(`  ${pair.first.name} <> ${pair.second.name}   in flight `),
    colored(`${lowerBound(summary, 'inFlight')}${summary.inFlight}`, summary.inFlight > 0 ? theme.pending : theme.muted),
    muted('   24h '),
    plain(`${volumeMark}${volume.transferCount} transfers`),
    ...(volume.byToken.length === 0 ? [] : [muted(', '), plain(`${volumeMark}${formatTokenAmounts(volume.byToken.slice(0, 1))}`)]),
  ]
  const hasPartialFigure = SUMMARY_FIGURES.some((figure) => lowerBound(summary, figure) !== '')
  const second: Line = [
    muted('gate'),
    ...gates,
    ...(hasPartialFigure ? [muted(`  ${PARTIAL_SUMMARY_NOTE}`)] : []),
  ]
  return [first, second]
}

/** The label of a direction, using the native symbols of the chains: `ETH>PLS`. */
export function directionLabel(item: FeedItem, pair: PairConfig, length: 'short' | 'long'): string {
  const [from, to] = item.direction === 'first-to-second' ? [pair.first, pair.second] : [pair.second, pair.first]
  return length === 'long' ? `${from.nativeSymbol}>${to.nativeSymbol}` : `${from.nativeSymbol.slice(0, 1)}>${to.nativeSymbol.slice(0, 1)}`
}

/**
 * One row of the feed as colored segments. The columns depend on the layout: the compact layout keeps both
 * timestamps, the direction, the amount and the status, and drops the kind and the counterparty.
 */
export function feedRow(item: FeedItem, context: { pair: PairConfig; layout: PairLayout }): Line {
  const { pair, layout } = context
  const full = layout.feedColumns === 'full'
  const sent = fitColumn(formatClock(item.sentAt), 8)
  const delivered = fitColumn(item.deliveredAt === null ? '-' : formatClock(item.deliveredAt), 8)
  const direction = fitColumn(directionLabel(item, pair, full ? 'long' : 'short'), full ? 7 : 3)
  const amount = fitColumnRight(amountCell(item, full ? 17 : 12), full ? 17 : 12)
  const status = fitColumn(STATUS_LABELS[item.status], 9)
  const segments: Line = [
    plain(sent),
    muted(' '),
    plain(delivered),
    muted(' '),
    colored(direction, theme.accent),
    muted(' '),
    ...(full ? [muted(fitColumn(item.kind === 'token' ? 'tok' : 'msg', 3)), muted(' ')] : []),
    plain(amount),
    muted(' '),
    colored(status, statusColor(item.status)),
    ...(full ? [muted(' '), muted(fitColumn(shortenHex(item.recipient), 11))] : []),
  ]
  return segments
}

function amountCell(item: FeedItem, width: number): string {
  if (item.token === null || item.amount === null) return width < 14 ? `msg ${shortenHex(item.recipient, 2)}` : `call ${shortenHex(item.recipient, 3)}`
  return formatAmountWithSymbol(item.amount, item.token.decimals, item.token.symbol)
}

/** The header line of the feed columns, matching {@link feedRow}. */
export function feedHeader(layout: PairLayout): Line {
  const full = layout.feedColumns === 'full'
  return [
    muted(
      `${fitColumn('sent', 8)} ${fitColumn('arrived', 8)} ${fitColumn('dir', full ? 7 : 3)} ${full ? 'knd ' : ''}${fitColumnRight('amount', full ? 17 : 12)} ${fitColumn('status', 9)}${full ? ` ${fitColumn('to', 11)}` : ''}`,
    ),
  ]
}

/** Lines that describe one feed item in full, for the detail modal. */
export function detailLines(item: FeedItem, pair: PairConfig): readonly Line[] {
  const [from, to] = item.direction === 'first-to-second' ? [pair.first, pair.second] : [pair.second, pair.first]
  const row = (label: string, value: string): Line => [muted(label.padEnd(14)), plain(value)]
  return [
    row('Message', item.id),
    row('Kind', item.kind),
    row('Route', `${from.name} to ${to.name}`),
    [muted('Status'.padEnd(14)), colored(item.status, statusColor(item.status))],
    row('Sender', item.sender),
    row(item.kind === 'token' ? 'Recipient' : 'Executor', item.recipient),
    ...(item.token === null || item.amount === null
      ? []
      : [
          row('Token', `${item.token.symbol} ${item.token.address}`),
          row('Amount', `${formatUnits(item.amount, item.token.decimals)} ${item.token.symbol} (${item.amount} base units)`),
        ]),
    row(`Sent on ${from.name}`, `${new Date(item.sentAt * 1000).toISOString()}`),
    row('Source tx', item.sourceTransactionHash),
    row(`Arrived on ${to.name}`, item.deliveredAt === null ? 'not yet' : new Date(item.deliveredAt * 1000).toISOString()),
    row('Target tx', item.destinationTransactionHash ?? '-'),
  ]
}

/** The columns of the audit table. The short form drops the in-flight column. */
export type AuditColumns = 'full' | 'short'

/** One audit row as a line of fixed columns. */
export function auditLine(row: AuditRow, columns: AuditColumns): Line {
  const token = row.token
  const cell = (value: bigint) => formatUnits(value, token.decimals, { groupThousands: true, maximumFractionDigits: 4 })
  const difference = auditDifference(row)
  const flagged = hasAuditMismatch(row)
  const unverified = isUnverifiedRow(row)
  const full = columns === 'full'
  const differenceText = difference !== 0n && (flagged || unverified) ? `${difference > 0n ? '+' : ''}${cell(difference)}` : '0'
  const cells = full
    ? [fitColumn(token.symbol, 8), fitColumnRight(cell(row.escrow), 18), fitColumnRight(cell(row.bridgedSupply), 18), fitColumnRight(cell(row.inFlight), 12), fitColumnRight(differenceText, 12)]
    : [fitColumn(token.symbol, 7), fitColumnRight(cell(row.escrow), 14), fitColumnRight(cell(row.bridgedSupply), 14), fitColumnRight(differenceText, 9)]
  if (unverified) return [plain(cells.join(' ')), muted(`  ${UNVERIFIED_MARK}`)]
  return [colored(`${cells.join(' ')}  ${flagged ? 'MISMATCH' : 'ok'}`, flagged ? theme.bad : theme.text)]
}

/** The mark of an audit row that the data source could not verify. */
export const UNVERIFIED_MARK = 'unverified'

/**
 * The first line of the audit view: the verdict. Mismatches show in red. Unverified rows show in a muted count. A
 * verdict of "No mismatch." appears only when every row was verified.
 */
export function auditVerdict(rows: readonly AuditRow[]): Line {
  const unverified = countUnverifiedRows(rows)
  return [...mismatchVerdict(countAuditMismatches(rows), unverified), ...(unverified === 0 ? [] : [muted(` ${unverified} ${UNVERIFIED_MARK} ${PARTIAL_SUMMARY_NOTE}`)])]
}

function mismatchVerdict(mismatches: number, unverified: number): Line {
  if (mismatches > 0) return [colored(`${mismatches} MISMATCH${mismatches === 1 ? '' : 'ES'}`, theme.bad)]
  if (unverified > 0) return []
  return [colored('No mismatch.', theme.good)]
}

/** The header of the audit table. */
export function auditHeader(columns: AuditColumns): Line {
  const full = columns === 'full'
  const cells = full
    ? [fitColumn('token', 8), fitColumnRight('escrow', 18), fitColumnRight('bridged supply', 18), fitColumnRight('in flight', 12), fitColumnRight('difference', 12)]
    : [fitColumn('token', 7), fitColumnRight('escrow', 14), fitColumnRight('supply', 14), fitColumnRight('diff', 9)]
  return [muted(cells.join(' '))]
}

/** One update-gas row. */
export function updateGasLine(record: UpdateGasRecord, context: { pair: PairConfig; now: number }): Line {
  const chain = chainOf(context.pair, record.side)
  const cost = `${formatUnits(record.costWei, 18, { maximumFractionDigits: 6 })} ${chain.nativeSymbol}`
  return [
    plain(fitColumn(formatClock(record.at), 9)),
    plain(fitColumn(chain.name, 12)),
    plain(fitColumnRight(formatSlot(record.slot), 12)),
    plain(fitColumnRight(formatUnits(record.gasUsed, 0, { groupThousands: true }), 12)),
    plain(fitColumnRight(cost, 20)),
    muted('  '),
    plain(shortenHex(record.transactionHash)),
    muted('  '),
    plain(shortenHex(record.poster)),
  ]
}

/** The header of the update-gas table. */
export function updateGasHeader(): Line {
  return [
    muted(
      `${fitColumn('time', 9)}${fitColumn('chain', 12)}${fitColumnRight('slot', 12)}${fitColumnRight('gas used', 12)}${fitColumnRight('cost', 20)}  ${fitColumn('transaction', 13)}  poster`,
    ),
  ]
}
