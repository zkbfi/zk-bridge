import { afterEach, describe, expect, test } from 'bun:test'
import { computePairLayout } from '../../src/ui/layout'
import { renderApp } from './harness'

// Snapshots of each view at two terminal sizes. The clock is pinned and the data is the fixture, so a snapshot changes
// only when the screen changes. Update with `bun test --update-snapshots` after you read the diff.

const SIZES = [
  { name: 'wide 120x40', width: 120, height: 40 },
  { name: 'compact 80x24', width: 80, height: 24 },
] as const

type App = Awaited<ReturnType<typeof renderApp>>
let app: App | null = null
afterEach(() => {
  app?.destroy()
  app = null
})

describe('view snapshots', () => {
  for (const size of SIZES) {
    test(`pair view, ${size.name}`, async () => {
      app = await renderApp(size)
      expect(app.frame()).toMatchSnapshot()
    })

    test(`global view, ${size.name}`, async () => {
      app = await renderApp(size)
      await app.press('1')
      expect(app.frame()).toMatchSnapshot()
    })

    test(`audit view, ${size.name}`, async () => {
      app = await renderApp(size)
      await app.press('3')
      expect(app.frame()).toMatchSnapshot()
    })

    test(`prover and costs view, ${size.name}`, async () => {
      app = await renderApp(size)
      await app.press('4')
      expect(app.frame()).toMatchSnapshot()
    })

    test(`prover setup view, ${size.name}`, async () => {
      app = await renderApp(size)
      await app.press('5')
      expect(app.frame()).toMatchSnapshot()
    })

    test(`help overlay, ${size.name}`, async () => {
      app = await renderApp(size)
      await app.press('?')
      expect(app.frame()).toMatchSnapshot()
    })
  }
})

describe('what the views show', () => {
  test('the pair view has every area at both sizes: summary, actions, filters, feed and heads', async () => {
    for (const size of SIZES) {
      app = await renderApp(size)
      const frame = app.frame()
      for (const text of ['eth-pls', 'Account and actions', 'Filters', 'Feed 1/36', 'Light client heads', 'Ethereum', 'PulseChain', 'lag 96 slots']) {
        expect(frame).toContain(text)
      }
      app.destroy()
    }
    app = null
  })

  test('the feed shows a timestamp on both chains and the status of each row', async () => {
    app = await renderApp({ width: 80, height: 24 })
    const frame = app.frame()
    // A delivered row has a send time and an arrival time. A waiting row has a dash for the arrival.
    expect(frame).toMatch(/10:42:56 11:03:52 \S+ +[\d.]+ \S+ +delivered/)
    expect(frame).toMatch(/11:29:24 - +\S+ .*waiting/)
  })

  test('the audit view flags the mismatch and counts it', async () => {
    app = await renderApp({ width: 120, height: 40 })
    await app.press('3')
    const frame = app.frame()
    expect(frame).toContain('1 MISMATCH')
    expect(frame).toMatch(/WPLS .*MISMATCH/)
    expect(frame).toMatch(/USDC .* ok/)
  })

  test('the prover and costs view shows only on-chain updates, and says where proof timing is missing', async () => {
    app = await renderApp({ width: 120, height: 40 })
    await app.press('4')
    const frame = app.frame()
    expect(frame).toContain('Light client updates (on chain)')
    expect(frame).toContain('98,851')
    expect(frame).toContain('118,763')
    expect(frame).toContain('off chain')
    expect(frame).not.toContain('RunPod')
  })

  test('the global view lists the pair and Enter opens it in the pair view', async () => {
    app = await renderApp({ width: 120, height: 40 })
    await app.press('1')
    expect(app.frame()).toContain('Ethereum <> PulseChain')
    await app.press('RETURN')
    expect(app.frame()).toContain('Account and actions')
  })
})

describe('layout', () => {
  test('chooses wide, compact or too small from the terminal size', () => {
    expect(computePairLayout(120, 40).mode).toBe('wide')
    expect(computePairLayout(119, 40).mode).toBe('compact')
    expect(computePairLayout(100, 30).mode).toBe('compact')
    expect(computePairLayout(80, 24).mode).toBe('compact')
    expect(computePairLayout(77, 24).mode).toBe('tooSmall')
    expect(computePairLayout(120, 21).mode).toBe('tooSmall')
  })

  test('the areas add up to the terminal height at every size', () => {
    for (const [width, height] of [[80, 24], [100, 30], [120, 40], [200, 60]] as const) {
      const layout = computePairLayout(width, height)
      expect(layout.summaryHeight + layout.middleHeight + layout.headsHeight + 1).toBe(height)
    }
  })

  test('shows a message instead of a broken screen when the terminal is too small', async () => {
    app = await renderApp({ width: 60, height: 18 })
    expect(app.frame()).toContain('The terminal is too small.')
    expect(app.frame()).toContain('60 by 18')
  })

  test('resizes cleanly from wide to compact to too small and back', async () => {
    app = await renderApp({ width: 120, height: 40 })
    expect(app.frame()).toContain('PulseChain stores Ethereum')
    await app.resize(80, 24)
    expect(app.frame()).toContain('PLS<-ETH')
    expect(app.frame()).toContain('Feed 1/36')
    await app.resize(60, 18)
    expect(app.frame()).toContain('too small')
    await app.resize(120, 40)
    expect(app.frame()).toContain('PulseChain stores Ethereum')
    expect(app.frame()).toContain('Feed 1/36')
  })
})
