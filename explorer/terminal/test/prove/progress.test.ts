import { describe, expect, test } from 'bun:test'
import { formatElapsed, parseProgressLine, progressSteps } from '../../src/prove/progress'

describe('parseProgressLine', () => {
  test('reads the event, the level, the time and the quoted fields of a prover line', () => {
    const event = parseProgressLine('ts=1761640010 level=info event=proof_started program=light-client note="two words"')
    expect(event).toEqual({ event: 'proof_started', level: 'info', timestamp: 1761640010, fields: { program: 'light-client', note: 'two words' } })
  })

  test('ignores a line that is not an event line, so free text cannot fake progress', () => {
    expect(parseProgressLine('')).toBeNull()
    expect(parseProgressLine('thread main panicked')).toBeNull()
    expect(parseProgressLine('ts=abc level=info event=x')).toBeNull()
    expect(parseProgressLine('ts=1 level=loud event=x')).toBeNull()
  })
})

describe('progressSteps', () => {
  test('a progress line becomes a step with its elapsed seconds', () => {
    const steps = progressSteps(
      [
        'ts=1000 level=info event=prove_started route=a_to_b',
        'free text from a library',
        'ts=1004 level=info event=proof_started program=light-client',
        'ts=1296 level=info event=proof_finished program=light-client total_seconds=292',
      ].join('\n'),
    )
    expect(steps.map((step) => [step.label, step.elapsedSeconds])).toEqual([
      ['Reading the chains and building the proof input', 0],
      ['Proving on this processor', 4],
      ['The proof is finished and checked', 296],
    ])
  })

  test('an unknown event shows its own name, and an empty text gives no steps', () => {
    expect(progressSteps('ts=5 level=warn event=retry_wait')[0]).toEqual({ label: 'retry wait', elapsedSeconds: 0, level: 'warn' })
    expect(progressSteps('')).toEqual([])
  })
})

describe('formatElapsed', () => {
  test('shows seconds under a minute and minutes after it', () => {
    expect(formatElapsed(59)).toBe('59 s')
    expect(formatElapsed(292)).toBe('4 min 52 s')
  })
})
