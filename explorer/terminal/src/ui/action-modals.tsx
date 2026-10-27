/**
 * The forms of the action area: bridge tokens, send a message, post an update and execute a message.
 * Each form builds the steps of a transaction flow and hands them to the review screen. None sends anything itself.
 */
import { useState } from 'react'
import { GAS_MODE_HELP, GAS_MODE_SHORT_LABEL, type DeliveryCostReport } from '@zk-bridge/shared'
import { bridgeSourceOf, buildBridgeSteps, deliveryRouterOf, buildMessageSteps, nativeChoiceValue, tokenChoiceValue } from '../app/actions'
import {
  CUSTOM_KINDS,
  DELIVERY_FIELD,
  DEFAULT_GAS_MULTIPLIER_TEXT,
  DEFAULT_MARGIN_PERCENT,
  DEFAULT_TIP_PERCENT_TEXT,
  DEFAULT_PRIORITY_GWEI,
  buildDeliveryFeeModel,
  feeFormModeOf,
  paysForDelivery,
  refillDeliveryFee,
  resolveDeliveryTarget,
  transferValueOf,
  type DeliveryFeeState,
  type DeliveryTarget,
  type Values,
} from '../app/delivery-fee-form'
import { useServices } from '../app/services'
import { useSession } from '../app/session'
import type { FlowStep } from '../flow/transaction-flow'
import { OperatorFileError, planLightClientUpdate, planMessageExecution } from '../tx/operator'
import { PlanInputError } from '../tx/plan'
import type { FieldSpec } from './form'
import { deliveryPanelLines } from './delivery-fee-lines'
import { FormView, useForm } from './form-view'
import { ModalFrame } from './modals'
import { RichLine, RichLines, colored, muted } from './rich-text'
import { theme } from './theme'
import { usePolling } from './use-polling'

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

/** How often the delivery cost reloads while the fee fields are open, in milliseconds. */
const DELIVERY_COST_INTERVAL_MILLISECONDS = 15_000

const FEE_MODE_CHOICES = [
  { value: 'gas', label: GAS_MODE_SHORT_LABEL },
  { value: 'percentage', label: 'Percentage of the transfer' },
  { value: 'fixed', label: 'Fixed amount' },
  { value: 'custom', label: 'Custom terms' },
] as const

const CUSTOM_KIND_LABELS: Readonly<Record<(typeof CUSTOM_KINDS)[number], string>> = { fixed: 'Fixed amount', share: 'Share of the value', gas: 'Gas based' }

