import { describe, expect, test } from 'bun:test'
import { buildFixtureFeed, FIXTURE_NOW, FIXTURE_PAIR } from '../../src/data/fixtures'
import type { FeedItem } from '../../src/model/types'
import { detailLines } from '../../src/ui/presenters'
import { lineText } from '../../src/ui/rich-text'

const tokenItem = buildFixtureFeed(FIXTURE_NOW).find((item) => item.kind === 'token' && item.token !== null && item.amount !== null)!

const textOf = (item: FeedItem) => detailLines(item, FIXTURE_PAIR).map(lineText)
const valueOf = (lines: readonly string[], label: string) => lines.find((line) => line.startsWith(label))?.slice(14).trim()

describe('the detail lines of a feed item', () => {
  test('a token transfer lists the token, the amount in base units, the fee and the recipient label', () => {
    const lines = textOf({ ...tokenItem, fee: 15n * 10n ** BigInt(tokenItem.token!.decimals - 1) })
    const token = tokenItem.token!
    expect(valueOf(lines, 'Recipient')).toBe(tokenItem.recipient)
    expect(valueOf(lines, 'Token')).toBe(`${token.symbol} ${token.address}`)
    expect(valueOf(lines, 'Amount')).toContain(`(${tokenItem.amount} base units)`)
    expect(valueOf(lines, 'Fee')).toBe(`1.5 ${token.symbol}`)
  })

  test('a token transfer with no fee reading shows a dash for the fee', () => {
    expect(valueOf(textOf({ ...tokenItem, fee: null }), 'Fee')).toBe('-')
  })

  test('a message labels its recipient as the executor and has no token, amount or fee rows', () => {
    const lines = textOf({ ...tokenItem, kind: 'message', token: null, amount: null, fee: null })
    expect(valueOf(lines, 'Executor')).toBe(tokenItem.recipient)
    expect(valueOf(lines, 'Kind')).toBe('message')
    for (const label of ['Recipient', 'Token', 'Amount', 'Fee']) expect(valueOf(lines, label)).toBeUndefined()
  })

  test('an item that has not arrived says so and shows a dash for the target transaction', () => {
    const lines = textOf({ ...tokenItem, deliveredAt: null, destinationTransactionHash: null })
    expect(lines.some((line) => line.startsWith('Arrived on') && line.endsWith('not yet'))).toBe(true)
    expect(valueOf(lines, 'Target tx')).toBe('-')
  })
})
