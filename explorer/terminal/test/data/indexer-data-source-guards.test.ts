import { afterEach, describe, expect, test } from 'bun:test'
import { FIXTURE_PAIR } from '../../src/data/fixtures'
import { IndexerResponseError, createIndexerDataSource } from '../../src/data/indexer-data-source'

const home = '0x00000000000000000000000000000000000a0001'

const goodItem = {
  messageId: `0x${'1'.repeat(64)}`,
  kind: 'message',
  status: 'waiting_for_finality',
  direction: { sourceChainId: 369, destinationChainId: 1 },
  sender: '0x00000000000000000000000000000000000000aa',
  executor: '0x00000000000000000000000000000000000000bb',
  sent: { transactionHash: `0x${'2'.repeat(64)}`, timestamp: 1_900 },
  delivered: null,
  transfer: null,
}

function feedWith(answer: unknown) {
  return createIndexerDataSource({ baseUrl: 'http://indexer.test', pair: FIXTURE_PAIR, getJson: async () => answer }).getFeed('eth-pls', {}, 10)
}

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('default JSON getter', () => {
  test('requests the URL and returns the parsed body', async () => {
    const seen: string[] = []
    globalThis.fetch = (async (url: string) => {
      seen.push(url)
      return new Response(JSON.stringify({ heads: [] }), { status: 200 })
    }) as unknown as typeof fetch
    const heads = await createIndexerDataSource({ baseUrl: 'http://indexer.test/', pair: FIXTURE_PAIR }).getHeads('eth-pls')
    expect(heads).toEqual([])
    expect(seen).toEqual(['http://indexer.test/api/heads'])
  })

  test('a status that is not ok becomes an error that names the path and the status, and never the query', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 502 })) as unknown as typeof fetch
    const source = createIndexerDataSource({ baseUrl: 'http://indexer.test', pair: FIXTURE_PAIR })
    await expect(source.getDeliveryCost(1)).rejects.toThrow('The indexer answered 502 for /api/delivery-cost.')
  })

  test('the default clock gives unix seconds, so a fresh gate confirmation is not stale', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ gates: [{ chainId: 1, sealed: false, enforcing: true, depositsOpen: true, lastConfirmedTimestamp: Math.floor(Date.now() / 1000) }], heads: [], inFlight: { total: 0 }, lastHeadUpdates: [] }), {
        status: 200,
      })) as unknown as typeof fetch
    const [health] = await createIndexerDataSource({ baseUrl: 'http://indexer.test', pair: FIXTURE_PAIR }).listPairs()
    expect(health?.gates).toEqual({ first: 'open', second: 'unknown' })
  })
})

describe('getHeads', () => {
  test('maps each head to its side with the slot time of its tracked chain', async () => {
    const urls: string[] = []
    const source = createIndexerDataSource({
      baseUrl: 'http://indexer.test',
      pair: FIXTURE_PAIR,
      getJson: async (url) => {
        urls.push(url)
        return {
          heads: [
            { chainId: 1, trackedChainId: 369, storedHeadSlot: 7, finalizedSlot: 9, lagSlots: 2, lastUpdateTimestamp: 50 },
            { chainId: 369, trackedChainId: 1, storedHeadSlot: null, finalizedSlot: null, lagSlots: null, lastUpdateTimestamp: null },
          ],
        }
      },
    })
    expect(await source.getHeads('eth-pls')).toEqual([
      { side: 'first', storedHeadSlot: 7n, finalizedSlot: 9n, lagSlots: 2n, secondsPerSlot: 10, lastUpdateAt: 50 },
      { side: 'second', storedHeadSlot: null, finalizedSlot: null, lagSlots: null, secondsPerSlot: 12, lastUpdateAt: null },
    ])
    expect(urls).toEqual(['http://indexer.test/api/heads'])
  })

  test('refuses a pair that the indexer does not serve', async () => {
    const source = createIndexerDataSource({ baseUrl: 'http://indexer.test', pair: FIXTURE_PAIR, getJson: async () => ({ heads: [] }) })
    await expect(source.getHeads('other')).rejects.toThrow('This indexer serves the pair eth-pls, not other.')
  })
})

describe('shape guards at the edge of the indexer answer', () => {
  test('accepts a well formed item, so the failures below come from the one changed field', async () => {
    const page = await feedWith({ items: [goodItem], nextCursor: 'abc' })
    expect(page.hasMore).toBe(true)
    expect(page.items[0]).toMatchObject({ direction: 'second-to-first', kind: 'message', sentAt: 1_900, deliveredAt: null })
  })

  test('an answer that is not an object is refused with the name of the part', async () => {
    await expect(feedWith([])).rejects.toThrow('The feed answer is not an object.')
    await expect(feedWith(null)).rejects.toThrow('The feed answer is not an object.')
  })

  test('a list that is not a list is refused with the name of the part', async () => {
    await expect(feedWith({ items: 'x' })).rejects.toThrow('The items is not a list.')
  })

  test('a field that is not text is refused', async () => {
    await expect(feedWith({ items: [{ ...goodItem, status: 3 }] })).rejects.toThrow('The status is not text.')
    await expect(feedWith({ items: [{ ...goodItem, sender: undefined }] })).rejects.toThrow('The sender is not text.')
  })

  test('a field that is not a safe integer is refused', async () => {
    await expect(feedWith({ items: [{ ...goodItem, sent: { ...goodItem.sent, timestamp: '1900' } }] })).rejects.toThrow('The sent.timestamp is not an integer.')
    await expect(feedWith({ items: [{ ...goodItem, sent: { ...goodItem.sent, timestamp: 2 ** 60 } }] })).rejects.toThrow('The sent.timestamp is not an integer.')
  })

  test('a field that is not hex is refused', async () => {
    await expect(feedWith({ items: [{ ...goodItem, messageId: 'not hex' }] })).rejects.toThrow('The messageId is not hex.')
    await expect(feedWith({ items: [{ ...goodItem, messageId: 12 }] })).rejects.toThrow('The messageId is not hex.')
  })

  test('every refusal is an IndexerResponseError', async () => {
    await expect(feedWith({ items: 'x' })).rejects.toBeInstanceOf(IndexerResponseError)
  })

  test('a token view without a symbol shows the start of its address, and without decimals shows 18', async () => {
    const item = {
      ...goodItem,
      kind: 'token',
      transfer: {
        sourceToken: { chainId: 1, address: home },
        sender: goodItem.sender,
        recipient: goodItem.executor,
        value: null,
      },
    }
    const page = await feedWith({ items: [item], nextCursor: null })
    expect(page.items[0]?.token).toMatchObject({ symbol: '0x000000…', decimals: 18, side: 'first', counterpart: null })
    expect(page.items[0]?.amount).toBeNull()
  })
})
