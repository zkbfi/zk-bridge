import { describe, expect, test } from 'bun:test'
import { buildBridgeSteps, buildClaimSteps, claimableEntries, deliveryRouterOf, type BridgeContext } from '../../src/app/actions'
import type { ChainSnapshotResult } from '../../src/chain/live-reads'
import { createFixtureChainAccess } from '../../src/chain/fixture-chain-access'
import { FIXTURE_ACCOUNT, FIXTURE_NOW, FIXTURE_PAIR, FIXTURE_TOKENS, buildFixtureDeliveryCost } from '../../src/data/fixtures'
import { PlanInputError } from '../../src/tx/plan'

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

describe('claims', () => {
  test('lists only the non-zero claimable balances of the chains that were read', async () => {
    const loaded = (await contextOf()).snapshots!
    const first = loaded.find((result) => result.status === 'ok' && result.snapshot.chain.side === 'first')!
    if (first.status !== 'ok') throw new Error('the first chain reads')
    const claimable = { ...first.snapshot.positions[0]!, claimable: 7n }
    const idle = { ...first.snapshot.positions[1]!, claimable: 0n }
    const withClaim: ChainSnapshotResult = { status: 'ok', snapshot: { ...first.snapshot, positions: [claimable, idle] } }
    const failed: ChainSnapshotResult = { status: 'error', chain: FIXTURE_PAIR.second, message: 'down' }
    expect(claimableEntries([withClaim, failed])).toEqual([{ side: 'first', position: claimable }])
    expect(claimableEntries(null)).toEqual([])
  })

  test('the claim step names the chain of the entry and the exact amount', () => {
    const position = { token: zkUsdc, balance: 0n, allowance: 0n, claimable: 42n }
    const [step] = buildClaimSteps({ side: 'second', position }, FIXTURE_PAIR, FIXTURE_ACCOUNT)
    expect(step?.plan.chain.chainId).toBe(FIXTURE_PAIR.second.chainId)
    expect(step?.plan.functionName).toBe('claim')
    expect(step?.skippable).toBe(false)
  })
})
