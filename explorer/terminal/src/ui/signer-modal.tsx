/**
 * The dialog that connects a signer: a private key, a key file, a keystore, a mnemonic, a Ledger or a Trezor.
 *
 * Secrets are typed or pasted into masked fields. They are never drawn, logged or written. A secret that came from the
 * environment at startup is used when the field is left empty, and the field then says so without showing it.
 */
import { useEffect, useState } from 'react'
import { useServices } from '../app/services'
import { useSession } from '../app/session'
import { formatUnits } from '../format/amounts'
import { shortenHex } from '../format/text'
import { DEFAULT_PATH_TEMPLATE } from '../signing/mnemonic'
import type { AddressSource, DerivedAddress, Signer } from '../signing/signer'
import type { FieldSpec } from './form'
import { FormView, useForm } from './form-view'
import { useKeyLayer } from './key-router'
import { ModalFrame } from './modals'
import { RichLine, colored, muted, plain, strong } from './rich-text'
import { theme } from './theme'

type Step =
  | { readonly name: 'choose' }
  | { readonly name: 'private-key' | 'key-file' | 'keystore' | 'mnemonic' }
  | { readonly name: 'addresses'; readonly source: AddressSource; readonly kind: 'mnemonic' | 'ledger' | 'trezor' }

const CHOICES = [
  { id: 'private-key', label: 'Private key (paste, or the startup variable)' },
  { id: 'key-file', label: 'Private key file' },
  { id: 'keystore', label: 'Encrypted keystore (Foundry or Ethereum, version 3)' },
  { id: 'mnemonic', label: 'Mnemonic (BIP-39) with derivation' },
  { id: 'ledger', label: 'Ledger (USB, Ethereum app)' },
  { id: 'trezor', label: 'Trezor' },
] as const

/** The signer dialog. */
export function SignerModal(props: { readonly onClose: () => void }) {
  const session = useSession()
  const { signing } = useServices()
  const [step, setStep] = useState<Step>({ name: 'choose' })
  const [prompt, setPrompt] = useState<string | null>(null)

  const connect = (signer: Signer) => {
    session.setSigner(signer)
    props.onClose()
  }

  if (step.name === 'choose') {
    return (
      <ChooseStep
        hasSigner={session.signer !== null}
        onClose={props.onClose}
        onDisconnect={() => {
          session.setSigner(null)
          props.onClose()
        }}
        onChoose={(id) => {
          if (id === 'ledger') return setStep({ name: 'addresses', kind: 'ledger', source: signing.ledgerSource({ onDevicePrompt: setPrompt }) })
          if (id === 'trezor') return setStep({ name: 'addresses', kind: 'trezor', source: signing.trezorSource({ onDevicePrompt: setPrompt }) })
          setStep({ name: id })
        }}
      />
    )
  }
  if (step.name === 'addresses') {
    return <AddressPicker source={step.source} kind={step.kind} prompt={prompt} onBack={() => { void step.source.dispose(); setStep({ name: 'choose' }) }} onConnect={connect} />
  }
  return <SecretStep kind={step.name} onBack={() => setStep({ name: 'choose' })} onConnect={connect} onAddresses={(source) => setStep({ name: 'addresses', kind: 'mnemonic', source })} />
}

function ChooseStep(props: {
  readonly hasSigner: boolean
  readonly onClose: () => void
  readonly onDisconnect: () => void
  readonly onChoose: (id: (typeof CHOICES)[number]['id']) => void
}) {
  const entries = [...CHOICES.map((choice) => ({ id: choice.id as string, label: choice.label })), ...(props.hasSigner ? [{ id: 'disconnect', label: 'Disconnect the current signer' }] : [])]
  const [index, setIndex] = useState(0)
  useKeyLayer('modal', (key) => {
    if (key.name === 'escape') props.onClose()
    else if (key.name === 'up' || key.name === 'k') setIndex((index + entries.length - 1) % entries.length)
    else if (key.name === 'down' || key.name === 'j') setIndex((index + 1) % entries.length)
    else if (key.name === 'return' || key.name === 'enter') {
      const chosen = entries[index]
      if (chosen?.id === 'disconnect') props.onDisconnect()
      else if (chosen !== undefined) props.onChoose(chosen.id as (typeof CHOICES)[number]['id'])
    }
    return true
  })
  return (
    <ModalFrame title="Account and signer" width={72} height={entries.length + 6}>
      <RichLine line={[muted('Every transaction is shown in full and needs your confirmation.')]} />
      <RichLine line={[]} />
      {entries.map((entry, row) => (
        <RichLine key={entry.id} line={[colored(`${row === index ? '> ' : '  '}${entry.label}`, row === index ? theme.accent : theme.text)]} />
      ))}
      <box flexGrow={1} />
      <RichLine line={[muted('Up/Down choose, Enter select, Esc close')]} />
    </ModalFrame>
  )
}

