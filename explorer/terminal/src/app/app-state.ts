/**
 * The navigation state of the dashboard as a pure reducer: which view is open, which area has focus, the filters,
 * and which modal is on top. Rendering and data loading live elsewhere.
 */
import {
  EMPTY_FILTER,
  FILTER_FIELDS,
  cycleFilterField,
  type FilterField,
  type FilterState,
} from '../model/filter-state'
import type { FeedItem, TokenInfo } from '../model/types'
import type { FlowStep } from '../flow/transaction-flow'

/**
 * The views. `setup` (Prover setup) is deliberately last everywhere: in this list, in the key bar and in the help.
 * It is never the default and no other view leads to it.
 */
export type ViewName = 'global' | 'pair' | 'audit' | 'prover' | 'setup'

/** The views in the order of the number keys `1` to `5`. The tucked-away setup view is always the last entry. */
export const VIEWS: readonly ViewName[] = ['global', 'pair', 'audit', 'prover', 'setup']

/** The label of each view, in the order of {@link VIEWS}. */
export const VIEW_LABELS: Readonly<Record<ViewName, string>> = {
  global: 'Global',
  pair: 'Pair',
  audit: 'Audit',
  prover: 'Prover and costs',
  setup: 'Prover setup',
}

/** The areas of the pair view that take focus. */
export type FocusArea = 'actions' | 'filters' | 'feed'

/** The areas in the order that Tab moves through them. */
export const FOCUS_AREAS: readonly FocusArea[] = ['actions', 'filters', 'feed']

/** The actions of the action area. */
export const ACTIONS = [
  { id: 'signer', label: 'Account and signer' },
  { id: 'bridge', label: 'Bridge tokens' },
  { id: 'message', label: 'Send a message' },
  { id: 'claim', label: 'Claim balances' },
  { id: 'update', label: 'Operator: post update' },
  { id: 'execute', label: 'Operator: execute message' },
] as const

/** The id of an action. */
export type ActionId = (typeof ACTIONS)[number]['id']

/** The modal on top, if any. */
export type ModalState =
  | { readonly kind: 'none' }
  | { readonly kind: ActionId }
  | { readonly kind: 'address-filter' }
  | { readonly kind: 'detail'; readonly item: FeedItem }
  | { readonly kind: 'review'; readonly title: string; readonly steps: readonly FlowStep[] }

/** The whole navigation state. */
export interface AppState {
  readonly view: ViewName
  readonly pairId: string
  readonly focus: FocusArea
  readonly filterField: FilterField
  readonly filter: FilterState
  readonly actionIndex: number
  readonly feedIndex: number
  readonly globalIndex: number
  readonly modal: ModalState
  readonly help: 'open' | 'closed'
  readonly notice: string | null
}

/** Everything that can happen to the navigation state. */
export type AppAction =
  | { readonly type: 'show-view'; readonly view: ViewName }
  | { readonly type: 'open-pair'; readonly pairId: string }
  | { readonly type: 'move-focus'; readonly step: 1 | -1 }
  | { readonly type: 'focus'; readonly area: FocusArea }
  | { readonly type: 'move-action'; readonly step: 1 | -1 }
  | { readonly type: 'move-feed'; readonly step: number; readonly count: number }
  | { readonly type: 'move-global'; readonly step: 1 | -1; readonly count: number }
  | { readonly type: 'move-filter-field'; readonly step: 1 | -1 }
  | { readonly type: 'cycle-filter'; readonly step: 1 | -1; readonly tokens: readonly TokenInfo[] }
  | { readonly type: 'set-address-filter'; readonly address: string }
  | { readonly type: 'clear-filters' }
  | { readonly type: 'open-modal'; readonly modal: ModalState }
  | { readonly type: 'close-modal' }
  | { readonly type: 'toggle-help' }
  | { readonly type: 'notice'; readonly text: string | null }

/** Creates the first state. The pair view opens on the default pair. */
export function createAppState(pairId: string): AppState {
  return {
    view: 'pair',
    pairId,
    focus: 'actions',
    filterField: 'direction',
    filter: EMPTY_FILTER,
    actionIndex: 0,
    feedIndex: 0,
    globalIndex: 0,
    modal: { kind: 'none' },
    help: 'closed',
    notice: null,
  }
}

/** Applies one action. */
export function reduceAppState(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'show-view':
      return { ...state, view: action.view, notice: null }
    case 'open-pair':
      return { ...state, view: 'pair', pairId: action.pairId, feedIndex: 0, notice: null }
    case 'move-focus':
      return { ...state, focus: stepIn(FOCUS_AREAS, state.focus, action.step) }
    case 'focus':
      return { ...state, focus: action.area }
    case 'move-action':
      return { ...state, actionIndex: wrap(state.actionIndex + action.step, ACTIONS.length) }
    case 'move-feed':
      return { ...state, feedIndex: clamp(state.feedIndex + action.step, action.count) }
    case 'move-global':
      return { ...state, globalIndex: clamp(state.globalIndex + action.step, action.count) }
    case 'move-filter-field':
      return { ...state, filterField: stepIn(FILTER_FIELDS, state.filterField, action.step) }
    case 'cycle-filter':
      return { ...state, filter: cycleFilterField(state.filter, state.filterField, action.step, action.tokens), feedIndex: 0 }
    case 'set-address-filter':
      return { ...state, filter: { ...state.filter, address: action.address }, feedIndex: 0 }
    case 'clear-filters':
      return { ...state, filter: EMPTY_FILTER, feedIndex: 0 }
    case 'open-modal':
      return { ...state, modal: action.modal, notice: null }
    case 'close-modal':
      return { ...state, modal: { kind: 'none' } }
    case 'toggle-help':
      return { ...state, help: state.help === 'open' ? 'closed' : 'open' }
    case 'notice':
      return { ...state, notice: action.text }
  }
}

function stepIn<Value>(values: readonly Value[], current: Value, step: 1 | -1): Value {
  const index = values.indexOf(current)
  return values[wrap(index + step, values.length)] ?? current
}

function wrap(index: number, length: number): number {
  return ((index % length) + length) % length
}

function clamp(index: number, count: number): number {
  return Math.max(0, Math.min(index, Math.max(count - 1, 0)))
}
