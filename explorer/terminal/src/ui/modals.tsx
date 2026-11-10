/**
 * Modal dialogs: the frame, the transaction review, the feed detail, the address filter and the help overlay.
 */
import { useTerminalDimensions } from '@opentui/react'
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { terminalGateCheck } from '../app/gate-check'
import { useServices } from '../app/services'
import { useSession } from '../app/session'
import { createTransactionFlow, type FlowStep, type FlowState } from '../flow/transaction-flow'
import type { GateWait } from '../tx/gate-step'
import type { FeedItem } from '../model/types'
import { FormView, useForm } from './form-view'
import { useKeyLayer } from './key-router'
import { detailLines } from './presenters'
import { RichLine, colored, muted, plain, safeText, strong, type Line } from './rich-text'
import { reviewLines } from './review-lines'
import { theme } from './theme'

/** The size and place of a modal inside the terminal. */
export function modalBox(terminal: { width: number; height: number }, wanted: { width: number; height: number }) {
  const width = Math.min(wanted.width, terminal.width - 2)
  const height = Math.min(wanted.height, terminal.height - 2)
  return { width, height, left: Math.floor((terminal.width - width) / 2), top: Math.floor((terminal.height - height) / 2) }
}

/** A centered box over the screen. */
export function ModalFrame(props: { readonly title: string; readonly width: number; readonly height: number; readonly children: ReactNode }) {
  const terminal = useTerminalDimensions()
  const box = modalBox(terminal, props)
  return (
    <box
      position="absolute"
      left={box.left}
      top={box.top}
      width={box.width}
      height={box.height}
      zIndex={20}
      border
      borderStyle="double"
      borderColor={theme.accent}
      backgroundColor={theme.modalBackground}
      title={props.title}
      flexDirection="column"
      overflow="hidden"
    >
      {props.children}
    </box>
  )
}

/** Renders a window of lines with a scroll position. */
export function LineViewport(props: { readonly lines: readonly Line[]; readonly offset: number; readonly rows: number }) {
  return (
    <box flexDirection="column">
      {props.lines.slice(props.offset, props.offset + props.rows).map((line, index) => (
        <RichLine key={props.offset + index} line={line} />
      ))}
    </box>
  )
}

/** A scroll offset with the keys that move it. */
function useScroll(total: number, rows: number) {
  const [offset, setOffset] = useState(0)
  const maximum = Math.max(0, total - rows)
  const clamped = Math.min(offset, maximum)
  const move = (step: number) => setOffset(Math.max(0, Math.min(clamped + step, maximum)))
  return { offset: clamped, move }
}

