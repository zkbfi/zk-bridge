import { describe, expect, test } from 'bun:test'
import { decodeDeliveryCall } from '@zk-bridge/shared'
import { decodeFunctionData, getAddress, type Hex } from 'viem'
import { buildBridgeSteps, deliveryCallOf } from '../../src/app/actions'
import { createFixtureChainAccess } from '../../src/chain/fixture-chain-access'
import { FIXTURE_ACCOUNT, FIXTURE_NOW, FIXTURE_PAIR, FIXTURE_TOKENS, buildFixtureDeliveryCost } from '../../src/data/fixtures'
import { tokenMediatorAbi } from '../../src/tx/abis'
import { PlanInputError, planRelay } from '../../src/tx/plan'
import { reviewLines } from '../../src/ui/review-lines'
import { lineText } from '../../src/ui/rich-text'

const usdc = FIXTURE_TOKENS[0]!
const zkUsdc = FIXTURE_TOKENS[1]!
const target = '0x00000000000000000000000000000000000000c9'
const otherTarget = '0x00000000000000000000000000000000000000ca'
const values = { token: `first:${usdc.address}`, amount: '100', receiver: '0x00000000000000000000000000000000000000d1', mode: 'plain', delivery: 'yes', feeMode: 'percentage', feePercent: '0.5', feeMargin: '10', feePriorityGwei: '1' }

/** The director of the values above: recipient d1, settings 8 (share), limit 0, multiplier 0.005 * 1e18. */
const DIRECTOR_HEX = '0x00000000000000000000000000000000000000000000000000000000000000d1000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000011c37937e08000'

async function planFor(overrides: Record<string, string>, feeMode = values.feeMode) {
  const snapshots = await createFixtureChainAccess(FIXTURE_PAIR).readSnapshots({ account: FIXTURE_ACCOUNT, tokens: FIXTURE_TOKENS })
  const steps = buildBridgeSteps({ ...values, feeMode, ...overrides }, FIXTURE_TOKENS, {
    pair: FIXTURE_PAIR,
    snapshots,
    signerAddress: FIXTURE_ACCOUNT,
    deliveryCost: buildFixtureDeliveryCost(369, FIXTURE_NOW),
    tokenValuationsWei: { [zkUsdc.address.toLowerCase()]: 400_000_000_000_000n },
  })
  return steps[steps.length - 1]!.plan
}

const callbackDataOf = (data: Hex): Hex => (decodeFunctionData({ abi: tokenMediatorAbi, data }).args as readonly unknown[])[3] as Hex

const reviewTextOf = (plan: Awaited<ReturnType<typeof planFor>>): string =>
  reviewLines(
    { plan, from: FIXTURE_ACCOUNT, unsigned: { type: 'eip1559', chainId: 1, nonce: 1, to: plan.to, data: plan.data, value: 0n, gas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }, gasEstimate: 1n, gasLimit: 1n, maximumNetworkFee: 1n },
    { position: null, calldata: 'summary', wrapWidth: 80 },
  )
    .map(lineText)
    .join('\n')

