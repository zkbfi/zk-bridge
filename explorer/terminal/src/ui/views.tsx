/**
 * The views: pair, global, audit and prover and costs. Each loads its data and draws it. The tucked-away Prover setup
 * view lives in `setup-view.tsx`.
 */
import { useTerminalDimensions } from '@opentui/react'
import type { Dispatch } from 'react'
import { ACTIONS, VIEWS, VIEW_LABELS, type AppAction, type AppState, type ViewName } from '../app/app-state'
import { useServices } from '../app/services'
import { useSession } from '../app/session'
import { formatDuration, formatAge, fitColumn, formatTimestamp } from '../format/text'
import { formatUnits } from '../format/amounts'
import { countAuditMismatches } from '../model/audit'
import { toFeedFilter, filterKey } from '../model/filter-state'
import type { PairHealth } from '../model/types'
import { useKeyLayer } from './key-router'
import { computePairLayout } from './layout'
import { ActionPanel, FeedPanel, FilterHeader, HeadsFooter, KeyBar, Panel, SummaryBar } from './panels'
import { auditHeader, auditLine, chainOf, formatSlot, updateGasHeader, updateGasLine } from './presenters'
import { RichLine, colored, muted, plain, strong, type Line } from './rich-text'
import { theme } from './theme'
import { usePolling } from './use-polling'

const REFRESH_MILLISECONDS = 5_000

/** The title of the top panel: the views in order, the current one in brackets. The tucked-away setup view is last. */
export function viewTabsTitle(current: ViewName, width: number): string {
  const short: Readonly<Record<ViewName, string>> = { global: 'Global', pair: 'Pair', audit: 'Audit', prover: 'Prover', setup: 'Setup' }
  const labels = width >= 100 ? VIEW_LABELS : short
  return VIEWS.map((view, index) => (view === current ? `[${index + 1} ${labels[view]}]` : `${index + 1} ${labels[view]}`)).join('  ')
}

/** The action id at an index of the menu. */
function actionAt(index: number) {
  return ACTIONS[index]?.id ?? 'signer'
}

/** The pair view: summary, actions, filters and feed, and the light client heads. */
export function PairView(props: { readonly state: AppState; readonly dispatch: Dispatch<AppAction>; readonly modalOpen: 'yes' | 'no' }) {
  const { state, dispatch } = props
  const { pair, dataSource, now, chainAccess } = useServices()
  const session = useSession()
  const terminal = useTerminalDimensions()
  const layout = computePairLayout(terminal.width, terminal.height)
  const clock = now()
  const summary = usePolling(() => dataSource.getSummary(state.pairId), `summary|${state.pairId}`, REFRESH_MILLISECONDS)
  const heads = usePolling(() => dataSource.getHeads(state.pairId), `heads|${state.pairId}`, REFRESH_MILLISECONDS)
  const feed = usePolling(
    () => dataSource.getFeed(state.pairId, toFeedFilter(state.filter, now()), 200),
    `feed|${state.pairId}|${filterKey(state.filter)}`,
    REFRESH_MILLISECONDS,
  )
  const items = feed.data?.items ?? null

  useKeyLayer(
    'view',
    (key) => {
      if (key.name === 'tab') {
        dispatch({ type: 'move-focus', step: key.shift ? -1 : 1 })
        return true
      }
      if (state.focus === 'actions') return handleActions(key.name)
      if (state.focus === 'filters') return handleFilters(key.name)
      return handleFeed(key.name)
    },
    { enabled: props.modalOpen === 'yes' ? 'off' : 'on' },
  )

  function handleActions(name: string): boolean {
    if (name === 'up' || name === 'k') dispatch({ type: 'move-action', step: -1 })
    else if (name === 'down' || name === 'j') dispatch({ type: 'move-action', step: 1 })
    else if (name === 'return' || name === 'enter') {
      const id = actionAt(state.actionIndex)
      const needsSigner = id !== 'signer' && session.signer === null
      if (needsSigner) dispatch({ type: 'notice', text: 'Connect a signer first: choose "Account and signer".' })
      else dispatch({ type: 'open-modal', modal: { kind: id } })
    } else return false
    return true
  }

  function handleFilters(name: string): boolean {
    if (name === 'left' || name === 'h') dispatch({ type: 'move-filter-field', step: -1 })
    else if (name === 'right' || name === 'l') dispatch({ type: 'move-filter-field', step: 1 })
    else if (name === 'up' || name === 'k') dispatch({ type: 'cycle-filter', step: -1, tokens: session.tokens })
    else if (name === 'down' || name === 'j') dispatch({ type: 'cycle-filter', step: 1, tokens: session.tokens })
    else if (name === 'x') dispatch({ type: 'clear-filters' })
    else if ((name === 'return' || name === 'enter') && state.filterField === 'address') dispatch({ type: 'open-modal', modal: { kind: 'address-filter' } })
    else if (name === 'escape') dispatch({ type: 'focus', area: 'feed' })
    else return false
    return true
  }

  function handleFeed(name: string): boolean {
    const count = items?.length ?? 0
    if (name === 'up' || name === 'k') dispatch({ type: 'move-feed', step: -1, count })
    else if (name === 'down' || name === 'j') dispatch({ type: 'move-feed', step: 1, count })
    else if (name === 'pageup') dispatch({ type: 'move-feed', step: -10, count })
    else if (name === 'pagedown') dispatch({ type: 'move-feed', step: 10, count })
    else if ((name === 'return' || name === 'enter') && items?.[state.feedIndex] !== undefined) dispatch({ type: 'open-modal', modal: { kind: 'detail', item: items[state.feedIndex]! } })
    else return false
    return true
  }

  if (layout.mode === 'tooSmall') return <TooSmall width={terminal.width} height={terminal.height} />
  const feedHeight = layout.middleHeight - (layout.filterLines + 2)
  return (
    <box flexDirection="column" width="100%" height="100%">
      <SummaryBar title={viewTabsTitle('pair', terminal.width)} summary={summary.data} pair={pair} now={clock} layout={layout} error={summary.error} />
      <box flexDirection="row" height={layout.middleHeight}>
        <ActionPanel signer={session.signer} snapshots={session.snapshots} actionIndex={state.actionIndex} focused={state.focus === 'actions'} pair={pair} layout={layout} />
        <box flexDirection="column" flexGrow={1}>
          <FilterHeader state={state.filter} field={state.filterField} focused={state.focus === 'filters'} tokens={session.tokens} pair={pair} layout={layout} />
          <FeedPanel items={items} error={feed.error} selectedIndex={state.feedIndex} focused={state.focus === 'feed'} height={feedHeight} pair={pair} layout={layout} />
        </box>
      </box>
      <HeadsFooter heads={heads.data} pair={pair} now={clock} layout={layout} />
      <KeyBar focus={state.focus} notice={state.notice} sourceLabel={dataSource.label} mode={chainAccess.mode} width={terminal.width} />
    </box>
  )
}

