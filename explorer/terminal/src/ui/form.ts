/**
 * The logic of a form, without any rendering: which field has focus, what each key does, and what the values are.
 * Text, secret and choice fields share one reducer, so every modal behaves the same way.
 */

/** The part of a key event that the form reads. */
export interface FormKey {
  readonly name: string
  readonly sequence: string
  readonly ctrl: boolean
  readonly shift: boolean
  readonly meta: boolean
  readonly option: boolean
}

/** A text field. A secret field takes the same keys and is shown as bullets. */
export interface TextFieldSpec {
  readonly kind: 'text' | 'secret'
  readonly name: string
  readonly label: string
  readonly initial?: string
  readonly placeholder?: string
  readonly hint?: string
  /** The field is shown only when this returns true for the current values. Default: always shown. */
  readonly visibleWhen?: (values: FormValues) => boolean
}

/** A choice field: left and right keys move through the choices. */
export interface ChoiceFieldSpec {
  readonly kind: 'choice'
  readonly name: string
  readonly label: string
  readonly choices: readonly { readonly value: string; readonly label: string }[]
  readonly initial?: string
  readonly hint?: string
  readonly visibleWhen?: (values: FormValues) => boolean
}

/** Any field. */
export type FieldSpec = TextFieldSpec | ChoiceFieldSpec

/** The values of a form by field name. */
export type FormValues = Readonly<Record<string, string>>

/** The state of a form. */
export interface FormState {
  readonly values: FormValues
  /** The name of the field that has focus. */
  readonly focus: string
}

/** What a key did beyond editing. */
export type FormOutcome = 'submit' | 'cancel' | 'edited' | 'moved' | 'ignored'

/** Builds the first state: initial values, with focus on the first visible field. */
export function createFormState(specs: readonly FieldSpec[], overrides: FormValues = {}): FormState {
  const values: Record<string, string> = {}
  for (const spec of specs) {
    values[spec.name] = overrides[spec.name] ?? spec.initial ?? (spec.kind === 'choice' ? (spec.choices[0]?.value ?? '') : '')
  }
  return { values, focus: visibleFields(specs, values)[0]?.name ?? '' }
}

/** The fields that are visible for the given values, in order. */
export function visibleFields(specs: readonly FieldSpec[], values: FormValues): readonly FieldSpec[] {
  return specs.filter((spec) => spec.visibleWhen === undefined || spec.visibleWhen(values))
}

/**
 * Applies one key to the form.
 *
 * @returns The next state and what happened. `submit` and `cancel` leave the state as it was.
 */
export function applyFormKey(
  specs: readonly FieldSpec[],
  state: FormState,
  key: FormKey,
): { readonly state: FormState; readonly outcome: FormOutcome } {
  const visible = visibleFields(specs, state.values)
  const focused = visible.find((spec) => spec.name === state.focus) ?? visible[0]
  if (key.name === 'escape') return { state, outcome: 'cancel' }
  if (key.name === 'return' || key.name === 'enter') return { state, outcome: 'submit' }
  if (key.name === 'tab' || key.name === 'down') return moveFocus(visible, state, key.shift ? -1 : 1)
  if (key.name === 'up') return moveFocus(visible, state, -1)
  if (focused === undefined) return { state, outcome: 'ignored' }
  if (focused.kind === 'choice') return editChoice(focused, state, key)
  return editText(focused, state, key)
}

/** Appends pasted text to the focused text or secret field. Line breaks become spaces. */
export function applyFormPaste(specs: readonly FieldSpec[], state: FormState, text: string): FormState {
  const focused = visibleFields(specs, state.values).find((spec) => spec.name === state.focus)
  if (focused === undefined || focused.kind === 'choice') return state
  const cleaned = text.replace(/\r?\n/g, ' ').trim()
  return setValue(state, focused.name, `${state.values[focused.name] ?? ''}${cleaned}`)
}

/** Replaces one value. */
export function setValue(state: FormState, name: string, value: string): FormState {
  return { ...state, values: { ...state.values, [name]: value } }
}

function moveFocus(
  visible: readonly FieldSpec[],
  state: FormState,
  step: 1 | -1,
): { state: FormState; outcome: FormOutcome } {
  if (visible.length === 0) return { state, outcome: 'ignored' }
  const index = visible.findIndex((spec) => spec.name === state.focus)
  const next = visible[(Math.max(index, 0) + step + visible.length) % visible.length]
  return { state: { ...state, focus: next?.name ?? state.focus }, outcome: 'moved' }
}

function editChoice(
  spec: ChoiceFieldSpec,
  state: FormState,
  key: FormKey,
): { state: FormState; outcome: FormOutcome } {
  const step = choiceStep(key)
  if (step === 0 || spec.choices.length === 0) return { state, outcome: 'ignored' }
  const index = spec.choices.findIndex((choice) => choice.value === state.values[spec.name])
  const next = spec.choices[(Math.max(index, 0) + step + spec.choices.length) % spec.choices.length]
  return { state: setValue(state, spec.name, next?.value ?? ''), outcome: 'edited' }
}

function choiceStep(key: FormKey): -1 | 0 | 1 {
  if (key.name === 'right' || key.name === 'space') return 1
  if (key.name === 'left') return -1
  return 0
}

function editText(spec: TextFieldSpec, state: FormState, key: FormKey): { state: FormState; outcome: FormOutcome } {
  const current = state.values[spec.name] ?? ''
  if (key.name === 'backspace') return { state: setValue(state, spec.name, current.slice(0, -1)), outcome: 'edited' }
  if (key.ctrl && key.name === 'u') return { state: setValue(state, spec.name, ''), outcome: 'edited' }
  const character = printable(key)
  if (character === null) return { state, outcome: 'ignored' }
  return { state: setValue(state, spec.name, `${current}${character}`), outcome: 'edited' }
}

function printable(key: FormKey): string | null {
  if (key.ctrl || key.meta || key.option) return null
  if (key.sequence.length !== 1) return null
  const code = key.sequence.charCodeAt(0)
  return code >= 0x20 && code !== 0x7f ? key.sequence : null
}
