/**
 * The Connections view: the indexer URL and the RPC URL of each chain. The dashboard reads the indexer first and reads
 * the chains by RPC when the indexer cannot answer. Here the user sets each URL, tests it and forgets it.
 *
 * A URL can hold an API key, so the screen never shows one. It shows the host and the last four characters of the rest.
 * The user types a URL into a masked field. The secret store keeps it. A setting of the user wins over the environment,
 * and the environment wins over the default of the deployment file.
 */
import { useTerminalDimensions } from '@opentui/react'
import { useEffect, useMemo, useReducer, useState } from 'react'
import { loadConnectionSettings } from '@zk-bridge/shared/config'
import type { ConnectionRuntime } from '../data/connection-runtime'
import { describeSetting } from '../data/connection-runtime'
import type { TestOutcome } from '../config/connection-tests'
import { useConnectionStatus, useServices } from '../app/services'
import {
  checkIndexerNow,
  connectionRows,
  forgetUrlSetting,
  hasUserSettings,
  runUrlTest,
  safeMessage,
  sameSettings,
  saveUrlSetting,
  settingKeyOfRow,
  type ActionResult,
  type ConnectionRow,
} from '../app/connections-model'
import { fitColumn } from '../format/text'
import { FormView, useForm } from './form-view'
import { useKeyLayer } from './key-router'
import { ModalFrame } from './modals'
import { windowStart } from './panels'
import { RichLine, colored, muted, plain, strong, type Line } from './rich-text'
import { PasswordPrompt, storeLine, useSecretStore } from './secret-store-ui'
import { theme } from './theme'
import { ViewFrame } from './views'

type Results = Readonly<Record<string, TestOutcome | { readonly ok: 'note'; readonly message: string } | 'running'>>

/** The Connections view. In fixture mode it says that no connection is in use. */
export function ConnectionsView() {
  const { connection } = useServices()
  if (connection === null) return <FixtureNotice />
  return <LiveConnections runtime={connection} />
}

function FixtureNotice() {
  return (
    <ViewFrame view="connections" notice={null}>
      <RichLine line={[strong('Connections')]} />
      <RichLine line={[muted('Fixture data uses no connections. No indexer and no RPC URL is read.')]} />
    </ViewFrame>
  )
}

