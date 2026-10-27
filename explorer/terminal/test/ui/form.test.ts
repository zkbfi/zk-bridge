import { describe, expect, test } from 'bun:test'
import { applyFormKey, applyFormPaste, createFormState, visibleFields, type FieldSpec, type FormKey } from '../../src/ui/form'
import { formatTimestamp, formatDuration, formatAge, fitColumn, fitColumnRight, shortenHex } from '../../src/format/text'
import { windowStart } from '../../src/ui/panels'
import { auditLine, feedRow, formatLag, STATUS_LABELS } from '../../src/ui/presenters'
import { computePairLayout } from '../../src/ui/layout'
import { buildFixtureFeed, buildFixtureHeads, FIXTURE_AUDIT, FIXTURE_NOW, FIXTURE_PAIR } from '../../src/data/fixtures'
import { lineText } from '../../src/ui/rich-text'
import { FEED_STATUSES } from '../../src/model/types'

const key = (name: string, sequence = name, extra: Partial<FormKey> = {}): FormKey => ({ name, sequence, ctrl: false, shift: false, meta: false, option: false, ...extra })

const specs: readonly FieldSpec[] = [
  { kind: 'choice', name: 'mode', label: 'Mode', choices: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }] },
  { kind: 'text', name: 'plain', label: 'Plain' },
  { kind: 'secret', name: 'secret', label: 'Secret', visibleWhen: (values) => values.mode === 'b' },
]

describe('form reducer', () => {
  test('typing edits the focused text field, backspace removes, ctrl+u clears', () => {
    let state = createFormState(specs)
    state = applyFormKey(specs, state, key('tab')).state
    expect(state.focus).toBe('plain')
    for (const character of 'hi!') state = applyFormKey(specs, state, key(character)).state
    expect(state.values.plain).toBe('hi!')
    state = applyFormKey(specs, state, key('backspace', '\b')).state
    expect(state.values.plain).toBe('hi')
    state = applyFormKey(specs, state, key('u', '\u0015', { ctrl: true })).state
    expect(state.values.plain).toBe('')
  })

  test('control and meta combinations never type a character', () => {
    let state = applyFormKey(specs, createFormState(specs), key('tab')).state
    state = applyFormKey(specs, state, key('a', 'a', { ctrl: true })).state
    state = applyFormKey(specs, state, key('a', 'a', { meta: true })).state
    expect(state.values.plain).toBe('')
  })

  test('choice fields move with left, right and space, and wrap', () => {
    let state = createFormState(specs)
    state = applyFormKey(specs, state, key('right')).state
    expect(state.values.mode).toBe('b')
    state = applyFormKey(specs, state, key('left')).state
    state = applyFormKey(specs, state, key('left')).state
    expect(state.values.mode).toBe('c')
    expect(applyFormKey(specs, state, key('space', ' ')).state.values.mode).toBe('a')
  })

  test('a field appears only when its condition holds, and focus skips hidden fields', () => {
    const start = createFormState(specs)
    expect(visibleFields(specs, start.values).map((spec) => spec.name)).toEqual(['mode', 'plain'])
    const shown = applyFormKey(specs, start, key('right')).state
    expect(visibleFields(specs, shown.values).map((spec) => spec.name)).toEqual(['mode', 'plain', 'secret'])
    let state = shown
    for (let step = 0; step < 3; step += 1) state = applyFormKey(specs, state, key('tab')).state
    expect(state.focus).toBe('mode')
  })

  test('Enter submits and Escape cancels without changing the values', () => {
    const state = createFormState(specs)
    expect(applyFormKey(specs, state, key('return', '\r')).outcome).toBe('submit')
    expect(applyFormKey(specs, state, key('escape', '\u001b')).outcome).toBe('cancel')
  })

  test('paste appends to a text field with line breaks as spaces, and ignores a choice field', () => {
    let state = applyFormKey(specs, createFormState(specs), key('tab')).state
    state = applyFormPaste(specs, state, 'one\ntwo\r\nthree\n')
    expect(state.values.plain).toBe('one two three')
    const onChoice = createFormState(specs)
    expect(applyFormPaste(specs, onChoice, 'x')).toBe(onChoice)
  })
})

