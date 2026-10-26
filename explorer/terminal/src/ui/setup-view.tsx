/**
 * The Prover setup view. It is deliberately tucked away: the last view in the switcher and the last line of the help,
 * never the default, and nothing on the main path leads here. It stores configuration only. The proof publisher bot
 * reads the same file.
 *
 * Secrets are typed into masked fields. After entry the screen shows only the last four characters. A secret goes to
 * the operating system secret store, or to an encrypted file, or stays in an environment variable or a 1Password item
 * that the configuration only points at.
 */
import { useTerminalDimensions } from '@opentui/react'
import { useEffect, useMemo, useState } from 'react'
import { useServices } from '../app/services'
import {
  directionsText,
  referenceOfRow,
  secretNameOfRow,
  setupRows,
  withNextDirections,
  withReference,
  withTextValue,
  withToggledWaitPolicy,
  type SetupRow,
} from '../app/setup-model'
import { testDryProofRequest, testEndpointPing, testMsgboardStatus, testRpcChainId, type TestOutcome } from '../config/connection-tests'
import {
  emptyProverSetup,
  maskSecret,
  parseReferenceText,
  type ProverSetup,
  ProverSetupError,
  redactError,
  referenceText,
  resolveSecretReference,
  type SecretReference,
  type SecretStore,
} from '@zk-bridge/shared/config'
import { FormView, useForm } from './form-view'
import { useKeyLayer } from './key-router'
import { ModalFrame } from './modals'
import { windowStart } from './panels'
import { ViewFrame } from './views'
import { PasswordPrompt, storeLine, useSecretStore } from './secret-store-ui'
import { RichLine, colored, muted, plain, strong, type Line } from './rich-text'
import { theme } from './theme'

type Editing = { readonly kind: 'none' } | { readonly kind: 'text' | 'secret'; readonly row: SetupRow }

