import { describe, expect, test } from 'bun:test'
import { createAppState, reduceAppState } from '../../src/app/app-state'

const start = createAppState('eth-pls')

describe('reduceAppState focus and list moves', () => {
  test('the focus action sets the area that it names and leaves the rest alone', () => {
    const next = reduceAppState({ ...start, feedIndex: 3 }, { type: 'focus', area: 'feed' })
    expect(next).toEqual({ ...start, feedIndex: 3, focus: 'feed' })
  })

  test('the global list moves by one and stops at both ends', () => {
    const down = reduceAppState(start, { type: 'move-global', step: 1, count: 3 })
    expect(down.globalIndex).toBe(1)
    const atEnd = reduceAppState({ ...start, globalIndex: 2 }, { type: 'move-global', step: 1, count: 3 })
    expect(atEnd.globalIndex).toBe(2)
    expect(reduceAppState(start, { type: 'move-global', step: -1, count: 3 }).globalIndex).toBe(0)
  })

  test('the global list of no rows keeps the index at zero', () => {
    expect(reduceAppState(start, { type: 'move-global', step: 1, count: 0 }).globalIndex).toBe(0)
  })

  test('the focus wraps from the last area to the first, and back', () => {
    const last = { ...start, focus: 'feed' as const }
    expect(reduceAppState(last, { type: 'move-focus', step: 1 }).focus).toBe('actions')
    expect(reduceAppState(start, { type: 'move-focus', step: -1 }).focus).toBe('feed')
  })
})
