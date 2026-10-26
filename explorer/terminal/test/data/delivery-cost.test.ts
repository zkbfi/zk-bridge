import { describe, expect, test } from 'bun:test'
import { FIXTURE_NOW, FIXTURE_PAIR, buildFixtureDeliveryCost, createFixtureDataSource } from '../../src/data/fixtures'
import { IndexerResponseError, createIndexerDataSource } from '../../src/data/indexer-data-source'

describe('indexer data source: delivery cost', () => {
  test('asks GET /api/delivery-cost for the chain and returns the parsed report', async () => {
    const requested: string[] = []
    const answer = buildFixtureDeliveryCost(369, FIXTURE_NOW)
    const source = createIndexerDataSource({
      baseUrl: 'http://indexer.test/',
      pair: FIXTURE_PAIR,
      getJson: async (url) => {
        requested.push(url)
        return answer
      },
    })
    expect(await source.getDeliveryCost(369)).toEqual(answer)
    expect(requested).toEqual(['http://indexer.test/api/delivery-cost?chainId=369'])
  })

  test('refuses an answer that is not the report, with a message about the delivery cost', async () => {
    const source = createIndexerDataSource({ baseUrl: 'http://indexer.test', pair: FIXTURE_PAIR, getJson: async () => ({ chainId: 369, kinds: {} }) })
    await expect(source.getDeliveryCost(369)).rejects.toThrow(IndexerResponseError)
    await expect(source.getDeliveryCost(369)).rejects.toThrow('The delivery cost answer is not valid')
  })

  test('refuses an amount that is a JSON number, because it may have lost digits', async () => {
    const answer = buildFixtureDeliveryCost(369, FIXTURE_NOW)
    const source = createIndexerDataSource({ baseUrl: 'http://indexer.test', pair: FIXTURE_PAIR, getJson: async () => ({ ...answer, baseFee: { ...answer.baseFee, wei: 7_000_000_000 } }) })
    await expect(source.getDeliveryCost(369)).rejects.toThrow('The delivery cost answer is not valid')
  })
})

describe('fixture data source: delivery cost', () => {
  test('the callback kind is measured with a p90 and the other kinds are defaults, so both labels show', async () => {
    const report = await createFixtureDataSource({ now: () => FIXTURE_NOW }).getDeliveryCost(369)
    expect(report.chainId).toBe(369)
    expect(report.kinds.token_callback).toMatchObject({ isDefault: false, sampleCount: 40, p90Gas: '210000' })
    expect(report.kinds.token).toMatchObject({ isDefault: true, sampleCount: 0, p90Gas: null })
    expect(report.kinds.message).toMatchObject({ isDefault: true, sampleCount: 0, p90Gas: null })
  })

  test('the base fee block is 12 seconds before the pinned clock', async () => {
    const report = await createFixtureDataSource({ now: () => FIXTURE_NOW }).getDeliveryCost(1)
    expect(report.baseFee.timestamp).toBe(FIXTURE_NOW - 12)
    expect(report.proofCost.wei).toBe('8000000000000')
  })
})
