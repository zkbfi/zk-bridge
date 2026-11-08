import { describe, expect, test } from 'bun:test'
import { buildBridgeSteps, buildMessageSteps, deliveryRouterOf, type BridgeContext } from '../../src/app/actions'
import type { ChainSnapshotResult } from '../../src/chain/live-reads'
import { createFixtureChainAccess } from '../../src/chain/fixture-chain-access'
import { FIXTURE_ACCOUNT, FIXTURE_NOW, FIXTURE_PAIR, FIXTURE_TOKENS, buildFixtureDeliveryCost } from '../../src/data/fixtures'
import { PlanInputError } from '../../src/tx/plan'
import { FIXED_FEE, MAX_CALLBACK_GAS, encodeFeeDirector, routerCallbackGas } from '@zk-bridge/shared'

const usdc = FIXTURE_TOKENS[0]!
const zkUsdc = FIXTURE_TOKENS[1]!
const receiver = '0x00000000000000000000000000000000000000d1'
const values = { token: `first:${usdc.address}`, amount: '100', receiver, mode: 'plain', delivery: 'no' }

async function contextOf(overrides: Partial<BridgeContext> = {}): Promise<BridgeContext> {
  const snapshots = await createFixtureChainAccess(FIXTURE_PAIR).readSnapshots({ account: FIXTURE_ACCOUNT, tokens: FIXTURE_TOKENS })
  return { pair: FIXTURE_PAIR, snapshots, signerAddress: FIXTURE_ACCOUNT, ...overrides }
}

describe('buildBridgeSteps input checks', () => {
  test('refuses to plan when the balances of the chain are not loaded', async () => {
    const context = await contextOf({ snapshots: null })
    expect(() => buildBridgeSteps(values, FIXTURE_TOKENS, context)).toThrow(
      new PlanInputError('The balances of that chain are not loaded. Check the RPC URL and wait for them.'),
    )
  })

  test('refuses to plan when the read of the source chain failed, even if the other chain read well', async () => {
    const loaded = (await contextOf()).snapshots!
    const second = loaded.find((result) => result.status === 'ok' && result.snapshot.chain.side === 'second')!
    const failed: ChainSnapshotResult = { status: 'error', chain: FIXTURE_PAIR.first, message: 'down' }
    const context = await contextOf({ snapshots: [failed, second] })
    expect(() => buildBridgeSteps(values, FIXTURE_TOKENS, context)).toThrow('The balances of that chain are not loaded.')
  })

  test('names the token when the balance row of that token is missing', async () => {
    const loaded = (await contextOf()).snapshots!
    const withoutPositions = loaded.map((result) => (result.status === 'ok' ? { ...result, snapshot: { ...result.snapshot, positions: [] } } : result))
    const context = await contextOf({ snapshots: withoutPositions })
    expect(() => buildBridgeSteps(values, FIXTURE_TOKENS, context)).toThrow(new PlanInputError('The USDC balance is not loaded.'))
  })

  test('says what is wrong with an amount that is not a number', async () => {
    const context = await contextOf()
    expect(() => buildBridgeSteps({ ...values, amount: 'abc' }, FIXTURE_TOKENS, context)).toThrow(new PlanInputError('"abc" is not a decimal number'))
  })

  test('names a mode that the form does not know, so no unknown mode is ever planned', async () => {
    const context = await contextOf()
    expect(() => buildBridgeSteps({ ...values, mode: 'fallback' }, FIXTURE_TOKENS, context)).toThrow(
      new PlanInputError('The mode "fallback" is not known.'),
    )
  })

  test('an error that is not about the text passes through unchanged', async () => {
    const brokenToken = { ...usdc, decimals: 300 }
    const context = await contextOf()
    expect(() => buildBridgeSteps(values, [brokenToken, zkUsdc], context)).toThrow(new RangeError('decimals must be an integer from 0 to 255, got 300'))
  })
})

describe('deliveryRouterOf', () => {
  test('is null when the router field is not an address, so the build of the steps can tell the user', async () => {
    const context = await contextOf({ deliveryCost: buildFixtureDeliveryCost(369, FIXTURE_NOW) })
    const tipValues = { ...values, delivery: 'yes', deliveryRouter: 'not an address' }
    expect(deliveryRouterOf(tipValues, FIXTURE_TOKENS, context)).toBeNull()
    expect(() => buildBridgeSteps(tipValues, FIXTURE_TOKENS, { ...context, tokenValuationsWei: { [zkUsdc.address.toLowerCase()]: 400_000_000_000_000n } })).toThrow(
      PlanInputError,
    )
  })
})

