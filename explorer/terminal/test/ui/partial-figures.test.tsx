import { afterEach, describe, expect, test } from 'bun:test'
import { countAuditMismatches, countUnverifiedRows, hasAuditMismatch, isUnverifiedRow } from '../../src/model/audit'
import { FIXTURE_AUDIT, FIXTURE_NOW, FIXTURE_PAIR, createFixtureDataSource } from '../../src/data/fixtures'
import type { DataSource } from '../../src/data/data-source'
import type { AuditRow, PairSummary } from '../../src/model/types'
import { computePairLayout } from '../../src/ui/layout'
import { PARTIAL_SUMMARY_NOTE, UNVERIFIED_MARK, auditLine, auditVerdict, summaryLines } from '../../src/ui/presenters'
import { coverageNote } from '../../src/ui/panels'
import { lineText } from '../../src/ui/rich-text'
import { theme } from '../../src/ui/theme'
import { renderApp } from './harness'

type App = Awaited<ReturnType<typeof renderApp>>
let app: App | null = null
afterEach(() => {
  app?.destroy()
  app = null
})

const [usdc, , wpls] = FIXTURE_AUDIT as readonly [AuditRow, AuditRow, AuditRow]
const wide = computePairLayout(120, 40)

/** The same row with one more base unit of escrow, so the difference is not zero. */
const withDifference = (row: AuditRow, extra: Partial<AuditRow> = {}): AuditRow => ({ ...row, escrow: row.escrow + 7_000n, ...extra })

describe('audit rows that the RPC source could not verify', () => {
  test('a partial row with a non-zero difference is not a mismatch, and a complete row with the same difference is', () => {
    const complete = withDifference(usdc)
    const partial = withDifference(usdc, { partial: true })
    expect(hasAuditMismatch(complete)).toBe(true)
    expect(hasAuditMismatch(partial)).toBe(false)
    expect(isUnverifiedRow(partial)).toBe(true)
    expect(isUnverifiedRow(complete)).toBe(false)
  })

  test('the counts keep the two apart', () => {
    const rows = [withDifference(usdc), withDifference(usdc, { partial: true }), usdc, { ...usdc, partial: true }]
    expect(countAuditMismatches(rows)).toBe(1)
    expect(countUnverifiedRows(rows)).toBe(2)
  })

  test('a partial row is drawn with a muted unverified mark and no MISMATCH, in both column forms', () => {
    for (const columns of ['full', 'short'] as const) {
      const partial = auditLine(withDifference(usdc, { partial: true }), columns)
      const complete = auditLine(withDifference(usdc), columns)
      expect(lineText(partial)).toContain(UNVERIFIED_MARK)
      expect(lineText(partial)).not.toContain('MISMATCH')
      expect(lineText(complete)).toContain('MISMATCH')
      expect(lineText(complete)).not.toContain(UNVERIFIED_MARK)
      expect(partial.find((segment) => segment.text.includes(UNVERIFIED_MARK))?.color).toBe(theme.muted)
      expect(complete.some((segment) => segment.color === theme.bad)).toBe(true)
      expect(partial.some((segment) => segment.color === theme.bad)).toBe(false)
    }
  })

  test('a partial row still shows its difference, so the reader sees what could not be proven', () => {
    expect(lineText(auditLine(withDifference(usdc, { partial: true }), 'full'))).toContain('+0.007')
  })

  test('a partial row with a zero difference is still unverified, not ok', () => {
    const text = lineText(auditLine({ ...usdc, partial: true }, 'short'))
    expect(text).toContain(UNVERIFIED_MARK)
    expect(text).not.toContain('ok')
  })

  test('the verdict says how many rows are unverified, and says No mismatch only when every row was verified', () => {
    expect(lineText(auditVerdict([usdc]))).toBe('No mismatch.')
    expect(lineText(auditVerdict([wpls]))).toBe('1 MISMATCH')
    expect(lineText(auditVerdict([wpls, wpls]))).toBe('2 MISMATCHES')
    expect(lineText(auditVerdict([{ ...usdc, partial: true }]))).toBe(` 1 ${UNVERIFIED_MARK} ${PARTIAL_SUMMARY_NOTE}`)
    expect(lineText(auditVerdict([wpls, withDifference(usdc, { partial: true })]))).toBe(`1 MISMATCH 1 ${UNVERIFIED_MARK} ${PARTIAL_SUMMARY_NOTE}`)
  })
})