/** The form that bridges tokens: relayTokens or relayTokensAndCall, with an optional gas limit and an optional delivery fee. */
export function BridgeModal(props: ActionModalProps) {
  const { pair, dataSource, tokenValuationsWei, chainAccess } = useServices()
  const session = useSession()
  const { error, setError } = useSubmitError()
  const signer = session.signer
  const targetOf = (values: Values) => resolveDeliveryTarget({ source: bridgeSourceOf(values, session.tokens, pair), pair, tokens: session.tokens, valuations: tokenValuationsWei })
  const deliveryActive = (values: Values): boolean => paysForDelivery(values) && targetOf(values).kind === 'ready'
  const stateFor = (values: Values, report: DeliveryCostReport | null): { state: DeliveryFeeState; target: DeliveryTarget } | null => {
    const resolved = targetOf(values)
    const source = bridgeSourceOf(values, session.tokens, pair)
    if (resolved.kind === 'unavailable' || report === null || source.kind !== 'token') return null
    const transferValue = transferValueOf(values.amount ?? '', source.token.decimals)
    return { state: buildDeliveryFeeModel({ values, target: resolved.target, report, transferValue }), target: resolved.target }
  }

  const tokenChoices = [
    ...(['first', 'second'] as const).flatMap((side) => {
      const chain = side === 'first' ? pair.first : pair.second
      const router = chain.contracts.deliveryRouter === null ? [] : [{ value: nativeChoiceValue(side), label: `${chain.nativeSymbol} on ${chain.name} (wrap)` }]
      const own = session.tokens.filter((token) => token.side === side).map((token) => ({ value: tokenChoiceValue(token), label: `${token.symbol} on ${chain.name}` }))
      return [...own, ...router]
    }),
  ]
  const offersDelivery = (values: Values): boolean => targetOf(values).kind === 'ready'
  const whenActive = (extra: (values: Values) => boolean = () => true) => (values: Values) => deliveryActive(values) && extra(values)
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
      ],
      visibleWhen: (values) => !deliveryActive(values),
      hint: 'Call also calls onTokenBridged on the receiver.',
    },
    { kind: 'text', name: 'data', label: 'Call data', placeholder: '0x… (empty for none)', visibleWhen: (values) => !deliveryActive(values) && values.mode !== 'plain', hint: 'Hex bytes for onTokenBridged.' },
    {
      kind: 'choice',
      name: DELIVERY_FIELD.delivery,
      label: 'Tip for delivery',
      initial: 'yes',
      choices: [
        { value: 'yes', label: 'Yes, gas based by default' },
        { value: 'no', label: 'No tip' },
      ],
      visibleWhen: offersDelivery,
      hint: 'Yes adds a tip for delivery on the other chain. The router pays it to its reward address. Anyone may deliver, and a copied delivery gains the copier nothing. You fix the tip now; nothing at delivery changes it. It uses relayTokensAndCall to the router, and the Mode field is not used. No sends a plain relay.',
    },
    { kind: 'choice', name: DELIVERY_FIELD.mode, label: 'Tip mode', initial: 'gas', choices: FEE_MODE_CHOICES, visibleWhen: whenActive(), hint: `Gas mode: ${GAS_MODE_HELP} Choosing a mode fills the numbers. Edit them from there.` },
    { kind: 'text', name: DELIVERY_FIELD.percent, label: 'Percentage', initial: DEFAULT_TIP_PERCENT_TEXT, placeholder: 'blank means 0.1', visibleWhen: whenActive((values) => feeFormModeOf(values) === 'percentage'), hint: 'A percent of the transfer, for example 0.1. The router takes this share for its reward address and the recipient gets the rest.' },
    { kind: 'text', name: DELIVERY_FIELD.fixed, label: 'Fixed amount', placeholder: 'blank uses the suggestion', visibleWhen: whenActive((values) => feeFormModeOf(values) === 'fixed'), hint: 'An amount of the token that the reward address is paid in, in whole tokens.' },
    { kind: 'text', name: DELIVERY_FIELD.multiplier, label: 'Gas multiplier', initial: DEFAULT_GAS_MULTIPLIER_TEXT, placeholder: 'blank means 2', visibleWhen: whenActive((values) => feeFormModeOf(values) === 'gas'), hint: 'A factor on the gas cost. 2 is a margin of 100 percent. The tip never passes the limit.' },
    { kind: 'text', name: DELIVERY_FIELD.senderPrice, label: 'Your coin price', placeholder: 'tokens for one native coin', visibleWhen: whenActive((values) => feeFormModeOf(values) === 'gas'), hint: 'Your own price: how many whole tokens one whole native coin of the other chain is worth. Nothing at delivery reads it. It is folded into the multiplier now.' },
    { kind: 'text', name: DELIVERY_FIELD.ceiling, label: 'Base fee ceiling', placeholder: 'blank means twice the base fee now', visibleWhen: whenActive((values) => feeFormModeOf(values) === 'gas'), hint: 'In gwei. The limit is the tip at this base fee: the price ceiling. A base fee above it cannot raise the tip.' },
    { kind: 'choice', name: DELIVERY_FIELD.customKind, label: 'Custom kind', choices: CUSTOM_KINDS.map((kind) => ({ value: kind, label: CUSTOM_KIND_LABELS[kind] })), visibleWhen: whenActive((values) => feeFormModeOf(values) === 'custom'), hint: 'Left or Right chooses how the router reads the numbers.' },
    { kind: 'text', name: DELIVERY_FIELD.customLimit, label: 'Limit', placeholder: '0', visibleWhen: whenActive((values) => feeFormModeOf(values) === 'custom'), hint: 'Whole tokens. The fixed fee, or the cap of a gas based fee.' },
    { kind: 'text', name: DELIVERY_FIELD.customMultiplier, label: 'Multiplier', placeholder: '0', visibleWhen: whenActive((values) => feeFormModeOf(values) === 'custom'), hint: 'A decimal. A share: 0.005 is 0.5 percent. A gas based fee: the factor on the gas price.' },
    { kind: 'choice', name: DELIVERY_FIELD.customBasis, label: 'Gas price', choices: [{ value: 'transaction', label: 'Transaction gas price' }, { value: 'base-fee-only', label: 'Base fee only' }], visibleWhen: whenActive((values) => feeFormModeOf(values) === 'custom' && values[DELIVERY_FIELD.customKind] === 'gas'), hint: 'Base fee only leaves the priority fee out of the gas based fee.' },
    { kind: 'text', name: DELIVERY_FIELD.margin, label: 'Margin percent', initial: DEFAULT_MARGIN_PERCENT, visibleWhen: whenActive((values) => feeFormModeOf(values) !== 'custom'), hint: 'The profit on top of the cost that the suggestions add.' },
    { kind: 'text', name: DELIVERY_FIELD.priority, label: 'Priority fee gwei', initial: DEFAULT_PRIORITY_GWEI, visibleWhen: whenActive(), hint: 'The priority fee per gas that you expect the delivery to pay. It enters the cost of the delivery.' },
    {
      kind: 'choice',
      name: DELIVERY_FIELD.payout,
      label: 'Pay the reward address in',
      choices: [{ value: 'token', label: 'The token' }, { value: 'native', label: 'The native coin (unwrap)' }],
      visibleWhen: whenActive((values) => {
        const resolved = targetOf(values)
        return resolved.kind === 'ready' && resolved.target.isWrappedNative
      }),
      hint: 'The destination token is the wrapped native token, so the router can unwrap the fee.',
    },
    { kind: 'text', name: DELIVERY_FIELD.router, label: 'Router (advanced)', placeholder: 'blank is the default delivery router', visibleWhen: whenActive(), hint: 'The last step before delivery, chosen in the extra data. Blank targets the default delivery router on the other chain. Anyone can deliver through it. The tip always goes to the reward address of the router, so a copied delivery gains the copier nothing.' },
    { kind: 'text', name: DELIVERY_FIELD.callTarget, label: 'Call target (optional)', placeholder: 'blank makes no call', visibleWhen: whenActive(), hint: 'A contract that the router calls once, after it pays the recipient. The call comes from the router and sends no native coin. A gas based tip counts the gas of the call.' },
    { kind: 'text', name: DELIVERY_FIELD.callData, label: 'Call data (optional)', placeholder: '0x… (empty for none)', visibleWhen: whenActive(), hint: 'Hex bytes for the call. It needs a call target. A target with no call data makes a call with empty data.' },
    { kind: 'text', name: DELIVERY_FIELD.recipient, label: 'Fee recipient', placeholder: 'blank is the receiver above', visibleWhen: whenActive(), hint: 'Receives the tokens after the fee. Blank means the receiver above.' },
    { kind: 'text', name: 'gasLimit', label: 'Gas limit (optional)', placeholder: 'blank uses the default', hint: 'Gas for the release on the other chain. The mediator uses the larger of this and its default, and refuses a value above the bridge maximum.' },
  ]
  /** Asks the router for its reward address and its failed delivery address, then builds the review. The read never throws; a failed read becomes a line on the review. */
  const submitBridge = async (values: Values): Promise<void> => {
    try {
      if (signer === null) throw new PlanInputError('Connect a signer first.')
      const context = { pair, snapshots: session.snapshots, signerAddress: signer.address, deliveryCost: report.data, tokenValuationsWei }
      const wanted = deliveryRouterOf(values, session.tokens, context)
      const routerAddresses = wanted === null ? undefined : await chainAccess.readRouterAddresses(wanted)
      props.onReview('Bridge tokens', buildBridgeSteps(values, session.tokens, { ...context, ...(routerAddresses === undefined ? {} : { routerAddresses }) }))
      setError(null)
    } catch (caught) {
      setError(messageOf(caught))
    }
  }
  const form = useForm({
    specs,
    // `report` is declared below the form because it depends on the form values. The edit handler runs after the render.
    onEdit: (previous, next) => refillDeliveryFee(previous, next, { stateFor: (values) => stateFor(values, report.data) }),
    onSubmit: (values) => void submitBridge(values),
    onCancel: props.onClose,
  })
  const values = form.state.values
  const resolved = targetOf(values)
  const wantedChainId = deliveryActive(values) && resolved.kind === 'ready' ? resolved.target.chain.chainId : null
  const report = usePolling<DeliveryCostReport | null>(
    () => (wantedChainId === null ? Promise.resolve(null) : dataSource.getDeliveryCost(wantedChainId)),
    `delivery-cost|${wantedChainId ?? 'off'}`,
    wantedChainId === null ? 0 : DELIVERY_COST_INTERVAL_MILLISECONDS,
  )
  const panel = deliveryPanelLines(panelInputOf({ resolved, report, state: stateFor(values, report.data) }))
  const note = resolved.kind === 'unavailable' && (bridgeSourceOf(values, session.tokens, pair).kind === 'token' || paysForDelivery(values)) ? resolved.reason : null
  return (
    <ModalFrame title="Bridge tokens" width={96} height={wantedChainId === null ? 18 : 48}>
      <FormView form={form} width={92} />
      {wantedChainId === null ? null : <RichLines lines={panel} />}
      <RichLine line={[colored(error ?? ' ', theme.bad)]} />
      {note === null ? null : <RichLine line={[muted(note)]} />}
      <RichLine line={[muted('Enter reviews the transaction. Nothing is sent before you confirm it. Esc cancels.')]} />
    </ModalFrame>
  )
}

function panelInputOf(input: {
  readonly resolved: ReturnType<typeof resolveDeliveryTarget>
  readonly report: { readonly data: DeliveryCostReport | null; readonly error: string | null }
  readonly state: { state: DeliveryFeeState; target: DeliveryTarget } | null
}): Parameters<typeof deliveryPanelLines>[0] {
  const chainName = input.resolved.kind === 'ready' ? input.resolved.target.chain.name : 'the other chain'
  if (input.report.error !== null && input.report.data === null) return { kind: 'failed', chainName, reason: input.report.error }
  if (input.state === null) return { kind: 'loading', chainName }
  return { kind: 'state', state: input.state.state, target: input.state.target }
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
