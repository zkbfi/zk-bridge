/**
 * The panels of the pair view: summary, light client footer, filter header, feed, action area and key bar.
 * Each takes data and layout as props and draws them. None loads data.
 */
import type { ReactNode } from 'react'
import type { ChainSnapshotResult } from '../chain/live-reads'
import { formatUnits } from '../format/amounts'
import { fitColumn, formatTimestamp, shortenHex } from '../format/text'
import { FILTER_FIELDS, type FilterField, type FilterState } from '../model/filter-state'
import type { FeedItem, LightClientHead, PairConfig, PairSummary, TokenInfo } from '../model/types'
import type { FocusArea } from '../app/app-state'
import { ACTIONS } from '../app/app-state'
import type { Signer } from '../signing/signer'
import type { PairLayout } from './layout'
import { feedHeader, feedRow, formatAmountWithSymbol, headLines, summaryLines, chainOf } from './presenters'
import { RichLine, colored, muted, plain, strong, type Line } from './rich-text'
import { theme } from './theme'

/** A bordered box with a title. Focus changes the border color. */
export function Panel(props: {
  readonly title: string
  readonly focused?: boolean
  readonly width?: number
  readonly height?: number
  readonly grow?: number
  readonly children: ReactNode
}) {
  return (
    <box
      border
      borderStyle="single"
      borderColor={props.focused === true ? theme.borderFocused : theme.border}
      title={props.title}
      flexDirection="column"
      overflow="hidden"
      {...(props.width === undefined ? {} : { width: props.width })}
      {...(props.height === undefined ? {} : { height: props.height })}
      {...(props.grow === undefined ? {} : { flexGrow: props.grow })}
    >
      {props.children}
    </box>
  )
}

/** The summary across the top. */
export function SummaryBar(props: { readonly title: string; readonly summary: PairSummary | null; readonly pair: PairConfig; readonly now: number; readonly layout: PairLayout; readonly error: string | null }) {
  const { summary, pair, now, layout, error } = props
  const lines: readonly Line[] =
    summary === null
      ? [[muted(error === null ? 'Loading the summary…' : `Summary unavailable: ${error}`)]]
      : summaryLines(summary, { pair, now, layout })
  return (
    <Panel title={props.title} height={layout.summaryHeight}>
      {lines.map((line, index) => (
        <RichLine key={index} line={line} />
      ))}
    </Panel>
  )
}

/** The footer with the light client heads of both chains. */
export function HeadsFooter(props: { readonly heads: readonly LightClientHead[] | null; readonly pair: PairConfig; readonly now: number; readonly layout: PairLayout }) {
  const { heads, pair, now, layout } = props
  const lines: readonly Line[] = heads === null ? [[muted('Loading the light client heads…')]] : headLines(heads, { pair, now, layout })
  return (
    <Panel title="Light client heads" height={layout.headsHeight}>
      {lines.map((line, index) => (
        <RichLine key={index} line={line} />
      ))}
    </Panel>
  )
}

const FIELD_LABELS: Readonly<Record<FilterField, string>> = {
  direction: 'Dir',
  kind: 'Kind',
  status: 'Status',
  token: 'Token',
  address: 'Addr',
  range: 'Time',
}

/** The words that the header shows for a filter value. */
export function filterValueText(state: FilterState, field: FilterField, tokens: readonly TokenInfo[], pair: PairConfig): string {
  if (field === 'direction') {
    if (state.direction === 'all') return 'all'
    return state.direction === 'first-to-second' ? `${pair.first.nativeSymbol}>${pair.second.nativeSymbol}` : `${pair.second.nativeSymbol}>${pair.first.nativeSymbol}`
  }
  if (field === 'token') {
    if (state.token === 'all') return 'all'
    return tokens.find((token) => token.address === state.token)?.symbol ?? shortenHex(state.token)
  }
  if (field === 'address') return state.address === '' ? 'any' : shortenHex(state.address)
  return state[field]
}

/** The fixed header of the feed: the six filters, one highlighted when the header has focus. */
export function FilterHeader(props: {
  readonly state: FilterState
  readonly field: FilterField
  readonly focused: boolean
  readonly tokens: readonly TokenInfo[]
  readonly pair: PairConfig
  readonly layout: PairLayout
}) {
  const { state, field, focused, tokens, pair, layout } = props
  const cells: Line[] = FILTER_FIELDS.map((name) => {
    const selected = focused && name === field
    const text = `${FIELD_LABELS[name]}:${filterValueText(state, name, tokens, pair)}`
    const active = state[name] !== (name === 'address' ? '' : 'all')
    return [colored(selected ? `[${text}]` : ` ${text} `, selected ? theme.accent : active ? theme.warn : theme.muted)]
  })
  const perLine = Math.ceil(cells.length / layout.filterLines)
  const rows = Array.from({ length: layout.filterLines }, (_, row) => cells.slice(row * perLine, (row + 1) * perLine).flat())
  return (
    <Panel title="Filters" focused={focused} height={layout.filterLines + 2}>
      {rows.map((row, index) => (
        <RichLine key={index} line={row} />
      ))}
    </Panel>
  )
}

