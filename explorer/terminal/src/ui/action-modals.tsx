/**
 * The forms of the action area: bridge tokens, send a message, claim, post an update and execute a message.
 * Each form builds the steps of a transaction flow and hands them to the review screen. None sends anything itself.
 */
import { useState } from 'react'
import { buildBridgeSteps, buildClaimSteps, buildMessageSteps, claimableEntries, nativeChoiceValue, tokenChoiceValue } from '../app/actions'
import { useServices } from '../app/services'
import { useSession } from '../app/session'
import type { FlowStep } from '../flow/transaction-flow'
import { formatRateAsPercent } from '../format/amounts'
import { OperatorFileError, planLightClientUpdate, planMessageExecution } from '../tx/operator'
import { PlanInputError, amountMeaning } from '../tx/plan'
import type { FieldSpec } from './form'
import { FormView, useForm } from './form-view'
import { useKeyLayer } from './key-router'
import { ModalFrame } from './modals'
import { RichLine, colored, muted, plain } from './rich-text'
import { theme } from './theme'

/** What every action modal receives. */
export interface ActionModalProps {
  /** Opens the review of these steps in place of this form. */
  readonly onReview: (title: string, steps: readonly FlowStep[]) => void
  readonly onClose: () => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Runs a builder and shows its input errors on the form instead of throwing. */
function useSubmitError() {
  const [error, setError] = useState<string | null>(null)
  const attempt = (action: () => void) => {
    try {
      action()
      setError(null)
    } catch (caught) {
      setError(caught instanceof PlanInputError || caught instanceof OperatorFileError ? caught.message : messageOf(caught))
    }
  }
  return { error, attempt, setError }
}

/** The form that bridges tokens: relayTokens, relayTokensAndCall or relayTokensWithFallback with a fee limit. */
export function BridgeModal(props: ActionModalProps) {
  const { pair } = useServices()
  const session = useSession()
  const { error, attempt } = useSubmitError()
  const signer = session.signer
  const tokenChoices = [
    ...(['first', 'second'] as const).flatMap((side) => {
      const chain = side === 'first' ? pair.first : pair.second
      const router = chain.contracts.wrappedNativeRouter === null ? [] : [{ value: nativeChoiceValue(side), label: `${chain.nativeSymbol} on ${chain.name} (wrap)` }]
      const own = session.tokens.filter((token) => token.side === side).map((token) => ({ value: tokenChoiceValue(token), label: `${token.symbol} on ${chain.name}` }))
      return [...own, ...router]
    }),
  ]
  const firstOk = session.snapshots?.find((result) => result.status === 'ok')
  const currentRate = firstOk?.status === 'ok' ? formatRateAsPercent(firstOk.snapshot.feeRate).replace('%', '') : ''
  const specs: readonly FieldSpec[] = [
    { kind: 'choice', name: 'token', label: 'Token', choices: tokenChoices.length === 0 ? [{ value: '', label: 'no tokens loaded' }] : tokenChoices, hint: 'Left or Right chooses the token and its chain.' },
    { kind: 'text', name: 'amount', label: 'Amount', placeholder: 'for example 2.5', hint: 'A decimal in whole tokens.' },
    { kind: 'text', name: 'receiver', label: 'Receiver', initial: signer?.address ?? '', hint: 'The address that receives on the other chain.' },
    {
      kind: 'choice',
      name: 'mode',
      label: 'Mode',
      choices: [
        { value: 'plain', label: 'relayTokens' },
        { value: 'call', label: 'relayTokensAndCall' },
        { value: 'fallback', label: 'relayTokensWithFallback' },
      ],
      hint: 'Call also calls onTokenBridged on the receiver. Fallback names an address for a failed payment.',
    },
    { kind: 'text', name: 'data', label: 'Call data', placeholder: '0x… (empty for none)', visibleWhen: (values) => values.mode !== 'plain', hint: 'Hex bytes for onTokenBridged.' },
    { kind: 'text', name: 'fallback', label: 'Fallback recipient', initial: signer?.address ?? '', visibleWhen: (values) => values.mode === 'fallback', hint: 'Paid when the receiver cannot be paid.' },
    {
      kind: 'text',
      name: 'maxFeePercent',
      label: 'Max fee (percent)',
      initial: currentRate,
      visibleWhen: (values) => values.mode === 'fallback',
      hint: 'The call reverts if the fee rises above this. Empty means no limit.',
    },
  ]
  const form = useForm({
    specs,
    onSubmit: (values) =>
      attempt(() => {
        if (signer === null) throw new PlanInputError('Connect a signer first.')
        const steps = buildBridgeSteps(values, session.tokens, { pair, snapshots: session.snapshots, signerAddress: signer.address })
        props.onReview('Bridge tokens', steps)
      }),
    onCancel: props.onClose,
  })
  return (
    <ModalFrame title="Bridge tokens" width={96} height={16}>
      <FormView form={form} width={92} />
      <RichLine line={[colored(error ?? ' ', theme.bad)]} />
      <RichLine line={[muted('Enter reviews the transaction. Nothing is sent before you confirm it. Esc cancels.')]} />
    </ModalFrame>
  )
}

/** The form that sends an arbitrary message with requireToPassMessage. */
export function MessageModal(props: ActionModalProps) {
  const { pair } = useServices()
  const { error, attempt } = useSubmitError()
  const specs: readonly FieldSpec[] = [
    { kind: 'choice', name: 'chain', label: 'Send from', choices: [{ value: 'first', label: pair.first.name }, { value: 'second', label: pair.second.name }] },
    { kind: 'text', name: 'target', label: 'Target contract', placeholder: '0x… on the other chain', hint: 'The contract that the bridge calls on the other chain.' },
    { kind: 'text', name: 'data', label: 'Call data', placeholder: '0x…', hint: 'Hex bytes: the selector and the arguments.' },
    { kind: 'text', name: 'gas', label: 'Gas', initial: '200000', hint: 'Gas that the call gets on the other chain.' },
  ]
  const form = useForm({
    specs,
    onSubmit: (values) => attempt(() => props.onReview('Send a message', buildMessageSteps(values, pair))),
    onCancel: props.onClose,
  })
  return (
    <ModalFrame title="Send a message (requireToPassMessage)" width={90} height={13}>
      <FormView form={form} width={86} />
      <RichLine line={[colored(error ?? ' ', theme.bad)]} />
      <RichLine line={[muted('Enter reviews the transaction. Esc cancels.')]} />
    </ModalFrame>
  )
}

/** The list of claimable balances. Enter claims the selected one. */
export function ClaimModal(props: ActionModalProps) {
  const { pair } = useServices()
  const session = useSession()
  const entries = claimableEntries(session.snapshots)
  const [index, setIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)
  useKeyLayer('modal', (key) => {
    if (key.name === 'escape') props.onClose()
    else if (key.name === 'up') setIndex(Math.max(0, index - 1))
    else if (key.name === 'down') setIndex(Math.min(entries.length - 1, index + 1))
    else if ((key.name === 'return' || key.name === 'enter') && entries[index] !== undefined && session.signer !== null) {
      try {
        props.onReview('Claim', buildClaimSteps(entries[index], pair, session.signer.address))
      } catch (caught) {
        setError(messageOf(caught))
      }
    }
    return true
  })
  const chainName = (side: 'first' | 'second') => (side === 'first' ? pair.first.name : pair.second.name)
  return (
    <ModalFrame title="Claim balances" width={80} height={12}>
      {session.signer === null ? <text fg={theme.warn}>Connect a signer first.</text> : null}
      {session.signer !== null && entries.length === 0 ? <text fg={theme.muted}>Nothing is claimable for this account.</text> : null}
      {entries.map((entry, row) => (
        <RichLine
          key={`${entry.side}${entry.position.token.address}`}
          line={[colored(`${row === index ? '> ' : '  '}${amountMeaning(entry.position.claimable, entry.position.token)} on ${chainName(entry.side)}`, row === index ? theme.accent : theme.text)]}
        />
      ))}
      <box flexGrow={1} />
      <RichLine line={[colored(error ?? ' ', theme.bad)]} />
      <RichLine line={[plain('Enter reviews the claim. Esc cancels.')]} />
    </ModalFrame>
  )
}

/** Shared by the two operator forms: a file path field that reads and plans on submit. */
function FileModal(props: ActionModalProps & {
  readonly title: string
  readonly label: string
  readonly initialPath: string | undefined
  readonly hint: string
  readonly plan: (text: string) => { readonly title: string; readonly steps: readonly FlowStep[] }
}) {
  const { readTextFile } = useServices()
  const { error, setError } = useSubmitError()
  const [busy, setBusy] = useState<'yes' | 'no'>('no')
  const form = useForm({
    specs: [{ kind: 'text', name: 'path', label: props.label, initial: props.initialPath ?? '', placeholder: 'path to the JSON file', hint: props.hint }],
    enabled: busy === 'yes' ? 'off' : 'on',
    onSubmit: (values) => {
      setBusy('yes')
      readTextFile((values.path ?? '').trim())
        .then((text) => {
          const plan = props.plan(text)
          props.onReview(plan.title, plan.steps)
        })
        .catch((caught: unknown) => {
          setError(caught instanceof OperatorFileError ? caught.message : `Could not read the file: ${messageOf(caught)}`)
          setBusy('no')
        })
    },
    onCancel: props.onClose,
  })
  return (
    <ModalFrame title={props.title} width={96} height={10}>
      <FormView form={form} width={92} />
      <RichLine line={[colored(error ?? ' ', theme.bad)]} />
      <RichLine line={[muted('Enter reads the file and shows the transaction. Esc cancels.')]} />
    </ModalFrame>
  )
}

/** Operator action: post a light client update from a prover handoff file. */
export function UpdateModal(props: ActionModalProps) {
  const { pair, signing } = useServices()
  return (
    <FileModal
      {...props}
      title="Post a light client update"
      label="Handoff file"
      initialPath={signing.fileHints.handoffFile}
      hint="The JSON that zk-bridge-prover prove prints."
      plan={(text) => ({ title: 'Post a light client update', steps: [{ plan: planLightClientUpdate(text, pair), skippable: false }] })}
    />
  )
}

/** Operator action: execute a message from the evidence file of zk-bridge-prover evidence. */
export function ExecuteModal(props: ActionModalProps) {
  const { pair, signing } = useServices()
  return (
    <FileModal
      {...props}
      title="Execute a message"
      label="Evidence file"
      initialPath={signing.fileHints.evidenceFile}
      hint="The JSON that zk-bridge-prover evidence prints."
      plan={(text) => {
        const sequence = planMessageExecution(text, pair)
        return {
          title: `Execute message ${sequence.summary.messageId.slice(0, 12)}…`,
          steps: sequence.steps.map((step) => ({ plan: step.plan, skippable: step.role === 'prerequisite' })),
        }
      }}
    />
  )
}
