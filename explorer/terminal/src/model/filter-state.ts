/**
 * The state of the feed filters as the header shows it, and its conversion to the filter that a data source takes.
 */
import { earliestSentAt } from './feed-filter'
import {
  FEED_STATUSES,
  type Direction,
  type FeedFilter,
  type FeedKind,
  type FeedStatus,
  type TimeRange,
  type TokenInfo,
} from './types'

/** The header fields, in the order that left and right keys move through them. */
export const FILTER_FIELDS = ['direction', 'kind', 'status', 'token', 'address', 'range'] as const

/** One header field. */
export type FilterField = (typeof FILTER_FIELDS)[number]

/** The state of the header. `all` means no filter on that field. */
export interface FilterState {
  readonly direction: 'all' | Direction
  readonly kind: 'all' | FeedKind
  readonly status: 'all' | FeedStatus
  /** A token address, or `all`. */
  readonly token: string
  /** The address text of the address filter, or an empty string for none. */
  readonly address: string
  readonly range: TimeRange
}

/** The state with no filter. */
export const EMPTY_FILTER: FilterState = {
  direction: 'all',
  kind: 'all',
  status: 'all',
  token: 'all',
  address: '',
  range: 'all',
}

const DIRECTIONS = ['all', 'first-to-second', 'second-to-first'] as const
const KINDS = ['all', 'token', 'message'] as const
const RANGES = ['all', '1h', '24h', '7d'] as const

/**
 * Moves one field to its next or previous value. The address field is edited as text, so this leaves it unchanged.
 *
 * @param state The current state.
 * @param field The field to change.
 * @param step `1` for the next value, `-1` for the previous.
 * @param tokens The tokens that the token field cycles through, after `all`.
 */
export function cycleFilterField(
  state: FilterState,
  field: FilterField,
  step: 1 | -1,
  tokens: readonly TokenInfo[],
): FilterState {
  if (field === 'direction') return { ...state, direction: cycle(DIRECTIONS, state.direction, step) }
  if (field === 'kind') return { ...state, kind: cycle(KINDS, state.kind, step) }
  if (field === 'status') return { ...state, status: cycle(['all', ...FEED_STATUSES], state.status, step) }
  if (field === 'token') return { ...state, token: cycle(['all', ...tokens.map((token) => token.address)], state.token, step) }
  if (field === 'range') return { ...state, range: cycle(RANGES, state.range, step) }
  return state
}

/** Converts the header state to the filter of a data source. */
export function toFeedFilter(state: FilterState, nowSeconds: number): FeedFilter {
  const sentAtOrAfter = earliestSentAt(state.range, nowSeconds)
  return {
    ...(state.direction === 'all' ? {} : { direction: state.direction }),
    ...(state.kind === 'all' ? {} : { kind: state.kind }),
    ...(state.status === 'all' ? {} : { status: state.status }),
    ...(state.token === 'all' ? {} : { token: state.token as `0x${string}` }),
    ...(state.address.trim() === '' ? {} : { address: state.address.trim() as `0x${string}` }),
    ...(sentAtOrAfter === undefined ? {} : { sentAtOrAfter }),
  }
}

/** A stable text for a filter state, so a polling hook can key on it. */
export function filterKey(state: FilterState): string {
  return FILTER_FIELDS.map((field) => state[field]).join('|')
}

/** The number of filters that are set. */
export function countActiveFilters(state: FilterState): number {
  return FILTER_FIELDS.filter((field) => state[field] !== EMPTY_FILTER[field]).length
}

function cycle<Value extends string>(values: readonly Value[], current: string, step: 1 | -1): Value {
  const index = values.indexOf(current as Value)
  const next = values[(Math.max(index, 0) + step + values.length) % values.length]
  return next ?? (values[0] as Value)
}
