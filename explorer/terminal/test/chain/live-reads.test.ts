import { describe, expect, test } from 'bun:test'
import { getAddress, zeroAddress, type Address } from 'viem'
import { readRewardAddress, type ReadClient } from '../../src/chain/live-reads'
import { createFixtureChainAccess } from '../../src/chain/fixture-chain-access'
import { FIXTURE_PAIR } from '../../src/data/fixtures'

const router: Address = '0x00000000000000000000000000000000000000a2'

/** A client that answers every contract read with one value, or fails. */
function clientAnswering(answer: () => unknown): ReadClient & { readonly asked: { address: Address; functionName: string }[] } {
  const asked: { address: Address; functionName: string }[] = []
  return {
    asked,
    async getBalance() {
      return 0n
    },
    async readContract(parameters) {
      asked.push({ address: parameters.address, functionName: parameters.functionName })
      return answer()
    },
  }
}

describe('readRewardAddress', () => {
  test('returns the address that the router answers, so the screen shows the router and not a constant', async () => {
    const one = '0x00000000000000000000000000000000000000f1'
    const two = '0x00000000000000000000000000000000000000f2'
    const client = clientAnswering(() => one)
    expect(await readRewardAddress(client, { router })).toEqual({ kind: 'read', address: getAddress(one) })
    expect(client.asked).toEqual([{ address: router, functionName: 'rewardAddress' }])
    expect(await readRewardAddress(clientAnswering(() => two), { router })).toEqual({ kind: 'read', address: getAddress(two) })
  })

  test('an older router with no such function (the read reverts) is unreadable, with the reason', async () => {
    const reading = await readRewardAddress(
      clientAnswering(() => {
        throw new Error('The contract function "rewardAddress" reverted.\nDetails: execution reverted')
      }),
      { router },
    )
    expect(reading).toEqual({ kind: 'unreadable', reason: 'The contract function "rewardAddress" reverted.' })
  })

  test('an answer that is not an address, and the zero address, are unreadable: the router of this version refuses zero', async () => {
    expect((await readRewardAddress(clientAnswering(() => 7n), { router })).kind).toBe('unreadable')
    expect((await readRewardAddress(clientAnswering(() => '0x'), { router })).kind).toBe('unreadable')
    expect((await readRewardAddress(clientAnswering(() => zeroAddress), { router })).kind).toBe('unreadable')
  })
})

describe('the fixture chain access', () => {
  test('answers the reading that the test sets', async () => {
    const reading = { kind: 'unreadable', reason: 'no answer' } as const
    const access = createFixtureChainAccess(FIXTURE_PAIR, { rewardAddress: reading })
    expect(await access.readRewardAddress({ chainId: FIXTURE_PAIR.second.chainId, router })).toEqual(reading)
  })
})
