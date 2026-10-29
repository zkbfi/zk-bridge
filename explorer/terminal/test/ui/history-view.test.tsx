import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { EMPTY_CONNECTION_SETTINGS, type ChainReader, type ExplorerConnection, type ExplorerConnectionInput, type Pair } from '@zk-bridge/shared'
import { createConnectionRuntime } from '../../src/data/connection-runtime'
import type { HistoryTransport } from '../../src/data/history-source'
import { HistoryModal } from '../../src/ui/history-view'
import { createFakeChain } from '../../../shared/test/support/fake-chain'
import { SECOND_CHAIN, FIRST_CHAIN, buildScenario } from '../../../shared/test/support/scenario'
import { testPair } from '../../../shared/test/support/fixtures'
import { fakeChainAccesses, fakeConnections, livePair } from '../support/live-support'
import { renderModalAlone } from '../support/modal-harness'
import { renderApp } from './harness'

// The frame is polled for up to five seconds in some tests, and the machine can be busy.
setDefaultTimeout(30_000)

type Opened = Awaited<ReturnType<typeof renderModalAlone>>
let opened: Opened | null = null
let host: Awaited<ReturnType<typeof renderApp>> | null = null
afterEach(() => {
  opened?.destroy()
  host?.destroy()
  opened = null
  host = null
})

const KEY = 'KEYPART123456'
const sharedPair: Pair = testPair()
const idOf = (digit: string) => `0x${digit.repeat(64)}`
const event = (timestamp: number, digit: string, changes: Record<string, unknown> = {}) => ({
  kind: 'sent',
  chainId: FIRST_CHAIN,
  timestamp,
  transactionHash: idOf(digit),
  messageId: idOf(digit),
  slot: null,
  status: 'sent',
  ...changes,
})

/** Opens the history on a runtime whose connection takes the route given, with fake network reads. */
async function openHistory(input: { readonly route: 'indexer' | 'rpc'; readonly transport: HistoryTransport; readonly closed?: string[] }) {
  const { pair } = livePair()
  const connections = fakeConnections()
  const createConnection = (connectionInput: ExplorerConnectionInput): ExplorerConnection => {
    const fake = connections.createConnection(connectionInput)
    return input.route === 'indexer' ? fake : { ...fake, run: (operations) => operations.viaRpc() }
  }
  const runtime = createConnectionRuntime({
    pair,
    sharedPair,
    environment: { indexerUrl: `https://indexer.example.test/${KEY}`, rpcUrls: { [FIRST_CHAIN]: `https://one.example.test/${KEY}`, [SECOND_CHAIN]: `https://two.example.test/${KEY}` } },
    user: EMPTY_CONNECTION_SETTINGS,
    createConnection,
    createChainAccess: fakeChainAccesses().createChainAccess,
  })
  host = await renderApp({ width: 120, height: 40, pair, connection: runtime })
  opened = await renderModalAlone(host.services, <HistoryModal transport={input.transport} onClose={() => input.closed?.push('closed')} />)
  return opened
}

const noReader = (): ChainReader => {
  throw new Error('no reader expected')
}

