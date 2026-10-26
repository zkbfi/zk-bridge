import { describe, expect, test } from 'bun:test'
import { getAddress, zeroAddress, type Address } from 'viem'
import { readRouterAddresses, type ReadClient } from '../../src/chain/live-reads'
import { createFixtureChainAccess } from '../../src/chain/fixture-chain-access'
import { FIXTURE_PAIR } from '../../src/data/fixtures'

const router: Address = '0x00000000000000000000000000000000000000a2'

/** A client that answers every contract read with one value, or fails. */
function clientAnswering(answer: () => unknown, byName: Record<string, () => unknown> = {}): ReadClient & { readonly asked: { address: Address; functionName: string }[] } {
  const asked: { address: Address; functionName: string }[] = []
  return {
    asked,
    async getBalance() {
      return 0n
    },
    async readContract(parameters) {
      asked.push({ address: parameters.address, functionName: parameters.functionName })
      return (byName[parameters.functionName] ?? answer)()
    },
  }
}

const reward = '0x00000000000000000000000000000000000000f1'
const failedDelivery = '0x00000000000000000000000000000000000000f2'

/** A client that answers each function by name, so a test can fail one function and keep the other. */
function clientAnsweringByName(answers: Record<string, () => unknown>) {
  return clientAnswering(() => {
    throw new Error('unused')
  }, answers)
}

describe('readRouterAddresses', () => {
  test('reads both addresses from the router, each from its own function, so the screen never shows one address for both roles', async () => {
    const client = clientAnsweringByName({ rewardAddress: () => reward, failedDeliveryAddress: () => failedDelivery })
    expect(await readRouterAddresses(client, { router })).toEqual({ kind: 'read', rewardAddress: getAddress(reward), failedDeliveryAddress: getAddress(failedDelivery) })
    expect(client.asked).toEqual([
      { address: router, functionName: 'rewardAddress' },
      { address: router, functionName: 'failedDeliveryAddress' },
    ])
    const swapped = clientAnsweringByName({ rewardAddress: () => failedDelivery, failedDeliveryAddress: () => reward })
    expect(await readRouterAddresses(swapped, { router })).toEqual({ kind: 'read', rewardAddress: getAddress(failedDelivery), failedDeliveryAddress: getAddress(reward) })
  })

  test('is unreadable when the failed delivery read fails although the reward read works: a router of the old version must not look complete', async () => {
    const client = clientAnsweringByName({
      rewardAddress: () => reward,
      failedDeliveryAddress: () => {
        throw new Error('The contract function "failedDeliveryAddress" reverted.\nDetails: execution reverted')
      },
    })
    expect(await readRouterAddresses(client, { router })).toEqual({ kind: 'unreadable', reason: 'The contract function "failedDeliveryAddress" reverted.' })
  })

  test('is unreadable, with the reason, when the reward read fails; it does not ask for the second address', async () => {
    const client = clientAnsweringByName({
      rewardAddress: () => {
        throw new Error('The contract function "rewardAddress" reverted.\nDetails: execution reverted')
      },
      failedDeliveryAddress: () => failedDelivery,
    })
    expect(await readRouterAddresses(client, { router })).toEqual({ kind: 'unreadable', reason: 'The contract function "rewardAddress" reverted.' })
    expect(client.asked).toEqual([{ address: router, functionName: 'rewardAddress' }])
  })

  test('the zero address is unreadable for either function: the router of this version refuses zero, so it is not that router', async () => {
    const zeroReward = clientAnsweringByName({ rewardAddress: () => zeroAddress, failedDeliveryAddress: () => failedDelivery })
    expect(await readRouterAddresses(zeroReward, { router })).toEqual({ kind: 'unreadable', reason: 'The router returned the zero address for rewardAddress().' })
    const zeroFailed = clientAnsweringByName({ rewardAddress: () => reward, failedDeliveryAddress: () => zeroAddress })
    expect(await readRouterAddresses(zeroFailed, { router })).toEqual({ kind: 'unreadable', reason: 'The router returned the zero address for failedDeliveryAddress().' })
  })

  test('an answer that is not an address is unreadable for either function', async () => {
    for (const answer of [7n, '0x']) {
      const badReward = clientAnsweringByName({ rewardAddress: () => answer, failedDeliveryAddress: () => failedDelivery })
      expect(await readRouterAddresses(badReward, { router })).toEqual({ kind: 'unreadable', reason: 'The router did not return an address.' })
      const badFailed = clientAnsweringByName({ rewardAddress: () => reward, failedDeliveryAddress: () => answer })
      expect(await readRouterAddresses(badFailed, { router })).toEqual({ kind: 'unreadable', reason: 'The router did not return an address.' })
    }
  })
})

describe('the fixture chain access', () => {
  test('answers the reading that the test sets', async () => {
    const reading = { kind: 'unreadable', reason: 'no answer' } as const
    const access = createFixtureChainAccess(FIXTURE_PAIR, { routerAddresses: reading })
    expect(await access.readRouterAddresses({ chainId: FIXTURE_PAIR.second.chainId, router })).toEqual(reading)
  })

  test('answers two different non-zero addresses by default, so a screen test cannot pass by showing one address twice', async () => {
    const reading = await createFixtureChainAccess(FIXTURE_PAIR).readRouterAddresses({ chainId: FIXTURE_PAIR.second.chainId, router })
    if (reading.kind !== 'read') throw new Error('the fixture default must be a reading')
    expect(reading.rewardAddress.toLowerCase()).toBe('0x00000000000000000000000000000000000000ab')
    expect(reading.failedDeliveryAddress.toLowerCase()).toBe('0x00000000000000000000000000000000000000cd')
    expect(reading.rewardAddress.toLowerCase()).not.toBe(reading.failedDeliveryAddress.toLowerCase())
  })
})
