import { describe, expect, test } from 'bun:test'
import { buildFixtureFeed, FIXTURE_NOW, FIXTURE_PAIR } from '../../src/data/fixtures'
import type { FeedItem } from '../../src/model/types'
import { detailLines } from '../../src/ui/presenters'
import { lineText } from '../../src/ui/rich-text'

const tokenItem = buildFixtureFeed(FIXTURE_NOW).find((item) => item.kind === 'token' && item.token !== null && item.amount !== null)!

const textOf = (item: FeedItem) => detailLines(item, FIXTURE_PAIR).map(lineText)
const valueOf = (lines: readonly string[], label: string) => lines.find((line) => line.startsWith(label))?.slice(14).trim()

describe('the detail lines of a feed item', () => {
  test('a token transfer lists the token, the amount in base units and the recipient label, with no fee row', () => {
    const lines = textOf(tokenItem)
    const token = tokenItem.token!
    expect(valueOf(lines, 'Recipient')).toBe(tokenItem.recipient)
    expect(valueOf(lines, 'Token')).toBe(`${token.symbol} ${token.address}`)
    expect(valueOf(lines, 'Amount')).toContain(`(${tokenItem.amount} base units)`)
    expect(valueOf(lines, 'Fee')).toBeUndefined()
  })

  test('a message labels its recipient as the executor and has no token or amount rows', () => {
    const lines = textOf({ ...tokenItem, kind: 'message', token: null, amount: null })
    expect(valueOf(lines, 'Executor')).toBe(tokenItem.recipient)
    expect(valueOf(lines, 'Kind')).toBe('message')
    for (const label of ['Recipient', 'Token', 'Amount']) expect(valueOf(lines, label)).toBeUndefined()
  })

  test('an item that has not arrived says so and shows a dash for the target transaction', () => {
    const lines = textOf({ ...tokenItem, deliveredAt: null, destinationTransactionHash: null })
    expect(lines.some((line) => line.startsWith('Arrived on') && line.endsWith('not yet'))).toBe(true)
    expect(valueOf(lines, 'Target tx')).toBe('-')
  })
})