describe('text helpers', () => {
  test('formats times in UTC and durations in the largest units', () => {
    expect(formatTimestamp(FIXTURE_NOW)).toBe('2026-10-25 12:00:00')
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(65)).toBe('1m 05s')
    expect(formatDuration(3_723)).toBe('1h 02m 03s')
    expect(formatAge(1_000, 995)).toBe('5s ago')
    expect(formatAge(10_000, 5_000)).toBe('1h ago')
    expect(formatAge(1_000, 2_000)).toBe('0s ago')
  })

  test('column fitting cuts with an ellipsis and pads to the exact width', () => {
    expect(fitColumn('abcdef', 4)).toBe('abc…')
    expect(fitColumn('ab', 4)).toBe('ab  ')
    expect(fitColumnRight('abcdef', 4)).toBe('…def')
    expect(fitColumnRight('ab', 4)).toBe('  ab')
    expect(shortenHex('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x1234…5678')
    expect(shortenHex('0x12')).toBe('0x12')
  })

  test('the window of a list keeps the selection in view', () => {
    expect(windowStart(0, 100, 10)).toBe(0)
    expect(windowStart(50, 100, 10)).toBe(45)
    expect(windowStart(99, 100, 10)).toBe(90)
    expect(windowStart(3, 5, 10)).toBe(0)
  })
})

describe('presenters', () => {
  test('the status list holds release_failed and no claim status', () => {
    expect(FEED_STATUSES).toContain('release_failed' as never)
    expect(FEED_STATUSES as readonly string[]).not.toContain('claimable')
  })

  test('every status has a label that fits its column of nine', () => {
    for (const status of FEED_STATUSES) expect(STATUS_LABELS[status].length).toBeLessThanOrEqual(9)
  })

  test('a feed row has the same width at one size, so the columns line up', () => {
    const feed = buildFixtureFeed(FIXTURE_NOW)
    for (const [width, height] of [[120, 40], [80, 24]] as const) {
      const layout = computePairLayout(width, height)
      const widths = new Set(feed.map((item) => lineText(feedRow(item, { pair: FIXTURE_PAIR, layout })).length))
      expect(widths.size).toBe(1)
    }
  })

  test('a compact feed row fits the width that the compact layout leaves for it', () => {
    const layout = computePairLayout(80, 24)
    const inner = 80 - layout.actionWidth - 2
    const feed = buildFixtureFeed(FIXTURE_NOW)
    for (const item of feed) expect(lineText(feedRow(item, { pair: FIXTURE_PAIR, layout })).length).toBeLessThanOrEqual(inner)
  })

  test('a wide feed row fits the width that the wide layout leaves for it', () => {
    const layout = computePairLayout(120, 40)
    const inner = 120 - layout.actionWidth - 2
    for (const item of buildFixtureFeed(FIXTURE_NOW)) expect(lineText(feedRow(item, { pair: FIXTURE_PAIR, layout })).length).toBeLessThanOrEqual(inner)
  })

  test('lag shows slots and time, and says unknown when the finalized slot is unknown', () => {
    const [first] = buildFixtureHeads(FIXTURE_NOW)
    expect(formatLag(first!)).toBe('96 slots (16m 00s)')
    expect(formatLag({ ...first!, finalizedSlot: null, lagSlots: null })).toBe('unknown')
  })

  test('audit rows flag only the mismatch, in both column forms', () => {
    for (const columns of ['full', 'short'] as const) {
      const texts = FIXTURE_AUDIT.map((row) => lineText(auditLine(row, columns)))
      expect(texts.filter((text) => text.includes('MISMATCH'))).toHaveLength(1)
      expect(texts[2]).toContain('-300')
    }
  })
})