function TooSmall(props: { readonly width: number; readonly height: number }) {
  return (
    <box flexDirection="column" width="100%" height="100%" justifyContent="center" alignItems="center">
      <text fg={theme.warn}>The terminal is too small.</text>
      <text fg={theme.muted}>{`It is ${props.width} by ${props.height}. The dashboard needs 78 by 22.`}</text>
    </box>
  )
}

/** A full-screen panel with the view tabs on top and the key bar below. */
export function ViewFrame(props: { readonly view: ViewName; readonly notice: string | null; readonly children: React.ReactNode }) {
  const { dataSource, chainAccess } = useServices()
  const terminal = useTerminalDimensions()
  return (
    <box flexDirection="column" width="100%" height="100%">
      <Panel title={viewTabsTitle(props.view, terminal.width)} grow={1}>
        {props.children}
      </Panel>
      <KeyBar focus={null} notice={props.notice} sourceLabel={dataSource.label} mode={chainAccess.mode} width={terminal.width} />
    </box>
  )
}

/** The global view: one line per pair with its health. */
export function GlobalView(props: { readonly state: AppState; readonly dispatch: Dispatch<AppAction>; readonly modalOpen: 'yes' | 'no' }) {
  const { state, dispatch } = props
  const { dataSource, pair, now } = useServices()
  const pairs = usePolling(() => dataSource.listPairs(), 'pairs', REFRESH_MILLISECONDS)
  const list = pairs.data ?? []
  useKeyLayer(
    'view',
    (key) => {
      if (key.name === 'up' || key.name === 'k') dispatch({ type: 'move-global', step: -1, count: list.length })
      else if (key.name === 'down' || key.name === 'j') dispatch({ type: 'move-global', step: 1, count: list.length })
      else if ((key.name === 'return' || key.name === 'enter') && list[state.globalIndex] !== undefined) dispatch({ type: 'open-pair', pairId: list[state.globalIndex]!.pairId })
      else return false
      return true
    },
    { enabled: props.modalOpen === 'yes' ? 'off' : 'on' },
  )
  return (
    <ViewFrame view="global" notice={state.notice}>
      <RichLine line={[muted(`${fitColumn('pair', 10)}${fitColumn('chains', 28)}${fitColumn('light client lag', 34)}${fitColumn('gates', 20)}${fitColumn('in flight', 10)}last activity`)]} />
      {pairs.data === null ? <text fg={theme.muted}>{pairs.error ?? 'Loading the pairs…'}</text> : null}
      {list.map((health, index) => (
        <box key={health.pairId} height={1} backgroundColor={index === state.globalIndex ? theme.selectedBackground : undefined}>
          <RichLine line={pairLine(health, pair.id, now())} />
        </box>
      ))}
      <box flexGrow={1} />
      <RichLine line={[muted('Up/Down choose a pair, Enter opens it in the pair view. The default pair is eth-pls.')]} />
    </ViewFrame>
  )
}