/** The feed of transfers and messages, newest first, with the selected row highlighted. */
export function FeedPanel(props: {
  readonly items: readonly FeedItem[] | null
  readonly error: string | null
  readonly selectedIndex: number
  readonly focused: boolean
  readonly height: number
  readonly pair: PairConfig
  readonly layout: PairLayout
  /** Unix seconds from which the RPC source has read the history, or null when the page is complete. */
  readonly coveredFrom: number | null
}) {
  const { items, error, selectedIndex, focused, height, pair, layout, coveredFrom } = props
  const rows = Math.max(1, height - (coveredFrom === null ? 3 : 4))
  const body = (): ReactNode => {
    if (items === null) return <text fg={theme.muted}>{error === null ? 'Loading the feed…' : `Feed unavailable: ${error}`}</text>
    if (items.length === 0) return <text fg={theme.muted}>No transfers or messages match the filters.</text>
    const start = windowStart(selectedIndex, items.length, rows)
    return items.slice(start, start + rows).map((item, offset) => {
      const selected = start + offset === selectedIndex
      return (
        <box key={item.id} height={1} backgroundColor={selected && focused ? theme.selectedBackground : undefined}>
          <RichLine line={feedRow(item, { pair, layout })} />
        </box>
      )
    })
  }
  const position = items === null || items.length === 0 ? '' : ` ${selectedIndex + 1}/${items.length}`
  return (
    <Panel title={`Feed${position}`} focused={focused} grow={1}>
      <RichLine line={feedHeader(layout)} />
      {coveredFrom === null ? null : <RichLine line={[muted(coverageNote(coveredFrom))]} />}
      {body()}
    </Panel>
  )
}

/** The line above a feed that the RPC source read in part. */
export function coverageNote(coveredFrom: number): string {
  return `RPC fallback: history since ${formatTimestamp(coveredFrom)} UTC`
}

/** The first row to draw so that the selected row stays in view. */
export function windowStart(selectedIndex: number, count: number, rows: number): number {
  if (count <= rows) return 0
  const centered = selectedIndex - Math.floor(rows / 2)
  return Math.max(0, Math.min(centered, count - rows))
}

/** The action area: account, balances on both chains, and the menu. */
export function ActionPanel(props: {
  readonly signer: Signer | null
  readonly snapshots: readonly ChainSnapshotResult[] | null
  readonly actionIndex: number
  readonly focused: boolean
  readonly pair: PairConfig
  readonly layout: PairLayout
}) {
  const { signer, snapshots, actionIndex, focused, pair, layout } = props
  const lines: Line[] = [
    [strong('Account')],
    ...accountLines(signer, layout),
    [strong('Balances')],
    ...balanceLines({ signer, snapshots, pair, layout }),
    [strong('Actions')],
    ...ACTIONS.map((action, index): Line => {
      const selected = focused && index === actionIndex
      return [colored(`${selected ? '> ' : '  '}${action.label}`, selected ? theme.accent : theme.text)]
    }),
  ]
  return (
    <Panel title="Account and actions" focused={focused} width={layout.actionWidth}>
      {lines.map((line, index) => (
        <RichLine key={index} line={line} />
      ))}
    </Panel>
  )
}

function accountLines(signer: Signer | null, layout: PairLayout): readonly Line[] {
  if (signer === null) return [[muted(' no signer connected')]]
  const address = layout.mode === 'wide' ? signer.address : shortenHex(signer.address, 6)
  return [[muted(' '), plain(signer.description)], [muted(' '), plain(address)]]
}

function balanceLines(input: {
  signer: Signer | null
  snapshots: readonly ChainSnapshotResult[] | null
  pair: PairConfig
  layout: PairLayout
}): readonly Line[] {
  const { signer, snapshots, pair, layout } = input
  if (signer === null) return [[muted(' connect a signer')]]
  if (snapshots === null) return [[muted(' loading…')]]
  return snapshots.flatMap((result): readonly Line[] => {
    if (result.status === 'error') return [[colored(` ${result.chain.name}: ${fitColumn(result.message, 24).trim()}`, theme.bad)]]
    const { snapshot } = result
    const chain = chainOf(pair, snapshot.chain.side)
    const native = `${formatUnits(snapshot.nativeBalance, 18, { maximumFractionDigits: 4, groupThousands: true })} ${chain.nativeSymbol}`
    const tokens = snapshot.positions.map((position) => ({
      text: formatAmountWithSymbol(position.balance, position.token.decimals, position.token.symbol),
      claimable: position.claimable,
      symbol: position.token.symbol,
    }))
    if (layout.mode === 'compact') {
      return [[strong(` ${chain.nativeSymbol} `), plain([native, ...tokens.map((token) => token.text)].join(' | '))]]
    }
    return [
      [strong(` ${chain.name}`), muted(`  ${native}`)],
      ...tokens.map(
        (token): Line => [
          muted('   '),
          plain(token.text),
          ...(token.claimable > 0n ? [colored(`  +claimable`, theme.warn)] : []),
        ],
      ),
    ]
  })
}

/** The one-line key bar at the bottom, with the transient notice and the data source label. */
export function KeyBar(props: { readonly focus: FocusArea | null; readonly notice: string | null; readonly sourceLabel: string; readonly mode: 'rpc' | 'fixture'; readonly width: number }) {
  const { focus, notice, sourceLabel, mode, width } = props
  const hints: Readonly<Record<FocusArea, string>> = {
    actions: 'Enter open  Up/Down move',
    filters: 'Left/Right field  Up/Down value  x clear',
    feed: 'Up/Down move  Enter details',
  }
  const banner = mode === 'fixture' ? ' FIXTURE: no transaction reaches a chain ' : ''
  const left = `Tab area  1-5 views  ? help  q quit  ${focus === null ? '' : hints[focus]}`
  const text = notice ?? left
  const label = fitColumn(sourceLabel, Math.min(sourceLabel.length, Math.max(8, Math.floor(width / 2))))
  return (
    <box height={1} flexDirection="row">
      <text wrapMode="none" truncate fg={notice === null ? theme.muted : theme.warn}>
        {fitColumn(text, Math.max(10, width - label.length - banner.length - 3))}
      </text>
      <text fg={theme.bad}>{banner}</text>
      <text fg={theme.muted}>{` ${label}`}</text>
    </box>
  )
}