/** The review of a sequence of transactions: shows each in full and sends only after an explicit yes. */
export function ReviewModal(props: { readonly title: string; readonly steps: readonly FlowStep[]; readonly onClose: () => void }) {
  const { chainAccess, connection } = useServices()
  const session = useSession()
  const terminal = useTerminalDimensions()
  const { signer } = session
  const flow = useMemo(
    () => {
      if (signer === null) return null
      const checkGate = terminalGateCheck({ connection, chainAccess })
      return createTransactionFlow({ signer, clientFor: (chainId) => chainAccess.flowClient(chainId), ...(checkGate === undefined ? {} : { checkGate }) })
    },
    [signer, chainAccess, connection],
  )
  const state = useSyncExternalStore(
    (listener) => flow?.subscribe(listener) ?? (() => undefined),
    () => flow?.getState() ?? NO_SIGNER_STATE,
  )
  const [calldata, setCalldata] = useState<'summary' | 'full'>('summary')
  const box = modalBox(terminal, { width: 100, height: 30 })
  const rows = box.height - 5
  const lines = linesOf(state, state.steps.length > 0 ? state.steps : props.steps, { calldata, wrapWidth: box.width - 4 })
  const scroll = useScroll(lines.length, rows)

  useEffect(() => {
    flow?.start(props.steps)
    // The flow starts once when the modal opens. A new modal mounts a new component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow])

  useEffect(() => {
    if (state.phase === 'finished') session.refreshSnapshots()
    // The snapshot refresh runs once when the sequence finishes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase])

  const close = () => {
    flow?.cancel()
    props.onClose()
  }

  useKeyLayer('modal', (key) => {
    if (key.name === 'up') scroll.move(-1)
    else if (key.name === 'down') scroll.move(1)
    else if (key.name === 'pageup') scroll.move(-rows)
    else if (key.name === 'pagedown') scroll.move(rows)
    else if (state.phase === 'review' && key.name === 'y') flow?.confirm()
    else if (state.phase === 'review' && key.name === 'n') close()
    else if (state.phase === 'review' && key.name === 'd') setCalldata(calldata === 'summary' ? 'full' : 'summary')
    else if ((state.phase === 'review' || state.phase === 'error') && key.name === 's') flow?.skip()
    else if (state.phase === 'error' && key.name === 'r') flow?.retry()
    else if (key.name === 'escape' || ((state.phase === 'finished' || state.phase === 'cancelled') && key.name === 'return')) {
      if (state.phase !== 'signing' && state.phase !== 'sending') close()
    }
    return true
  })

  return (
    <ModalFrame title={props.title} width={100} height={30}>
      <LineViewport lines={lines} offset={scroll.offset} rows={rows} />
      <box flexGrow={1} />
      <RichLine line={footerOf(state)} />
    </ModalFrame>
  )
}

const NO_SIGNER_STATE: FlowState = {
  phase: 'error',
  steps: [],
  stepIndex: 0,
  prepared: null,
  devicePrompt: null,
  outcomes: [],
  error: 'No signer is connected.',
  gateWait: null,
}

function linesOf(state: FlowState, steps: readonly FlowStep[], options: { calldata: 'summary' | 'full'; wrapWidth: number }): readonly Line[] {
  const position = steps.length > 1 ? `Step ${Math.min(state.stepIndex + 1, steps.length)} of ${steps.length}` : null
  const history: Line[] = state.outcomes.map((outcome): Line => [
    colored(`${outcome.status === 'success' ? 'done' : outcome.status} `, outcome.status === 'success' ? theme.good : outcome.status === 'skipped' ? theme.muted : theme.bad),
    plain(outcome.title),
    muted(outcome.transactionHash === null ? '' : `  ${outcome.transactionHash}`),
  ])
  const heading: readonly Line[] = history.length === 0 ? [] : [...history, []]
  if (state.phase === 'preparing') return [...heading, [muted('Preparing the transaction: checking the deposit gate, estimating gas and reading the nonce…')]]
  if (state.phase === 'waiting' && state.gateWait !== null) return [...heading, ...gateWaitLines(state.gateWait)]
  if (state.phase === 'review' && state.prepared !== null) {
    return [...heading, ...reviewLines(state.prepared, { position, ...options })]
  }
  if (state.phase === 'signing') {
    return [...heading, [strong('Waiting for the signer', theme.accent)], [plain(state.devicePrompt ?? 'Signing in memory…')]]
  }
  if (state.phase === 'sending') return [...heading, [muted('Sent to the network. Waiting for the receipt…')]]
  if (state.phase === 'error') return [...heading, [colored(state.error ?? 'An error happened.', theme.bad)]]
  if (state.phase === 'finished') return [...heading, [strong('All transactions are mined.', theme.good)]]
  if (state.phase === 'cancelled') return [...heading, [muted('Cancelled. Nothing more was signed or sent.')]]
  return heading
}

/** What the review shows while the gate check waits. Nothing is signed or sent meanwhile. */
export function gateWaitLines(wait: GateWait): readonly Line[] {
  const why =
    wait.epochSecondsLeft === undefined
      ? `The beacon header of epoch ${wait.epoch} is not on ${wait.chainName} yet. The ${wait.chainName} deposit gate is checked again in ${wait.seconds} seconds.`
      : `Epoch ${wait.epoch} ends in ${Math.max(wait.epochSecondsLeft, 0)} seconds: too soon for a confirmation to be mined in it. The ${wait.chainName} deposit gate is checked again in ${wait.seconds} seconds, in the next epoch.`
  return [[strong('Waiting for the deposit gate', theme.accent)], [plain(why)], [muted('Nothing is signed or sent until the review.')]]
}

function footerOf(state: FlowState): Line {
  if (state.phase === 'review') return [strong('y', theme.good), plain(' sign and send   '), strong('n', theme.bad), plain(' cancel   d calldata   s skip step   arrows scroll')]
  if (state.phase === 'error') return [plain('r retry   s skip step   Esc close')]
  if (state.phase === 'finished' || state.phase === 'cancelled') return [plain('Esc close')]
  if (state.phase === 'preparing' || state.phase === 'waiting') return [plain('Esc cancel')]
  return [muted('Please wait…')]
}

/** The full details of one feed row. */
export function DetailModal(props: { readonly item: FeedItem; readonly onClose: () => void }) {
  const { pair } = useServices()
  useKeyLayer('modal', (key) => {
    if (key.name === 'escape' || key.name === 'return' || key.name === 'q') props.onClose()
    return true
  })
  return (
    <ModalFrame title="Transfer or message" width={96} height={18}>
      {detailLines(props.item, pair).map((line, index) => (
        <RichLine key={index} line={line} />
      ))}
      <box flexGrow={1} />
      <text fg={theme.muted}>Esc close</text>
    </ModalFrame>
  )
}

/** A small form for the address filter. An empty value clears it. */
export function AddressFilterModal(props: { readonly current: string; readonly onApply: (address: string) => void; readonly onClose: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const form = useForm({
    specs: [{ kind: 'text', name: 'address', label: 'Sender or recipient', initial: props.current, placeholder: '0x… (empty clears)', hint: 'Enter applies. Esc cancels.' }],
    onSubmit: (values) => {
      const text = (values.address ?? '').trim()
      if (text !== '' && !/^0x[0-9a-fA-F]{40}$/.test(text)) return setError('That is not an address: 0x and 40 hex digits.')
      props.onApply(text)
      props.onClose()
    },
    onCancel: props.onClose,
  })
  return (
    <ModalFrame title="Address filter" width={80} height={8}>
      <FormView form={form} width={76} />
      <text fg={theme.bad}>{safeText(error ?? ' ')}</text>
    </ModalFrame>
  )
}

/** The help overlay: every key, by area. */
export function HelpOverlay(props: { readonly onClose: () => void }) {
  useKeyLayer('modal', () => {
    props.onClose()
    return true
  })
  const rows: readonly (readonly [string, string])[] = [
    ['1 2 3 4 5', 'Global, pair, audit, prover and costs, connections views'],
    ['Tab / Shift+Tab', 'Pair view: next or previous area (actions, filters, feed)'],
    ['Up Down (j k)', 'Move in the action menu, the feed or the pair list'],
    ['Enter', 'Open the action, the pair, or the details of the feed row'],
    ['Left Right', 'Filters: choose a field. Up Down change its value'],
    ['Enter on Addr', 'Filters: type an address. x clears every filter'],
    ['PageUp PageDown', 'Feed: move by a page'],
    ['y / n', 'Review: sign and send, or cancel (nothing is sent before y)'],
    ['d  s  r', 'Review: raw calldata, skip a step, retry after an error'],
    ['Pay for delivery', 'Bridge form: Left Right chooses Yes. The fee fields and the live cost show'],
    ['Docs', 'User docs: explorer/web/docs/pages (fees: 05-fees-explained.md)'],
    ['p', 'Prove on this computer'],
    ['r', 'Latest proofs, ask for a proof, evidence of a message'],
    ['t', 'History of sends and deliveries, with filters'],
    ['Esc', 'Close a dialog or this help'],
    ['?', 'Show or hide this help'],
    ['q  Ctrl+C', 'Quit'],
    ['6', 'Prover setup (operator only, stores configuration)'],
  ]
  return (
    <ModalFrame title="Help" width={84} height={rows.length + 5}>
      {rows.map(([keys, meaning]) => (
        <RichLine key={keys} line={[strong(keys.padEnd(18), theme.accent), plain(meaning)]} />
      ))}
      <box flexGrow={1} />
      <text fg={theme.muted}>Press any key to close.</text>
    </ModalFrame>
  )
}