describe('the history from the indexer', () => {
  /** Answers the first page with a next cursor and the second page with none, and records each URL. */
  function pagedTransport() {
    const urls: string[] = []
    const transport: HistoryTransport = {
      createReader: noReader,
      fetchJson: async (url) => {
        urls.push(url)
        const second = url.includes('cursor=')
        return {
          status: 200,
          body: second
            ? { items: [event(50, '3', { kind: 'delivered', chainId: SECOND_CHAIN, status: 'delivered' })], nextCursor: null, partial: false }
            : { items: [event(100, '1'), event(90, '2', { kind: 'head-update', messageId: null, slot: 9, status: null })], nextCursor: `90:head-update:${SECOND_CHAIN}-9`, partial: false },
        }
      },
    }
    return { transport, urls }
  }

  test('history pages and filters like the dapp', async () => {
    const { transport, urls } = pagedTransport()
    const view = await openHistory({ route: 'indexer', transport })
    let frame = await view.until('Head update')
    expect(frame).toContain('Page 1')
    expect(frame).toContain('Sent         Ethereum')
    expect(frame).toContain('0x111111…111111')
    expect(frame).toContain('slot 9')
    expect(frame).toContain('From the indexer.')

    await view.press('n')
    frame = await view.until('Page 2 (the last page)')
    expect(frame).toContain('Delivered    PulseChain')
    expect(urls[1]).toContain(`cursor=90%3Ahead-update%3A${SECOND_CHAIN}-9`)

    await view.press('n')
    await view.press('p')
    frame = await view.until('Page 1')
    expect(frame).toContain('Sent         Ethereum')
    await view.press('p')
    expect(view.frame()).toContain('Page 1')

    await view.press('c')
    await view.until('Chain Ethereum')
    await view.press('e')
    await view.until('Event Sent')
    await view.press('s')
    await view.until('Status sent')
    await view.press('d')
    await view.until('Direction Ethereum to PulseChain')
    await view.waitFor(() => urls.some((url) => url.includes('direction=')))
    const last = new URL(urls[urls.length - 1]!)
    expect(Object.fromEntries(last.searchParams)).toEqual({ chain: String(FIRST_CHAIN), eventKind: 'sent', direction: `${FIRST_CHAIN}>${SECOND_CHAIN}`, status: 'sent', limit: '20' })

    await view.press('d')
    await view.until('Direction PulseChain to Ethereum')
    await view.press('x')
    frame = await view.until('Chain all   Event all   Status all   Direction all')
    expect(frame).toContain('Direction all')
    expect(frame).not.toContain(KEY)
  })

  test('a filter that matches nothing says so', async () => {
    const transport: HistoryTransport = { createReader: noReader, fetchJson: async () => ({ status: 200, body: { items: [], nextCursor: null, partial: false } }) }
    const view = await openHistory({ route: 'indexer', transport })
    expect(await view.until('No event matches.')).toContain('Page 1 (the last page)')
  })

  test('r reads again, and a read that fails keeps the last page and says why', async () => {
    let healthy = true
    const transport: HistoryTransport = {
      createReader: noReader,
      fetchJson: async () => (healthy ? { status: 200, body: { items: [event(100, '1')], nextCursor: null, partial: false } } : { status: 500, body: null }),
    }
    const view = await openHistory({ route: 'indexer', transport })
    await view.until('Sent         Ethereum')
    healthy = false
    await view.press('r')
    const frame = await view.until('The last read failed: The indexer answered 500 for the history.')
    expect(frame).toContain('Sent         Ethereum')
  })

  test('the first read that fails shows the reason in place of the list', async () => {
    const transport: HistoryTransport = { createReader: noReader, fetchJson: async () => ({ status: 500, body: null }) }
    const view = await openHistory({ route: 'indexer', transport })
    expect(await view.until('The indexer answered 500 for the history.')).not.toContain('Reading the history')
  })

  test('Escape closes the history', async () => {
    const closed: string[] = []
    const transport: HistoryTransport = { createReader: noReader, fetchJson: async () => ({ status: 200, body: { items: [], nextCursor: null, partial: false } }) }
    const view = await openHistory({ route: 'indexer', transport, closed })
    await view.press('escape')
    await view.waitFor(() => closed.length > 0)
    expect(closed).toEqual(['closed'])
  })
})

describe('the history from the chains', () => {
  const scenario = buildScenario(sharedPair)
  const fromChains = (head: bigint | null = null): HistoryTransport => ({
    fetchJson: async () => {
      throw new Error('no indexer expected')
    },
    createReader: (readerInput) => {
      const chain = createFakeChain(scenario, readerInput.chainId)
      if (head !== null) chain.setHead(head)
      return chain
    },
  })

  test('the page says it is partial and names a filter that the chains could not apply', async () => {
    const view = await openHistory({ route: 'rpc', transport: fromChains() })
    let frame = await view.until('From the chains. This page is partial')
    expect(frame).toContain('Delivered')
    expect(frame).not.toContain('Not applied by the chains')
    await view.press('s')
    frame = await view.until('Not applied by the chains: status.')
    expect(frame).toContain('Status sent')
    expect(frame).not.toContain(KEY)
  })

  test('a chain read only part way back says how far back it was read', async () => {
    const view = await openHistory({ route: 'rpc', transport: fromChains(5_000_000n) })
    const frame = await view.until('was read back to block')
    expect(frame).toContain('Ethereum was read back to block')
    expect(frame).toContain('Older events are not listed.')
    expect(frame).toContain('No event matches.')
  })
})

describe('the history inside the app', () => {
  test('the t key opens the history; fixture data has no connection, so it says so; Escape closes it', async () => {
    host = await renderApp({ width: 120, height: 40 })
    await host.press('t')
    await host.settle(100)
    expect(host.frame()).toContain('The history needs a live connection. Fixture data has none.')
    await host.press('ESCAPE')
    await host.settle(300)
    expect(host.frame()).not.toContain('The history needs a live connection.')
  })
})