function pairLine(health: PairHealth, defaultPairId: string, nowSeconds: number): Line {
  const lag = health.heads.map((head) => (head.lagSlots === null ? '?' : formatDuration(Number(head.lagSlots) * head.secondsPerSlot))).join(' / ')
  const worst = (['first', 'second'] as const).map((side) => health.gates[side])
  const gateColor = worst.includes('stop') || worst.includes('sealed') ? theme.bad : worst.includes('warn') || worst.includes('stale') ? theme.warn : theme.good
  return [
    strong(fitColumn(health.pairId, 10), health.pairId === defaultPairId ? theme.accent : theme.text),
    plain(fitColumn(`${health.firstChainName} <> ${health.secondChainName}`, 28)),
    plain(fitColumn(lag, 34)),
    colored(fitColumn(worst.join('/'), 20), gateColor),
    plain(fitColumn(String(health.inFlight), 10)),
    plain(health.lastActivityAt === null ? 'none' : formatAge(nowSeconds, health.lastActivityAt)),
  ]
}

/** The audit view: escrow against bridged supply per token, fees, and every mismatch flagged. */
export function AuditView(props: { readonly state: AppState }) {
  const { dataSource } = useServices()
  const terminal = useTerminalDimensions()
  const audit = usePolling(() => dataSource.getAudit(props.state.pairId), `audit|${props.state.pairId}`, REFRESH_MILLISECONDS)
  const rows = audit.data ?? []
  const mismatches = countAuditMismatches(rows)
  const columns = terminal.width >= 112 ? 'full' : 'short'
  return (
    <ViewFrame view="audit" notice={props.state.notice}>
      <RichLine
        line={[
          strong('Escrow against bridged supply'),
          muted('  escrow = bridged supply + in flight. '),
          mismatches === 0 ? colored('No mismatch.', theme.good) : colored(`${mismatches} MISMATCH${mismatches === 1 ? '' : 'ES'}`, theme.bad),
        ]}
      />
      <RichLine line={auditHeader(columns)} />
      {audit.data === null ? <text fg={theme.muted}>{audit.error ?? 'Loading the audit…'}</text> : null}
      {rows.map((row) => (
        <RichLine key={row.token.address} line={auditLine(row, columns)} />
      ))}
      <box flexGrow={1} />
      <RichLine line={[muted('A positive difference means the mediator holds more than it owes. A negative one means more supply than escrow.')]} />
    </ViewFrame>
  )
}

/** The prover and costs view. It shows what is on chain: the light client head updates and their gas. */
export function ProverView(props: { readonly state: AppState }) {
  const { dataSource, pair, now } = useServices()
  const report = usePolling(() => dataSource.getProver(props.state.pairId), `prover|${props.state.pairId}`, REFRESH_MILLISECONDS)
  const updates = report.data?.updates ?? []
  const totalGas = updates.reduce((sum, update) => sum + update.gasUsed, 0n)
  const totals = (['first', 'second'] as const).map((side) => ({
    chain: chainOf(pair, side),
    cost: updates.filter((update) => update.side === side).reduce((sum, update) => sum + update.costWei, 0n),
  }))
  return (
    <ViewFrame view="prover" notice={props.state.notice}>
      <RichLine line={[strong('Light client updates (on chain)')]} />
      <RichLine line={updateGasHeader()} />
      {report.data === null ? <text fg={theme.muted}>{report.error ?? 'Loading the updates…'}</text> : null}
      {updates.map((update) => (
        <RichLine key={update.transactionHash} line={updateGasLine(update, { pair, now: now() })} />
      ))}
      <RichLine line={[]} />
      <RichLine line={[muted('Total gas '), plain(formatUnits(totalGas, 0, { groupThousands: true })), ...totals.flatMap((total) => [muted(`   ${total.chain.name} spent `), plain(`${formatUnits(total.cost, 18, { maximumFractionDigits: 6 })} ${total.chain.nativeSymbol}`)])]} />
      <RichLine line={[muted(`Newest head ${updates[0] === undefined ? '-' : formatSlot(updates[0].slot)} at ${updates[0] === undefined ? '-' : formatTimestamp(updates[0].at)} UTC`)]} />
      <box flexGrow={1} />
      <RichLine line={[muted('Proof timing and GPU cost are off chain, so the indexer does not hold them. A later data source may add them.')]} />
    </ViewFrame>
  )
}
