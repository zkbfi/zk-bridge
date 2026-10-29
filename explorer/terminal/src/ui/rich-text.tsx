/**
 * A line of text made of colored pieces. Styling uses nested modifier elements, as OpenTUI requires.
 */
import { theme } from './theme'

/** One piece of a line. */
export interface Segment {
  readonly text: string
  readonly color?: string
  readonly emphasis?: 'strong'
}

/** One line. */
export type Line = readonly Segment[]

/** Builds a plain segment. */
export const plain = (text: string): Segment => ({ text })
/** Builds a segment in the muted color. */
export const muted = (text: string): Segment => ({ text, color: theme.muted })
/** Builds a strong segment. */
export const strong = (text: string, color: string = theme.text): Segment => ({ text, color, emphasis: 'strong' })
/** Builds a colored segment. */
export const colored = (text: string, color: string): Segment => ({ text, color })

/** The plain text of a line, for tests and for width math. */
export function lineText(line: Line): string {
  return line.map((segment) => segment.text).join('')
}

// Escape sequences, control characters and bidi controls in server text could clear the screen, hide a link or reorder
// what the user reads. They go before a line is drawn: whole CSI and OSC sequences first, then any single control.
const ESCAPE_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g
const CONTROL = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g

/** The text without escape sequences, control characters or bidi controls. Tabs and line breaks become spaces. */
export function safeText(text: string): string {
  return text.replace(ESCAPE_SEQUENCE, '').replace(/[\t\n\r]/g, ' ').replace(CONTROL, '')
}

/** Renders one line. An empty line keeps its row by holding a space. */
export function RichLine({ line }: { readonly line: Line }) {
  if (line.length === 0 || lineText(line) === '') return <text> </text>
  return (
    <text wrapMode="none">
      {line.map((segment, index) => (
        <span key={index} fg={segment.color ?? theme.text}>
          {segment.emphasis === 'strong' ? <strong>{safeText(segment.text)}</strong> : safeText(segment.text)}
        </span>
      ))}
    </text>
  )
}

/** Renders lines one under the other. */
export function RichLines({ lines }: { readonly lines: readonly Line[] }) {
  return (
    <box flexDirection="column">
      {lines.map((line, index) => (
        <RichLine key={index} line={line} />
      ))}
    </box>
  )
}
