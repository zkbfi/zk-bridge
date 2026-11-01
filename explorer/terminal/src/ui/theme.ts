/**
 * Colors of the dashboard, in one place. Each color has one meaning.
 */
export const theme = {
  background: '#10141c',
  panel: '#161b26',
  border: '#3b4658',
  borderFocused: '#5ec8e5',
  text: '#d7dde8',
  muted: '#7d8aa0',
  accent: '#5ec8e5',
  good: '#6fd08c',
  warn: '#e9c46a',
  bad: '#f26d6d',
  pending: '#7fb3ff',
  selectedBackground: '#27324a',
  modalBackground: '#1b2230',
} as const

/** The color of a feed or gate status word. */
export function statusColor(status: string): string {
  if (status === 'delivered' || status === 'open') return theme.good
  if (status === 'release_failed' || status === 'stop' || status === 'sealed') return theme.bad
  if (status === 'warn' || status === 'stale') return theme.warn
  if (status === 'unknown') return theme.muted
  return theme.pending
}