/** The Prover setup view. */
export function SetupView() {
  const { pair, proverSetup } = useServices()
  const terminal = useTerminalDimensions()
  const rows = useMemo(() => setupRows(pair), [pair])
  const [setup, setSetup] = useState<ProverSetup>(() => emptyProverSetup(pair.id))
  const secretStore = useSecretStore(proverSetup.openSecretStore)
  const { state: storeState, store } = secretStore
  const [masks, setMasks] = useState<Readonly<Record<string, string>>>({})
  const [results, setResults] = useState<Readonly<Record<string, TestOutcome | 'running'>>>({})
  const [selected, setSelected] = useState(0)
  const [editing, setEditing] = useState<Editing>({ kind: 'none' })
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    proverSetup.load().then(setSetup).catch((error: unknown) => setNotice(redactError(error)))
  }, [proverSetup])

  // Masked tails: only the masked text is kept in state, never the value.
  useEffect(() => {
    let current = true
    const compute = async () => {
      const next: Record<string, string> = {}
      for (const row of rows.filter((candidate) => candidate.kind === 'secret')) {
        const reference = referenceOfRow(setup, row.id)
        next[row.id] = await describeReference(reference, { store, environment: proverSetup.environment })
      }
      if (current) setMasks(next)
    }
    void compute()
    return () => {
      current = false
    }
  }, [setup, store, rows, proverSetup.environment])

  const persist = (next: ProverSetup) => {
    setSetup(next)
    proverSetup.save(next).catch((error: unknown) => setNotice(`Not saved: ${redactError(error)}`))
  }

  const resolve = (reference: SecretReference | null, what: string): Promise<string> => {
    if (reference === null) return Promise.reject(new Error(`${what} is not set.`))
    return resolveSecretReference(reference, { store, environment: proverSetup.environment, run: proverSetup.run })
  }

  const runTest = (row: SetupRow) => {
    setResults((previous) => ({ ...previous, [row.id]: 'running' }))
    const secretsSeen: string[] = []
    const need = async (reference: SecretReference | null, what: string) => {
      const value = await resolve(reference, what)
      secretsSeen.push(value)
      return value
    }
    const perform = async (): Promise<TestOutcome> => {
      if (row.id === 'test:ping' || row.id === 'test:dry') {
        if (setup.endpointUrl === '') return { ok: 'fail', message: 'The endpoint URL is not set.' }
        const apiKey = await need(setup.runpodApiKey, 'The RunPod API key')
        const input = { endpointUrl: setup.endpointUrl, apiKey }
        return row.id === 'test:ping' ? testEndpointPing(proverSetup.http, input) : testDryProofRequest(proverSetup.http, input)
      }
      if (row.id === 'test:msgboard') return testMsgboardStatus(proverSetup.http, { url: await need(setup.msgboardUrl, 'The msgboard URL') })
      const chainId = Number(row.id.split(':')[2])
      const rpcUrl = await need(setup.chains[String(chainId)]?.rpc ?? null, `The RPC URL of chain ${chainId}`)
      return testRpcChainId(proverSetup.http, { rpcUrl, expectedChainId: chainId })
    }
    perform()
      .catch((error: unknown): TestOutcome => ({ ok: 'fail', message: redactError(error, secretsSeen) }))
      .then((outcome) => setResults((previous) => ({ ...previous, [row.id]: outcome })))
  }

  const activate = (row: SetupRow) => {
    setNotice(null)
    if (row.kind === 'test') return runTest(row)
    if (row.kind === 'directions') return persist(withNextDirections(setup))
    if (row.kind === 'toggle') return persist(withToggledWaitPolicy(setup))
    setEditing({ kind: row.kind === 'secret' ? 'secret' : 'text', row })
  }

  const clearSecret = async (row: SetupRow) => {
    const reference = referenceOfRow(setup, row.id)
    if (row.kind !== 'secret' || reference === null) return
    try {
      if (reference.source === 'store' && store !== null) await store.delete(reference.name)
      persist(withReference(setup, row.id, null))
    } catch (error) {
      setNotice(redactError(error))
    }
  }

  useKeyLayer(
    'view',
    (key) => {
      const row = rows[selected]
      if (key.name === 'up' || key.name === 'k') setSelected(Math.max(0, selected - 1))
      else if (key.name === 'down' || key.name === 'j') setSelected(Math.min(rows.length - 1, selected + 1))
      else if ((key.name === 'return' || key.name === 'enter') && row !== undefined) activate(row)
      else if (key.name === 'd' && row !== undefined) void clearSecret(row)
      else return false
      return true
    },
    { enabled: editing.kind === 'none' && storeState.phase !== 'password' ? 'on' : 'off' },
  )

  const bodyRows = Math.max(3, terminal.height - 8)
  const start = windowStart(selected, rows.length, bodyRows)
  const lines: Line[] = rows.slice(start, start + bodyRows).map((row, offset): Line => {
    const isSelected = start + offset === selected
    const result = results[row.id]
    return [
      colored(`${isSelected ? '> ' : '  '}${row.label.padEnd(34)}`, isSelected ? theme.accent : theme.text),
      ...valueSegments(row, { setup, pair, mask: masks[row.id], result }),
    ]
  })

  return (
    <ViewFrame view="setup" notice={null}>
      <RichLine line={[strong('Prover setup'), muted(' (operator only: stores configuration, nothing runs from here)')]} />
      <RichLine line={[muted(storeLine(storeState, (name) => `Secrets: ${name}, or env variables, or 1Password.`))]} />
      {lines.map((line, index) => (
        <RichLine key={index} line={line} />
      ))}
      <box flexGrow={1} />
      <RichLine line={[colored(notice ?? ' ', theme.warn)]} />
      <RichLine line={[muted('Up/Down  Enter edit or test  d forget a secret  A secret shows its last 4 characters only.')]} />
      {storeState.phase === 'password' ? <PasswordPrompt onSubmit={secretStore.open} onCancel={secretStore.skip} /> : null}
      {editing.kind === 'text' ? <TextEditor row={editing.row} setup={setup} onApply={(next) => { persist(next); setEditing({ kind: 'none' }) }} onCancel={() => setEditing({ kind: 'none' })} /> : null}
      {editing.kind === 'secret' ? (
        <SecretEditor
          row={editing.row}
          store={store}
          setup={setup}
          onApply={(next) => {
            persist(next)
            setEditing({ kind: 'none' })
          }}
          onCancel={() => setEditing({ kind: 'none' })}
        />
      ) : null}
    </ViewFrame>
  )
}

async function describeReference(reference: SecretReference | null, input: { store: SecretStore | null; environment: Readonly<Record<string, string | undefined>> }): Promise<string> {
  if (reference === null) return 'not set'
  if (reference.source === 'onepassword') return referenceText(reference)
  if (reference.source === 'environment') {
    const value = input.environment[reference.variable]
    return value === undefined || value === '' ? `env:${reference.variable} (not set)` : `env:${reference.variable}  ${maskSecret(value)}`
  }
  if (input.store === null) return 'stored (store locked)'
  try {
    const value = await input.store.get(reference.name)
    return value === null ? 'stored value is missing' : `stored  ${maskSecret(value)}`
  } catch {
    return 'stored (cannot read)'
  }
}

