/**
 * Reads the progress lines that `zk-bridge-prover` writes to its standard error, one line for each event, such as
 * `ts=1761640000 level=info event=proof_started program=light-client input_bytes=812`. Values with spaces are quoted.
 * The prover never writes a key or a full address into these lines (it keeps only the scheme and host of a URL).
 */

/** One event of the prover, read from one line. */
export interface ProgressEvent {
  /** The event name, such as `proof_started`. */
  readonly event: string
  readonly level: 'info' | 'warn' | 'error'
  /** Unix seconds, as the prover wrote them. */
  readonly timestamp: number
  readonly fields: Readonly<Record<string, string>>
}

/** One line of the progress list on screen. */
export interface ProgressStep {
  readonly label: string
  /** Seconds since the first line of the run. */
  readonly elapsedSeconds: number
  readonly level: ProgressEvent['level']
}

const PAIR_PATTERN = /([a-z_]+)=("(?:[^"\\]|\\.)*"|\S*)/g

/** The words that the screen shows for each event that the prover is known to write. */
const EVENT_LABELS: Readonly<Record<string, string>> = {
  prove_started: 'Reading the chains and building the proof input',
  proof_started: 'Proving on this processor',
  proof_finished: 'The proof is finished and checked',
  proof_handed_off: 'The proof is ready',
  up_to_date: 'The light client is already up to date',
}

function unquote(raw: string): string {
  if (!raw.startsWith('"')) return raw
  return raw.slice(1, -1).replace(/\\(.)/g, '$1')
}

/**
 * Reads one standard error line of the prover.
 *
 * @returns The event, or null when the line is not a prover event line (empty, or free text).
 */
export function parseProgressLine(line: string): ProgressEvent | null {
  const fields: Record<string, string> = {}
  for (const match of line.matchAll(PAIR_PATTERN)) fields[match[1]!] = unquote(match[2]!)
  const timestamp = Number(fields.ts)
  const level = fields.level
  if (!Number.isSafeInteger(timestamp) || fields.event === undefined) return null
  if (level !== 'info' && level !== 'warn' && level !== 'error') return null
  const { ts: _ts, level: _level, event, ...rest } = fields
  return { event, level, timestamp, fields: rest }
}

/** The words for one event. An event that the screen does not know shows its own name. */
export function describeProgressEvent(event: ProgressEvent): string {
  const known = EVENT_LABELS[event.event]
  if (known !== undefined) return known
  return event.event.replaceAll('_', ' ')
}

/**
 * Turns the whole standard error text of a run into steps. Each step carries the seconds since the first line, so the
 * screen can show how long every stage took.
 */
export function progressSteps(standardError: string): readonly ProgressStep[] {
  const events = standardError
    .split('\n')
    .map(parseProgressLine)
    .filter((event): event is ProgressEvent => event !== null)
  const first = events[0]
  if (first === undefined) return []
  return events.map((event) => ({
    label: describeProgressEvent(event),
    elapsedSeconds: Math.max(0, event.timestamp - first.timestamp),
    level: event.level,
  }))
}

/** Formats seconds as minutes and seconds, such as `4 min 52 s`. */
export function formatElapsed(seconds: number): string {
  const whole = Math.floor(seconds)
  if (whole < 60) return `${whole} s`
  return `${Math.floor(whole / 60)} min ${String(whole % 60)} s`
}
