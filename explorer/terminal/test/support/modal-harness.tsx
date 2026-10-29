/**
 * Renders one modal alone, inside the services of a test app. The tests of the proof panel and the history use it, so
 * that they can pass fake network reads as props, which the whole app does not offer.
 */
import { testRender } from '@opentui/react/test-utils'
import { act, type ReactNode } from 'react'
import { ServicesProvider, type AppServices } from '../../src/app/services'
import { KeyRouterProvider } from '../../src/ui/key-router'

/** Renders the node and returns helpers to drive it. */
export async function renderModalAlone(services: AppServices, node: ReactNode) {
  const setup = await testRender(
    <ServicesProvider services={services}>
      <KeyRouterProvider>{node}</KeyRouterProvider>
    </ServicesProvider>,
    { width: 120, height: 40 },
  )
  const settle = async (milliseconds = 30) => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, milliseconds))
      await setup.renderOnce()
    })
  }
  const press = async (key: string) => {
    await act(async () => {
      if (key === 'escape') setup.mockInput.pressEscape()
      else setup.mockInput.pressKey(key === 'return' ? 'RETURN' : key)
    })
    await settle(key === 'escape' ? 400 : 60)
  }
  const type = async (text: string) => {
    await act(async () => {
      await setup.mockInput.typeText(text)
    })
    await settle(20)
  }
  const frame = () => setup.captureCharFrame()
  /** Waits until the frame holds the text, for at most five seconds. */
  const until = async (text: string) => {
    for (let attempt = 0; attempt < 100 && !frame().includes(text); attempt += 1) await settle(50)
    return frame()
  }
  /** Waits until the condition holds, for at most five seconds. */
  const waitFor = async (condition: () => boolean) => {
    for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) await settle(50)
  }
  await settle()
  return { setup, settle, press, type, frame, until, waitFor, destroy: () => setup.renderer.destroy() }
}
