/**
 * Small display helpers for addresses, hashes, times and lag. All are pure.
 */

/** Shortens a hex string to `0x1234…abcd`. A short value is returned unchanged. */
export function shortenHex(value: string, edge = 4): string {
  const minimumLength = 2 + edge * 2 + 1
  if (value.length <= minimumLength) return value
  return `${value.slice(0, 2 + edge)}…${value.slice(-edge)}`
}

/** Formats unix seconds as `YYYY-MM-DD HH:MM:SS` in UTC. */
export function formatTimestamp(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace('T', ' ').slice(0, 19)
}

/** Formats unix seconds as `HH:MM:SS` in UTC, for tight columns. */
export function formatClock(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(11, 19)
}

/** Formats a duration in whole seconds as `1h 02m 03s`, `4m 05s` or `6s`. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  if (hours > 0) return `${hours}h ${pad2(minutes)}m ${pad2(rest)}s`
  if (minutes > 0) return `${minutes}m ${pad2(rest)}s`
  return `${rest}s`
}

/** Formats the age of an event: `12s ago`, `5m ago`, `3h ago`, `2d ago`. */
export function formatAge(nowSeconds: number, thenSeconds: number): string {
  const delta = Math.max(0, nowSeconds - thenSeconds)
  if (delta < 60) return `${delta}s ago`
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`
  return `${Math.floor(delta / 86400)}d ago`
}

/** Pads or cuts text to exactly `width` columns. A cut value ends with an ellipsis. */
export function fitColumn(text: string, width: number): string {
  if (width <= 0) return ''
  if (text.length > width) return width === 1 ? '…' : `${text.slice(0, width - 1)}…`
  return text.padEnd(width, ' ')
}

/** Pads text on the left to exactly `width` columns, for right-aligned numbers. A cut value keeps its tail. */
export function fitColumnRight(text: string, width: number): string {
  if (width <= 0) return ''
  if (text.length > width) return width === 1 ? '…' : `…${text.slice(text.length - width + 1)}`
  return text.padStart(width, ' ')
}

function pad2(value: number): string {
  return value.toString().padStart(2, '0')
}
