import { afterEach, describe, expect, test } from 'bun:test'
import { renderApp } from '../ui/harness'

type App = Awaited<ReturnType<typeof renderApp>>
let app: App | null = null
afterEach(() => {
  app?.destroy()
  app = null
})

describe('the number keys of the global layer', () => {
  test('a digit with no view behind it changes nothing', async () => {
    app = await renderApp({ width: 120, height: 40 })
    expect(app.frame()).toContain('[2 Pair]')
    await app.press('7')
    await app.press('9')
    expect(app.frame()).toContain('[2 Pair]')
    expect(app.quits()).toBe(0)
  })

  test('the last digit with a view opens the setup view, and zero does nothing', async () => {
    app = await renderApp({ width: 120, height: 40 })
    await app.press('0')
    expect(app.frame()).toContain('[2 Pair]')
    await app.press('6')
    expect(app.frame()).toContain('[6 Prover setup]')
  })
})