describe('the call after a delivery in the bridge form', () => {
  test('empty fields give exactly the fee terms and no call', async () => {
    expect(callbackDataOf((await planFor({})).data)).toBe(DIRECTOR_HEX)
    expect(callbackDataOf((await planFor({ callTarget: '  ', callData: '' })).data)).toBe(DIRECTOR_HEX)
    expect((await planFor({})).deliveryFee?.call).toBeUndefined()
  })

  test('a target and call data append the lowercase target and the call data to the fee terms', async () => {
    const plan = await planFor({ callTarget: target, callData: '0xdeadbeef' })
    expect(callbackDataOf(plan.data)).toBe(`${DIRECTOR_HEX}00000000000000000000000000000000000000c9deadbeef`)
    expect(plan.deliveryFee?.call).toEqual({ target: getAddress(target), data: '0xdeadbeef' })
  })

  test('a target without call data is a call with empty call data', async () => {
    const plan = await planFor({ callTarget: target })
    expect(callbackDataOf(plan.data)).toBe(`${DIRECTOR_HEX}00000000000000000000000000000000000000c9`)
    expect(plan.deliveryFee?.call).toEqual({ target: getAddress(target), data: '0x' })
  })

  test('call data without a target is refused with a sentence', async () => {
    await expect(planFor({ callData: '0xdeadbeef' })).rejects.toThrow('The call data needs a call target. Name the contract to call, or clear the call data.')
    expect(() => deliveryCallOf({ callData: '0xdeadbeef' })).toThrow(PlanInputError)
  })

  test('a call target that is not an address, and call data that is odd or not hex, are refused', async () => {
    await expect(planFor({ callTarget: '0x1234' })).rejects.toThrow('The call target is not an address.')
    await expect(planFor({ callTarget: target, callData: '0xabc' })).rejects.toThrow('The data must be hex with an even number of digits, such as 0xabcd.')
    await expect(planFor({ callTarget: target, callData: '0xzz' })).rejects.toThrow('The data must be hex with an even number of digits, such as 0xabcd.')
  })

  test('the guard refuses the zero address, the router and the mediator as the call target', async () => {
    await expect(planFor({ callTarget: '0x0000000000000000000000000000000000000000' })).rejects.toThrow('The target of the call is the zero address.')
    await expect(planFor({ callTarget: FIXTURE_PAIR.second.contracts.deliveryRouter! })).rejects.toThrow('The target of the call is the router itself.')
    await expect(planFor({ callTarget: FIXTURE_PAIR.second.contracts.tokenMediator })).rejects.toThrow('The target of the call is the mediator of')
  })

  test('the call fields are ignored when the tip is off, because that relay carries no terms', async () => {
    const plan = await planFor({ delivery: 'no', callTarget: target, callData: '0xdeadbeef' })
    expect(plan.deliveryFee).toBeUndefined()
    expect(plan.functionName).toBe('relayTokens')
  })

  test('the review shows the target, the call data and, for a gas based tip, the one line warning', async () => {
    const text = reviewTextOf(await planFor({ callTarget: target, callData: '0xdeadbeef' }, 'gas'))
    expect(text).toContain(`Call target   ${getAddress(target)}`)
    expect(text).toContain('Call data     0xdeadbeef (4 bytes)')
    expect(text).toContain('Warning: a gas based tip counts the gas of the call, so expect the tip to reach its limit.')
    const percentage = reviewTextOf(await planFor({ callTarget: target }))
    expect(percentage).toContain('Call data     0x (empty)')
    expect(percentage).not.toContain('counts the gas of the call')
    expect(reviewTextOf(await planFor({}))).not.toContain('Call target')
  })
})

describe('planRelay compares the call as well as the fee terms', () => {
  async function shown(overrides: Record<string, string>) {
    const plan = await planFor(overrides)
    const decoded = decodeFunctionData({ abi: tokenMediatorAbi, data: plan.data }).args as readonly unknown[]
    return { plan, deliveryFee: plan.deliveryFee!, receiver: decoded[1] as `0x${string}`, data: decoded[3] as Hex }
  }
  const relayWith = (built: Awaited<ReturnType<typeof shown>>, deliveryFee = built.deliveryFee, data = built.data) =>
    planRelay({ chain: FIXTURE_PAIR.first, token: usdc, receiver: built.receiver, amount: 100_000_000n, mode: { kind: 'call', data }, deliveryFee })

  test('the data that the form built is accepted', async () => {
    const built = await shown({ callTarget: target, callData: '0xdeadbeef' })
    expect(relayWith(built).data).toBe(built.plan.data)
    expect(decodeDeliveryCall(built.data)).toEqual({ target: target, data: '0xdeadbeef' })
  })

  test('data with a different target than the review shows is refused', async () => {
    const built = await shown({ callTarget: target, callData: '0xdeadbeef' })
    const other = await shown({ callTarget: otherTarget, callData: '0xdeadbeef' })
    expect(() => relayWith(built, built.deliveryFee, other.data)).toThrow('The call data does not hold the fee terms and the call that the review shows.')
  })

  test('data with different call data than the review shows is refused', async () => {
    const built = await shown({ callTarget: target, callData: '0xdeadbeef' })
    const other = await shown({ callTarget: target, callData: '0xdeadbeee' })
    expect(() => relayWith(built, built.deliveryFee, other.data)).toThrow(PlanInputError)
  })

  test('data with a call is refused when the review shows none, and the reverse', async () => {
    const withCall = await shown({ callTarget: target, callData: '0xdeadbeef' })
    const without = await shown({})
    expect(() => relayWith(without, without.deliveryFee, withCall.data)).toThrow(PlanInputError)
    expect(() => relayWith(withCall, withCall.deliveryFee, without.data)).toThrow(PlanInputError)
  })
})
