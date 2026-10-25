/**
 * Pure feed filtering. The fixture data source uses it, and the indexer data source uses it for any filter that the
 * indexer API does not apply itself.
 */
import type { FeedFilter, FeedItem, TimeRange } from './types'

/** The length of each time range in seconds. `all` has no length. */
const RANGE_SECONDS: Readonly<Record<Exclude<TimeRange, 'all'>, number>> = {
  '1h': 3600,
  '24h': 86400,
  '7d': 604800,
}

/** Turns a time range preset into the earliest send time to show, or `undefined` for `all`. */
export function earliestSentAt(range: TimeRange, nowSeconds: number): number | undefined {
  if (range === 'all') return undefined
  return nowSeconds - RANGE_SECONDS[range]
}

/** True when an item passes every filter that is set. Address comparison ignores letter case. */
export function matchesFeedFilter(item: FeedItem, filter: FeedFilter): boolean {
  if (filter.direction !== undefined && item.direction !== filter.direction) return false
  if (filter.kind !== undefined && item.kind !== filter.kind) return false
  if (filter.status !== undefined && item.status !== filter.status) return false
  if (filter.token !== undefined && !sameAddress(item.token?.address, filter.token)) return false
  if (filter.address !== undefined && !involves(item, filter.address)) return false
  if (filter.sentAtOrAfter !== undefined && item.sentAt < filter.sentAtOrAfter) return false
  return true
}

/** Applies the filter and sorts newest first. */
export function filterFeed(items: readonly FeedItem[], filter: FeedFilter): FeedItem[] {
  return items.filter((item) => matchesFeedFilter(item, filter)).sort((left, right) => right.sentAt - left.sentAt)
}

function involves(item: FeedItem, address: string): boolean {
  return sameAddress(item.sender, address) || sameAddress(item.recipient, address)
}

function sameAddress(left: string | undefined, right: string): boolean {
  return left !== undefined && left.toLowerCase() === right.toLowerCase()
}
