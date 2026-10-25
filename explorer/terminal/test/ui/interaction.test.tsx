import { afterEach, describe, expect, test } from 'bun:test'
import { VIEWS, VIEW_LABELS } from '../../src/app/app-state'
import { renderApp } from './harness'

type App = Awaited<ReturnType<typeof renderApp>>
let app: App | null = null
afterEach(() => {
  app?.destroy()
  app = null
})

describe('navigation', () => {
  test('number keys switch views and the tab line marks the open one', async () => {
    app = await renderApp({ width: 120, height: 40 })
    expect(app.frame()).toContain('[2 Pair]')
    await app.press('3')
    expect(app.frame()).toContain('[3 Audit]')
    await app.press('4')
    expect(app.frame()).toContain('[4 Prover and costs]')
    await app.press('1')
    expect(app.frame()).toContain('[1 Global]')
  })

  test('Tab moves focus through actions, filters and feed, and Shift+Tab goes back', async () => {
    app = await renderApp({ width: 120, height: 40 })
    expect(app.frame()).toContain('Enter open  Up/Down move')
    await app.press('TAB')
    expect(app.frame()).toContain('Left/Right field')
    await app.press('TAB')
    expect(app.frame()).toContain('Enter details')
    await app.press('TAB')
    expect(app.frame()).toContain('Enter open  Up/Down move')
    await app.press('TAB', { shift: true })
    expect(app.frame()).toContain('Enter details')
  })

  test('the action menu moves with the arrow keys and wraps', async () => {
    app = await renderApp({ width: 120, height: 40 })
    expect(app.frame()).toContain('> Account and signer')
    await app.press('ARROW_DOWN')
    expect(app.frame()).toContain('> Bridge tokens')
    await app.press('ARROW_UP')
    await app.press('ARROW_UP')
    expect(app.frame()).toContain('> Operator: execute message')
  })

  test('the feed selection moves and Enter shows the full details with the transaction hashes', async () => {
    app = await renderApp({ width: 120, height: 40 })
    await app.press('TAB')
    await app.press('TAB')
    await app.press('ARROW_DOWN')
    expect(app.frame()).toContain('Feed 2/36')
    await app.press('RETURN')
    const frame = app.frame()
    expect(frame).toContain('Transfer or message')
    expect(frame).toContain(`0x${'0'.repeat(61)}101`)
    await app.press('ESCAPE')
    expect(app.frame()).not.toContain('Transfer or message')
  })

  test('? opens the help and any key closes it', async () => {
    app = await renderApp({ width: 120, height: 40 })
    await app.press('?')
    expect(app.frame()).toContain('Help')
    await app.press('x')
    expect(app.frame()).not.toContain('Press any key to close.')
    // The key that closed the help did not also act: the pair view is still open.
    expect(app.frame()).toContain('[2 Pair]')
  })

  test('q asks the renderer to quit and never ends the process itself', async () => {
    app = await renderApp({ width: 120, height: 40 })
    await app.press('q')
    expect(app.quits()).toBe(1)
  })

  test('a modal takes the keys: typing 3 in a form does not change the view', async () => {
    app = await renderApp({ width: 120, height: 40 })
    await app.press('TAB')
    await app.press('TAB')
    await app.press('ARROW_DOWN')
    await app.press('RETURN')
    await app.press('3')
    expect(app.frame()).toContain('[2 Pair]')
  })
})

describe('filters', () => {
  async function focusFilters(target: App) {
    await target.press('TAB')
  }

  test('direction filter keeps only rows of that direction', async () => {
    app = await renderApp({ width: 120, height: 40 })
    expect(app.frame()).toContain('Feed 1/36')
    await focusFilters(app)
    await app.press('ARROW_DOWN')
    const frame = app.frame()
    expect(frame).toContain('Dir:ETH>PLS')
    expect(frame).not.toContain('PLS>ETH tok')
    expect(frame).not.toContain('Feed 1/36')
    await app.press('x')
    expect(app.frame()).toContain('Feed 1/36')
    expect(app.frame()).toContain('Dir:all')
  })

  test('kind, status and time range filters narrow the feed, and each shows in the header', async () => {
    app = await renderApp({ width: 120, height: 40 })
    await focusFilters(app)
    await app.press('ARROW_RIGHT')
    await app.press('ARROW_DOWN') // kind: token
    await app.press('ARROW_DOWN') // kind: message
    expect(app.frame()).toContain('Kind:message')
    expect(app.frame()).not.toMatch(/ tok /)
    await app.press('ARROW_RIGHT')
    await app.press('ARROW_DOWN') // status: sent
    expect(app.frame()).toContain('Status:sent')
    await app.press('x') // the focus stays on the status field
    for (let step = 0; step < 3; step += 1) await app.press('ARROW_RIGHT') // token, address, time
    await app.press('ARROW_DOWN') // time: 1h
    expect(app.frame()).toContain('Time:1h')
    expect(app.frame()).toMatch(/Feed 1\/[1-4]\b/)
    expect(app.frame()).not.toContain('Feed 1/36')
  })

  test('the token filter cycles through the tokens of the bridge', async () => {
    app = await renderApp({ width: 120, height: 40 })
    await focusFilters(app)
    for (let step = 0; step < 3; step += 1) await app.press('ARROW_RIGHT')
    await app.press('ARROW_DOWN')
    expect(app.frame()).toContain('Token:USDC')
    expect(app.frame()).toMatch(/Feed 1\/\d+/)
    expect(app.frame()).not.toContain('zkWETH')
  })

  test('the address filter takes typed text, matches sender or recipient, and refuses a bad address', async () => {
    app = await renderApp({ width: 120, height: 40 })
    await focusFilters(app)
    for (let step = 0; step < 4; step += 1) await app.press('ARROW_RIGHT')
    await app.press('RETURN')
    expect(app.frame()).toContain('Address filter')
    await app.type('0x1234')
    await app.press('RETURN')
    expect(app.frame()).toContain('That is not an address')
    for (let count = 0; count < 6; count += 1) await app.press('BACKSPACE')
    await app.type(`0x${'0'.repeat(36)}abc1`)
    await app.press('RETURN')
    expect(app.frame()).toContain('Addr:0x0000…abc1')
    expect(app.frame()).toMatch(/Feed 1\/\d+/)
    expect(app.frame()).not.toContain('Feed 1/36')
  })
})