function SecretStep(props: {
  readonly kind: 'private-key' | 'key-file' | 'keystore' | 'mnemonic'
  readonly onBack: () => void
  readonly onConnect: (signer: Signer) => void
  readonly onAddresses: (source: AddressSource) => void
}) {
  const { signing } = useServices()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'yes' | 'no'>('no')
  const { startupSecrets, fileHints } = signing
  const fromStartup = (present: boolean, name: string) => (present ? `Empty uses ${name} from startup.` : 'Typed text is masked and never stored.')

  const specsByKind: Record<typeof props.kind, readonly FieldSpec[]> = {
    'private-key': [{ kind: 'secret', name: 'secret', label: 'Private key', hint: fromStartup(startupSecrets.privateKey !== undefined, 'EXPLORER_PRIVATE_KEY') }],
    'key-file': [{ kind: 'text', name: 'path', label: 'Key file', initial: fileHints.privateKeyFile ?? '', hint: 'The file must be readable by you only (chmod 600).' }],
    keystore: [
      { kind: 'text', name: 'path', label: 'Keystore file', initial: fileHints.keystoreFile ?? '', hint: 'A file that cast wallet import wrote.' },
      { kind: 'secret', name: 'password', label: 'Password', hint: 'Not shown while you type. Decrypted in memory only.' },
    ],
    mnemonic: [
      { kind: 'secret', name: 'secret', label: 'Mnemonic', hint: fromStartup(startupSecrets.mnemonic !== undefined, 'EXPLORER_MNEMONIC') },
      { kind: 'secret', name: 'passphrase', label: 'Passphrase (optional)', hint: 'The BIP-39 passphrase. Empty means none.' },
      { kind: 'text', name: 'template', label: 'Derivation path', initial: DEFAULT_PATH_TEMPLATE, hint: "Use {index} for the account number, for example m/44'/60'/0'/0/{index}" },
    ],
  }

  const run = (values: Readonly<Record<string, string>>): Promise<void> => {
    if (props.kind === 'private-key') {
      const text = values.secret || startupSecrets.privateKey
      if (!text) return Promise.reject(new Error('Enter a private key.'))
      props.onConnect(signing.signerFromPrivateKeyText(text))
      return Promise.resolve()
    }
    if (props.kind === 'key-file') return signing.signerFromPrivateKeyFile(values.path ?? '').then(props.onConnect)
    if (props.kind === 'keystore') return signing.signerFromKeystoreFile(values.path ?? '', values.password ?? '').then(props.onConnect)
    const mnemonic = values.secret || startupSecrets.mnemonic
    if (!mnemonic) return Promise.reject(new Error('Enter a mnemonic.'))
    const source = signing.mnemonicSource(mnemonic, values.passphrase || startupSecrets.mnemonicPassphrase || '')
    props.onAddresses(source)
    return Promise.resolve()
  }

  const form = useForm({
    specs: specsByKind[props.kind],
    enabled: busy === 'yes' ? 'off' : 'on',
    onSubmit: (values) => {
      setBusy('yes')
      setError(null)
      // A thrown error and a rejected promise both end up as the same message on the form.
      Promise.resolve()
        .then(() => run(values))
        .catch((caught: unknown) => {
          setError(caught instanceof Error ? caught.message : 'The signer could not be opened.')
          setBusy('no')
        })
    },
    onCancel: props.onBack,
  })
  return (
    <ModalFrame title={`Connect: ${props.kind}`} width={84} height={12}>
      <FormView form={form} width={80} />
      <RichLine line={[colored(busy === 'yes' ? 'Working… (a keystore can take a second)' : (error ?? ' '), error === null ? theme.muted : theme.bad)]} />
      <RichLine line={[muted('Enter continues. Esc goes back.')]} />
    </ModalFrame>
  )
}

const PAGE_SIZE = 5

