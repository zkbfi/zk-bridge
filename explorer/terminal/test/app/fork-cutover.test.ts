import { describe, expect, test } from 'bun:test'
import { FIXTURE_PAIR } from '../../src/data/fixtures'
import { cutoverRouteOf, forkCutoverCheckFor } from '../../src/app/fork-cutover'

const pair = FIXTURE_PAIR
const FORK_TIME = 1_000_000 + 50 * 384

/** A beacon node whose schedule has one fork at epoch 50 and whose clock starts at 1,000,000. */
const beacon = (async (url: string) => {
  const body = url.includes('fork_schedule')
    ? { data: [{ current_version: '0x90000069', epoch: '0' }, { current_version: '0x90000070', epoch: '50' }] }
    : url.includes('genesis')
      ? { data: { genesis_time: '1000000' } }
      : { data: { SECONDS_PER_SLOT: '12', SLOTS_PER_EPOCH: '32' } }
  return new Response(JSON.stringify(body), { status: 200 })
}) as unknown as typeof globalThis.fetch

describe('cutoverRouteOf', () => {
  test('follows a send from either chain to the light client on the other one', () => {
    const route = cutoverRouteOf(pair)
    expect(route(pair.first.chainId)).toEqual({ destinationChainId: pair.second.chainId, lightClient: pair.second.contracts.lightClient })
    expect(route(pair.second.chainId)).toEqual({ destinationChainId: pair.first.chainId, lightClient: pair.first.contracts.lightClient })
    expect(route(5)).toBeNull()
  })
})

describe('forkCutoverCheckFor', () => {
  test('is absent with fixture data', () => {
    expect(forkCutoverCheckFor({ pair, connection: null, chainAccess: { flowClient: () => ({}) as never } })).toBeUndefined()
  })

  test('pauses a send inside the lead, from the beacon schedule and the light client head', async () => {
    const check = forkCutoverCheckFor({
      pair,
      connection: { resolved: () => ({}) } as never,
      chainAccess: { flowClient: () => ({ readContract: async () => 1000n }) as never },
      fetch: beacon,
      nowSeconds: () => FORK_TIME - 60,
    })!
    expect(await check(pair.first.chainId)).toMatchObject({ kind: 'paused', destinationChainId: pair.second.chainId })
  })

  test('uses the system clock by default', async () => {
    const check = forkCutoverCheckFor({ pair, connection: { resolved: () => ({}) } as never, chainAccess: { flowClient: () => ({ readContract: async () => 99_999n }) as never }, fetch: beacon })!
    expect((await check(pair.first.chainId)).kind).toBe('open')
  })
})