function valueSegments(row: SetupRow, input: { setup: ProverSetup; pair: ReturnType<typeof useServices>['pair']; mask: string | undefined; result: TestOutcome | 'running' | undefined }) {
  const { setup, pair, mask, result } = input
  if (row.kind === 'test') {
    if (result === undefined) return [muted('Enter to run')]
    if (result === 'running') return [colored('running…', theme.pending)]
    return [colored(result.ok === 'pass' ? 'PASS ' : 'FAIL ', result.ok === 'pass' ? theme.good : theme.bad), plain(result.message)]
  }
  if (row.kind === 'secret') return [plain(mask ?? '…')]
  if (row.id === 'endpoint') return [plain(setup.endpointUrl === '' ? 'not set' : setup.endpointUrl)]
  if (row.id === 'directions') return [plain(directionsText(setup, pair))]
  if (row.id === 'whenWaits') return [plain(setup.policy.proveWhenTransferWaits ? 'yes' : 'no')]
  return [plain(String(setup.policy.intervalSeconds))]
}

function TextEditor(props: { readonly row: SetupRow; readonly setup: ProverSetup; readonly onApply: (setup: ProverSetup) => void; readonly onCancel: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const initial = props.row.id === 'endpoint' ? props.setup.endpointUrl : String(props.setup.policy.intervalSeconds)
  const form = useForm({
    specs: [{ kind: 'text', name: 'value', label: props.row.label, initial, hint: props.row.id === 'endpoint' ? 'For example https://<id>.api.runpod.ai (no key in the URL)' : 'Zero means only when a transfer waits.' }],
    onSubmit: (values) => {
      try {
        props.onApply(withTextValue(props.setup, props.row.id, values.value ?? ''))
      } catch (caught) {
        setError(caught instanceof ProverSetupError ? caught.message : redactError(caught))
      }
    },
    onCancel: props.onCancel,
  })
  return (
    <ModalFrame title={props.row.label} width={90} height={8}>
      <FormView form={form} width={86} />
      <RichLine line={[colored(error ?? ' ', theme.bad)]} />
    </ModalFrame>
  )
}

function SecretEditor(props: {
  readonly row: SetupRow
  readonly store: SecretStore | null
  readonly setup: ProverSetup
  readonly onApply: (setup: ProverSetup) => void
  readonly onCancel: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'yes' | 'no'>('no')
  const form = useForm({
    specs: [
      { kind: 'secret', name: 'secret', label: 'New secret', hint: 'Not shown while you type. Stored in the secret store, not in any file.' },
      { kind: 'text', name: 'reference', label: 'Or a reference', placeholder: 'env:NAME or op://vault/item/field', hint: 'A reference stores nothing: the value is read when needed.' },
    ],
    enabled: busy === 'yes' ? 'off' : 'on',
    onSubmit: (values) => {
      const secret = values.secret ?? ''
      const referenceTextValue = (values.reference ?? '').trim()
      if (secret !== '' && referenceTextValue !== '') return setError('Fill one of the two fields, not both.')
      if (secret === '' && referenceTextValue === '') return props.onCancel()
      try {
        if (referenceTextValue !== '') return props.onApply(withReference(props.setup, props.row.id, parseReferenceText(referenceTextValue)))
        if (props.store === null) return setError('No secret store is open. Use a reference instead.')
        setBusy('yes')
        const name = secretNameOfRow(props.row.id)
        props.store
          .set(name, secret)
          .then(() => props.onApply(withReference(props.setup, props.row.id, { source: 'store', name })))
          .catch((caught: unknown) => {
            setError(redactError(caught, [secret]))
            setBusy('no')
          })
      } catch (caught) {
        setError(caught instanceof ProverSetupError ? caught.message : redactError(caught, [secret]))
      }
    },
    onCancel: props.onCancel,
  })
  return (
    <ModalFrame title={props.row.label} width={90} height={10}>
      <FormView form={form} width={86} />
      <RichLine line={[colored(error ?? ' ', theme.bad)]} />
      <RichLine line={[strong('Enter', theme.accent), plain(' saves. Esc cancels. The old value is replaced.')]} />
    </ModalFrame>
  )
}