function AddressPicker(props: {
  readonly source: AddressSource
  readonly kind: 'mnemonic' | 'ledger' | 'trezor'
  readonly prompt: string | null
  readonly onBack: () => void
  readonly onConnect: (signer: Signer) => void
}) {
  const { chainAccess, pair } = useServices()
  const [template, setTemplate] = useState(DEFAULT_PATH_TEMPLATE)
  const [page, setPage] = useState(0)
  const [index, setIndex] = useState(0)
  const [rows, setRows] = useState<readonly (DerivedAddress & { first: bigint | null; second: bigint | null })[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<'yes' | 'no'>('no')
  const [opening, setOpening] = useState<'yes' | 'no'>('no')

  useEffect(() => {
    let current = true
    setRows(null)
    setError(null)
    props.source
      .listAddresses({ pathTemplate: template, start: page * PAGE_SIZE, count: PAGE_SIZE })
      .then(async (listed) => {
        const balances = await chainAccess.nativeBalances(listed.map((entry) => entry.address))
        if (current) setRows(listed.map((entry, position) => ({ ...entry, first: balances[position]?.first ?? null, second: balances[position]?.second ?? null })))
      })
      .catch((caught: unknown) => {
        if (current) setError(caught instanceof Error ? caught.message : 'The addresses could not be listed.')
      })
    return () => {
      current = false
    }
  }, [props.source, template, page, chainAccess])

  const pick = () => {
    const row = rows?.[index]
    if (row === undefined || opening === 'yes') return
    setOpening('yes')
    props.source
      .openSigner(row.path)
      .then((signer) => {
        // A hardware signer needs the connection of its source. The wrapper closes the source with the signer.
        const keepsSource = props.kind !== 'mnemonic'
        if (!keepsSource) void props.source.dispose()
        props.onConnect(keepsSource ? { ...signer, dispose: async () => { await signer.dispose(); await props.source.dispose() } } : signer)
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : 'The signer could not be opened.')
        setOpening('no')
      })
  }

  useKeyLayer(
    'modal',
    (key) => {
      if (key.name === 'escape') props.onBack()
      else if (key.name === 'up' || key.name === 'k') setIndex(Math.max(0, index - 1))
      else if (key.name === 'down' || key.name === 'j') setIndex(Math.min(PAGE_SIZE - 1, index + 1))
      else if (key.name === 'n' || key.name === 'pagedown') {
        setPage(page + 1)
        setIndex(0)
      } else if (key.name === 'p' || key.name === 'pageup') {
        setPage(Math.max(0, page - 1))
        setIndex(0)
      } else if (key.name === 't') setEditing('yes')
      else if (key.name === 'return' || key.name === 'enter') pick()
      return true
    },
    { enabled: editing === 'yes' ? 'off' : 'on' },
  )

  if (editing === 'yes') {
    return <TemplateForm current={template} onApply={(next) => { setTemplate(next); setPage(0); setIndex(0); setEditing('no') }} onCancel={() => setEditing('no')} />
  }
  const balance = (value: bigint | null, symbol: string) => (value === null ? '?' : `${formatUnits(value, 18, { maximumFractionDigits: 4 })} ${symbol}`)
  return (
    <ModalFrame title={`Choose an account (${props.kind})`} width={96} height={16}>
      <RichLine line={[muted('Path '), plain(template), muted(`   page ${page + 1}`)]} />
      {rows === null && error === null ? <text fg={theme.muted}>{props.prompt ?? 'Reading addresses…'}</text> : null}
      {error === null ? null : <text fg={theme.bad}>{error}</text>}
      {(rows ?? []).map((row, position) => (
        <RichLine
          key={row.path}
          line={[
            colored(`${position === index ? '> ' : '  '}${String(row.index).padStart(3)} `, position === index ? theme.accent : theme.muted),
            strong(row.address, position === index ? theme.accent : theme.text),
            muted(`  ${balance(row.first, pair.first.nativeSymbol)} | ${balance(row.second, pair.second.nativeSymbol)}`),
          ]}
        />
      ))}
      <box flexGrow={1} />
      <RichLine line={[colored(opening === 'yes' ? (props.prompt ?? 'Opening… confirm the address on the device if it asks.') : ' ', theme.warn)]} />
      <RichLine line={[muted('Up/Down choose  Enter select  n/p next or previous page  t change path  Esc back')]} />
    </ModalFrame>
  )
}

function TemplateForm(props: { readonly current: string; readonly onApply: (template: string) => void; readonly onCancel: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const form = useForm({
    specs: [{ kind: 'text', name: 'template', label: 'Derivation path', initial: props.current, hint: "Use {index}, for example m/44'/60'/{index}'/0/0" }],
    onSubmit: (values) => {
      const text = (values.template ?? '').trim()
      if (!/^m(\/\d+'?)+$/.test(text.split('{index}').join('0'))) return setError("A path looks like m/44'/60'/0'/0/{index}.")
      props.onApply(text)
    },
    onCancel: props.onCancel,
  })
  return (
    <ModalFrame title="Derivation path" width={90} height={8}>
      <FormView form={form} width={86} />
      <text fg={theme.bad}>{error ?? ' '}</text>
    </ModalFrame>
  )
}

/** The text for the address in the account panel is built from the signer. Exported for the panel tests. */
export function signerSummary(signer: Signer): string {
  return `${signer.description} ${shortenHex(signer.address, 6)}`
}