describe('summary figures that the RPC source read in part', () => {
  const summary = async (): Promise<PairSummary> => createFixtureDataSource({ now: () => FIXTURE_NOW }).getSummary(FIXTURE_PAIR.id)
  const textOf = (value: PairSummary) => summaryLines(value, { pair: FIXTURE_PAIR, now: FIXTURE_NOW, layout: wide }).map(lineText)

  test('a complete summary has no lower bound mark and no note', async () => {
    const text = (await textOf(await summary())).join('\n')
    expect(text).not.toContain('>=')
    expect(text).not.toContain(PARTIAL_SUMMARY_NOTE)
  })

  test('each partial figure gets a leading >= and the note shows once', async () => {
    const base = await summary()
    const [first, second] = textOf({ ...base, partial: ['volume24h', 'inFlight', 'feesAccrued'] })
    expect(first).toContain(`in flight >=${base.inFlight}`)
    expect(first).toContain(`24h >=${base.volume24h.transferCount} transfers`)
    expect(first).toMatch(/, >=[\d.,]+ \w+/)
    expect(second).toContain('fees accrued >=')
    expect(second).toContain(PARTIAL_SUMMARY_NOTE)
    expect([first, second].join('\n').split(PARTIAL_SUMMARY_NOTE)).toHaveLength(2)
  })

  test('only the named figure is marked: a partial volume leaves in flight and fees exact', async () => {
    const base = await summary()
    const [first, second] = textOf({ ...base, partial: ['volume24h'] })
    expect(first).toContain(`in flight ${base.inFlight}`)
    expect(first).toContain(`24h >=${base.volume24h.transferCount} transfers`)
    expect(second).toContain('fees accrued ')
    expect(second).not.toContain('fees accrued >=')
    expect(second).toContain(PARTIAL_SUMMARY_NOTE)
  })

  test('a partial figure that the summary bar does not draw adds no note', async () => {
    const base = await summary()
    expect(textOf({ ...base, partial: ['feed', 'audit'] }).join('\n')).not.toContain(PARTIAL_SUMMARY_NOTE)
  })
})

/** A data source that answers like the fixtures, with the partial markers that the RPC source adds. */
function partialSource(): DataSource {
  const base = createFixtureDataSource({ now: () => FIXTURE_NOW })
  return {
    ...base,
    getSummary: async (pairId) => ({ ...(await base.getSummary(pairId)), partial: ['inFlight'] }),
    getFeed: async (pairId, filter, limit) => ({ ...(await base.getFeed(pairId, filter, limit)), coveredFrom: 1_792_000_000 }),
    getAudit: async () => FIXTURE_AUDIT.map((row) => ({ ...row, partial: true })),
  }
}

describe('what the screens draw for partial data', () => {
  test('the pair view marks the partial in flight count and says where the feed history starts', async () => {
    app = await renderApp({ width: 140, height: 40, dataSource: partialSource() })
    const frame = app.frame()
    expect(frame).toMatch(/in flight >=\d/)
    expect(frame).toContain(PARTIAL_SUMMARY_NOTE)
    expect(frame).toContain(coverageNote(1_792_000_000))
    expect(coverageNote(1_792_000_000)).toBe('RPC fallback: history since 2026-10-14 17:46:40 UTC')
  })

  test('the pair view with complete data has neither the mark nor the history line', async () => {
    app = await renderApp({ width: 140, height: 40 })
    expect(app.frame()).not.toContain('>=')
    expect(app.frame()).not.toContain('history since')
  })

  test('the audit view shows no mismatch for partial rows and counts them as unverified', async () => {
    app = await renderApp({ width: 140, height: 40, dataSource: partialSource() })
    await app.press('3')
    await app.settle(60)
    const frame = app.frame()
    expect(frame).not.toContain('MISMATCH')
    expect(frame).toContain(`${FIXTURE_AUDIT.length} ${UNVERIFIED_MARK}`)
    expect(frame).not.toContain('No mismatch.')
    expect(frame.split(UNVERIFIED_MARK).length - 1).toBeGreaterThanOrEqual(FIXTURE_AUDIT.length)
  })

  test('the audit view with complete rows still flags the real mismatch', async () => {
    app = await renderApp({ width: 140, height: 40 })
    await app.press('3')
    await app.settle(60)
    expect(app.frame()).toContain('1 MISMATCH')
    expect(app.frame()).not.toContain(UNVERIFIED_MARK)
  })
})