function LiveConnections({ runtime }: { readonly runtime: ConnectionRuntime }) {
  const { pair, proverSetup } = useServices()
  const terminal = useTerminalDimensions()
  const sourceLabel = useConnectionStatus()
  const [, redraw] = useReducer((count: number) => count + 1, 0)
  const rows = useMemo(() => connectionRows(pair), [pair])
  const chainIds = useMemo(() => [pair.first.chainId, pair.second.chainId], [pair])
  const secretStore = useSecretStore(proverSetup.openSecretStore)
  const { state: storeState, store } = secretStore
  const [results, setResults] = useState<Results>({})
  const [selected, setSelected] = useState(0)
  const [editing, setEditing] = useState<ConnectionRow | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // A change of the settings, from this view or from the source, redraws the rows.
  useEffect(() => runtime.subscribe(redraw), [runtime])

  // A store that opens late (after a password) may hold settings that startup could not read. Use them. A runtime that
  // already has settings of the user keeps them: the store and the runtime agree, because every save writes both.
  useEffect(() => {
    if (store === null) return
    loadConnectionSettings(store, chainIds)
      .then((loaded) => {
        if (!hasUserSettings(runtime.user()) && !sameSettings(loaded, runtime.user(), chainIds)) runtime.apply(loaded)
      })
      .catch((error: unknown) => setNotice(safeMessage(runtime, error, [])))
  }, [store, runtime, chainIds])

  const record = (id: string, result: Results[string]) => setResults((previous) => ({ ...previous, [id]: result }))

  const activate = (row: ConnectionRow) => {
    setNotice(null)
    if (row.kind === 'test') {
      record(row.id, 'running')
      void runUrlTest({ runtime, row, http: proverSetup.http }).then((outcome) => record(row.id, outcome))
      return
    }
    if (row.kind === 'check') {
      record(row.id, 'running')
      void checkIndexerNow(runtime).then((message) => record(row.id, { ok: 'note', message }))
      return
    }
    if (store === null) return setNotice('No secret store is open, so a setting cannot be saved.')
    setEditing(row)
  }

  const forget = (row: ConnectionRow) => {
    if (row.kind !== 'url') return
    if (store === null) return setNotice('No secret store is open, so a setting cannot be forgotten.')
    void forgetUrlSetting({ runtime, store, key: settingKeyOfRow(row) }).then((result) => {
      setNotice(result.ok ? 'Forgotten. The row uses the next source now.' : result.message)
      if (result.ok) setResults({})
    })
  }

  useKeyLayer(
    'view',
    (key) => {
      const row = rows[selected]
      if (key.name === 'up' || key.name === 'k') setSelected(Math.max(0, selected - 1))
      else if (key.name === 'down' || key.name === 'j') setSelected(Math.min(rows.length - 1, selected + 1))
      else if ((key.name === 'return' || key.name === 'enter') && row !== undefined) activate(row)
      else if (key.name === 'd' && row !== undefined) forget(row)
      else return false
      return true
    },
    { enabled: editing === null && storeState.phase !== 'password' ? 'on' : 'off' },
  )

  const resolved = runtime.resolved()
  const settingOf = (row: ConnectionRow) => (row.id === 'indexer' ? resolved.indexerUrl : (resolved.rpcUrls[Number(row.id.split(':')[1])] ?? null))
  const valueWidth = Math.max(10, terminal.width - 42)
  const bodyRows = Math.max(3, terminal.height - 9)
  const start = windowStart(selected, rows.length, bodyRows)
  const lines = rows.slice(start, start + bodyRows).map((row, offset): Line => {
    const isSelected = start + offset === selected
    return [
      colored(`${isSelected ? '> ' : '  '}${row.label.padEnd(34)}`, isSelected ? theme.accent : theme.text),
      ...valueSegments(row, { text: row.kind === 'url' ? describeSetting(settingOf(row)) : '', result: results[row.id], width: valueWidth }),
    ]
  })

  return (
    <ViewFrame view="connections" notice={null}>
      <RichLine line={[strong('Connections'), muted(' (the indexer first, the chains by RPC when the indexer cannot answer)')]} />
      <RichLine line={[muted('Using: '), plain(sourceLabel)]} />
      <RichLine line={[muted(storeLine(storeState, (name) => `Settings are kept in ${name}.`))]} />
      {lines.map((line, index) => (
        <RichLine key={index} line={line} />
      ))}
      <box flexGrow={1} />
      <RichLine line={[colored(notice ?? ' ', theme.warn)]} />
      <RichLine line={[muted('Up/Down  Enter edit or test  d forget your setting  A URL shows its host and last 4 characters only.')]} />
      {storeState.phase === 'password' ? <PasswordPrompt onSubmit={secretStore.open} onCancel={secretStore.skip} /> : null}
      {editing !== null && store !== null ? (
        <UrlEditor
          row={editing}
          save={(text) => saveUrlSetting({ runtime, store, key: settingKeyOfRow(editing), text, http: proverSetup.http })}
          onDone={() => {
            setEditing(null)
            setResults({})
            setNotice('Saved. The new URL is in use now.')
          }}
          onCancel={() => setEditing(null)}
        />
      ) : null}
    </ViewFrame>
  )
}

function valueSegments(row: ConnectionRow, input: { readonly text: string; readonly result: Results[string] | undefined; readonly width: number }) {
  const { text, result, width } = input
  if (row.kind === 'url') return [plain(fitColumn(text, width).trimEnd())]
  if (result === undefined) return [muted('Enter to run')]
  if (result === 'running') return [colored('running…', theme.pending)]
  if (result.ok === 'note') return [plain(fitColumn(result.message, width).trimEnd())]
  return [colored(result.ok === 'pass' ? 'PASS ' : 'FAIL ', result.ok === 'pass' ? theme.good : theme.bad), plain(fitColumn(result.message, Math.max(5, width - 5)).trimEnd())]
}

function UrlEditor(props: {
  readonly row: ConnectionRow
  readonly save: (text: string) => Promise<ActionResult>
  readonly onDone: () => void
  readonly onCancel: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'yes' | 'no'>('no')
  const isRpc = props.row.id !== 'indexer'
  const form = useForm({
    specs: [
      {
        kind: 'secret',
        name: 'url',
        label: props.row.label,
        hint: isRpc ? 'Not shown while you type. The node must report the chain id of this chain.' : 'Not shown while you type. For example http://localhost:42069',
      },
    ],
    enabled: busy === 'yes' ? 'off' : 'on',
    onSubmit: (values) => {
      const text = values.url ?? ''
      if (text.trim() === '') return props.onCancel()
      setBusy('yes')
      setError(null)
      props
        .save(text)
        .then((result) => {
          if (result.ok) return props.onDone()
          setError(result.message)
          setBusy('no')
        })
    },
    onCancel: props.onCancel,
  })
  return (
    <ModalFrame title={props.row.label} width={90} height={10}>
      <FormView form={form} width={86} />
      <RichLine line={[colored(busy === 'yes' ? 'Testing and saving…' : (error ?? ' '), busy === 'yes' ? theme.pending : theme.bad)]} />
      <RichLine line={[strong('Enter', theme.accent), plain(' saves. Esc cancels. The old value is replaced.')]} />
    </ModalFrame>
  )
}
