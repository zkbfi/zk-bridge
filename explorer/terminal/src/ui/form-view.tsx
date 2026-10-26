/**
 * The React side of a form: a hook that owns the state and a component that draws it.
 */
import { usePaste } from '@opentui/react'
import { useRef, useState } from 'react'
import { useKeyLayer } from './key-router'
import {
  applyFormKey,
  applyFormPaste,
  createFormState,
  setValue,
  visibleFields,
  type FieldSpec,
  type FormOutcome,
  type FormState,
  type FormValues,
} from './form'
import { theme } from './theme'

/** Options of {@link useForm}. */
export interface UseFormOptions {
  readonly specs: readonly FieldSpec[]
  readonly overrides?: FormValues
  /** Called when the user presses Enter. It receives the current values. */
  readonly onSubmit: (values: FormValues) => void
  /** Called when the user presses Escape. */
  readonly onCancel: () => void
  /**
   * Called after each edit of a value. It receives the values before and after the edit and returns the values to keep,
   * so a form can fill one field from another. It must be pure. Default: keep the edit as it is.
   */
  readonly onEdit?: (previous: FormValues, next: FormValues) => FormValues
  /** `off` leaves the form on screen and stops it from taking keys, for example while a request runs. */
  readonly enabled?: 'on' | 'off'
}

/** What {@link useForm} returns. */
export interface FormHandle {
  readonly state: FormState
  readonly specs: readonly FieldSpec[]
  /** Replaces one value from code, for example a default that arrives late. */
  set(name: string, value: string): void
}

/** Owns the state of a form and routes keys and paste events to it, on the modal layer. */
export function useForm(options: UseFormOptions): FormHandle {
  const { specs, onSubmit, onCancel } = options
  const refine = (previous: FormState, next: FormState): FormState =>
    options.onEdit === undefined ? next : { ...next, values: options.onEdit(previous.values, next.values) }
  const [state, setState] = useState<FormState>(() => createFormState(specs, options.overrides))
  const latest = useRef(state)
  latest.current = state

  const commit = (next: FormState) => {
    latest.current = next
    setState(next)
  }

  useKeyLayer(
    'modal',
    (key) => {
      const result = applyFormKey(specs, latest.current, key)
      const handlers: Record<FormOutcome, () => void> = {
        submit: () => onSubmit(latest.current.values),
        cancel: onCancel,
        edited: () => commit(refine(latest.current, result.state)),
        moved: () => commit(result.state),
        ignored: () => undefined,
      }
      handlers[result.outcome]()
      return true
    },
    { enabled: options.enabled === 'off' ? 'off' : 'on' },
  )

  usePaste((event) => {
    if (options.enabled === 'off') return
    commit(refine(latest.current, applyFormPaste(specs, latest.current, new TextDecoder().decode(event.bytes))))
  })

  return { state, specs, set: (name, value) => commit(refine(latest.current, setValue(latest.current, name, value))) }
}

/** The widest a field label is. */
const LABEL_WIDTH = 20

/** Draws the visible fields of a form, one per row, with a hint line for the focused field. */
export function FormView({ form, width }: { readonly form: FormHandle; readonly width: number }) {
  const visible = visibleFields(form.specs, form.state.values)
  const focused = visible.find((spec) => spec.name === form.state.focus)
  const valueWidth = Math.max(10, width - LABEL_WIDTH - 2)
  return (
    <box flexDirection="column">
      {visible.map((spec) => {
        const isFocused = spec.name === form.state.focus
        return (
          <box key={spec.name} flexDirection="row" height={1}>
            <text fg={isFocused ? theme.accent : theme.muted}>{`${isFocused ? '>' : ' '} ${spec.label}`.padEnd(LABEL_WIDTH)}</text>
            <text fg={isFocused ? theme.text : theme.muted}>{renderValue(spec, form.state.values[spec.name] ?? '', { valueWidth, isFocused })}</text>
          </box>
        )
      })}
      <text fg={theme.muted}>{focused?.hint ?? ' '}</text>
    </box>
  )
}

function renderValue(spec: FieldSpec, value: string, display: { valueWidth: number; isFocused: boolean }): string {
  const cursor = display.isFocused && spec.kind !== 'choice' ? '_' : ''
  if (spec.kind === 'choice') {
    const label = spec.choices.find((choice) => choice.value === value)?.label ?? value
    return display.isFocused ? `< ${label} >` : label
  }
  if (spec.kind === 'secret') {
    const bullets = value === '' ? '' : `${'*'.repeat(Math.min(value.length, display.valueWidth - 14))} (${value.length} characters)`
    return `${bullets}${cursor}`
  }
  if (value === '') return display.isFocused ? `${cursor}${spec.placeholder === undefined ? '' : ` ${spec.placeholder}`}` : (spec.placeholder ?? '')
  const shown = value.length > display.valueWidth - 1 ? `…${value.slice(value.length - display.valueWidth + 2)}` : value
  return `${shown}${cursor}`
}