describe('the callback gas of a relay with a call', () => {
  const callValues = { ...values, mode: 'call', data: '0xdeadbeef' }

  test('a receiver that is not a router needs a callback gas, and the plan carries it as the last argument', async () => {
    const context = await contextOf()
    expect(() => buildBridgeSteps(callValues, FIXTURE_TOKENS, context)).toThrow(/Enter the callback gas/)
    const steps = buildBridgeSteps({ ...callValues, callbackGas: ' 350000 ' }, FIXTURE_TOKENS, context)
    expect(steps.at(-1)!.plan.arguments.at(-1)).toMatchObject({ name: 'callbackGas', value: '350000' })
  })

  test('a callback gas that is zero or not a whole number is refused with a sentence', async () => {
    const context = await contextOf()
    for (const callbackGas of ['0', '-1', '1.5', 'abc']) {
      expect(() => buildBridgeSteps({ ...callValues, callbackGas }, FIXTURE_TOKENS, context)).toThrow(new PlanInputError('The callback gas must be a whole number above zero.'))
    }
  })

  /** A direct relay to the delivery router of the deployment, with terms that ask for a call of `callGas`. */
  const routerCallValues = (callGas: bigint) => {
    const router = FIXTURE_PAIR.second.contracts.deliveryRouter!
    const director = { recipient: receiver as `0x${string}`, settings: FIXED_FEE, limit: 1n, multiplier: 0n, callGas }
    const context = { router, protectedAddresses: [], destinationToken: null, destinationWrappedNative: null }
    const data = encodeFeeDirector(director, context, { target: '0x00000000000000000000000000000000000000c1', data: '0x' })
    return { ...values, receiver: router, mode: 'call', data }
  }

  test('a direct relay to the router of the deployment refuses a typed callback gas below what the terms need', async () => {
    const context = await contextOf()
    const needed = routerCallbackGas({ callGas: 200_000n })
    expect(() => buildBridgeSteps({ ...routerCallValues(200_000n), callbackGas: String(needed - 1n) }, FIXTURE_TOKENS, context)).toThrow(
      new PlanInputError(`The callback gas is too low for the router. It needs at least ${needed}: the router's own work and the gas of the call.`),
    )
    const exact = buildBridgeSteps({ ...routerCallValues(200_000n), callbackGas: String(needed) }, FIXTURE_TOKENS, context)
    expect(exact.at(-1)!.plan.arguments.at(-1)).toMatchObject({ name: 'callbackGas', value: String(needed) })
    const derived = buildBridgeSteps(routerCallValues(200_000n), FIXTURE_TOKENS, context)
    expect(derived.at(-1)!.plan.arguments.at(-1)).toMatchObject({ name: 'callbackGas', value: String(needed) })
  })

  test('a callback gas above the most a delivery can carry is refused, for any receiver', async () => {
    const context = await contextOf()
    expect(() => buildBridgeSteps({ ...callValues, callbackGas: String(MAX_CALLBACK_GAS + 1n) }, FIXTURE_TOKENS, context)).toThrow(
      new PlanInputError(`The callback gas is above ${MAX_CALLBACK_GAS}, the most that a delivery can carry.`),
    )
  })

  test('a plain relay has no gas number, and the form values carry none into the plan', async () => {
    const context = await contextOf()
    const steps = buildBridgeSteps({ ...values, callbackGas: '350000' }, FIXTURE_TOKENS, context)
    expect(steps.at(-1)!.plan.arguments.map((argument) => argument.name)).toEqual(['token', 'receiver', 'value'])
  })
})

describe('buildMessageSteps', () => {
  test('sends the message with no gas number: the bridge ignores it', () => {
    const steps = buildMessageSteps({ chain: 'first', target: receiver, data: '0x1234' }, FIXTURE_PAIR)
    expect(steps).toHaveLength(1)
    expect(steps[0]!.plan.arguments.find((argument) => argument.name === 'gas')?.value).toBe('0')
  })
})
