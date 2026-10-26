import { afterEach, describe, expect, test } from 'bun:test'
import { testRender } from '@opentui/react/test-utils'
import { act, useState } from 'react'
import { usePolling, type PollingState } from '../../src/ui/use-polling'

let destroy: (() => void) | null = null
afterEach(() => {
  destroy?.()
  destroy = null
})

type Loader = () => Promise<string>

interface Handle {
  polling: PollingState<string> | null
  setKey: (next: string) => void
}

function Probe(props: { readonly load: Loader; readonly handle: Handle }) {
  const [queryKey, setQueryKey] = useState('a')
  const polling = usePolling(props.load, queryKey, 0)
  props.handle.polling = polling
  props.handle.setKey = setQueryKey
  return <text>{`key=${queryKey} data=${polling.data ?? 'none'} error=${polling.error ?? 'none'} loading=${polling.loading}`}</text>
}

async function mount(load: Loader) {
  const handle: Handle = { polling: null, setKey: () => undefined }
  const setup = await testRender(<Probe load={load} handle={handle} />, { width: 100, height: 3 })
  destroy = () => setup.renderer.destroy()
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    await act(async () => {
      await setup.renderOnce()
    })
  }
  await settle()
  return {
    handle,
    settle,
    text: () => setup.captureCharFrame().split('\n')[0]!.trim(),
  }
}

describe('usePolling', () => {
  test('shows the loaded data and no error', async () => {
    const view = await mount(async () => 'first')
    expect(view.text()).toBe('key=a data=first error=none loading=no')
  })

  test('shows the message of an Error from a failed first load, with no data', async () => {
    const view = await mount(async () => Promise.reject(new Error('indexer is down')))
    expect(view.text()).toBe('key=a data=none error=indexer is down loading=no')
  })

  test('turns a rejection that is not an Error into text', async () => {
    const view = await mount(() => Promise.reject('plain text failure'))
    expect(view.text()).toBe('key=a data=none error=plain text failure loading=no')
  })

  test('keeps the last good data when a later load fails, and clears the error when a load works again', async () => {
    const answers: (() => Promise<string>)[] = [async () => 'good', async () => Promise.reject(new Error('timeout')), async () => 'better']
    const view = await mount(() => answers.shift()!())
    expect(view.text()).toBe('key=a data=good error=none loading=no')
    await act(async () => view.handle.polling!.refresh())
    await view.settle()
    expect(view.text()).toBe('key=a data=good error=timeout loading=no')
    await act(async () => view.handle.polling!.refresh())
    await view.settle()
    expect(view.text()).toBe('key=a data=better error=none loading=no')
  })

  test('drops the data of the old query when a failure comes for a new key', async () => {
    const answers: (() => Promise<string>)[] = [async () => 'for-a', async () => Promise.reject(new Error('no such filter'))]
    const view = await mount(() => answers.shift()!())
    expect(view.text()).toBe('key=a data=for-a error=none loading=no')
    await act(async () => view.handle.setKey('b'))
    await view.settle()
    expect(view.text()).toBe('key=b data=none error=no such filter loading=no')
  })
})
