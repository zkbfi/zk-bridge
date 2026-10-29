import { describe, expect, test } from 'bun:test'
import { buildBridgeSteps, deliveryRouterOf, relayGasFactsOf, type BridgeContext } from '../../src/app/actions'
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

describe('relayGasFactsOf', () => {
  const acknowledged = { kind: 'acknowledged' } as const
  const unacknowledged = { kind: 'unacknowledged', nameAndSymbolBytes: 8 } as const
  const copy = { kind: 'copy' } as const

  /** Sets the relay gas of the position of one token on every loaded snapshot of one side. */
  function withRelayGas(snapshots: readonly ChainSnapshotResult[], side: 'first' | 'second', token: string, relayGas: (typeof unacknowledged) | (typeof copy)) {
    return snapshots.map((result) =>
      result.status === 'ok' && result.snapshot.chain.side === side
        ? {
            ...result,
            snapshot: {
              ...result.snapshot,
              positions: result.snapshot.positions.map((position) => (position.token.address === token ? { ...position, relayGas } : position)),
            },
          }
        : result,
    )
  }

  test('the native coin route is a release, the lowest minimum, because it moves no token the mediator must name', async () => {
    const context = await contextOf()
    expect(relayGasFactsOf({ token: 'first:native' }, FIXTURE_TOKENS, context)).toEqual(acknowledged)
  })

  test('a token with no loaded snapshot for its side is a release, so the form never invents a higher minimum', async () => {
    const loaded = (await contextOf()).snapshots!
    const onlySecond = loaded.filter((result) => result.status === 'ok' && result.snapshot.chain.side === 'second')
    const context = await contextOf({ snapshots: onlySecond })
    expect(relayGasFactsOf(values, FIXTURE_TOKENS, context)).toEqual(acknowledged)
    expect(relayGasFactsOf(values, FIXTURE_TOKENS, await contextOf({ snapshots: null }))).toEqual(acknowledged)
  })

  test('a snapshot with a status other than ok is a release, because a failed read carries no facts to trust', async () => {
    const loaded = (await contextOf()).snapshots!
    const marked = withRelayGas(loaded, 'first', usdc.address, copy)
    const second = marked.filter((result) => result.status === 'ok' && result.snapshot.chain.side === 'second')
    const failed: ChainSnapshotResult = { status: 'error', chain: FIXTURE_PAIR.first, message: 'down' }
    const context = await contextOf({ snapshots: [failed, ...second] })
    expect(relayGasFactsOf(values, FIXTURE_TOKENS, context)).toEqual(acknowledged)
  })

  test('a loaded snapshot without a position for the token is a release, because nothing was read for that token', async () => {
    const loaded = (await contextOf()).snapshots!
    const withoutPositions = loaded.map((result) => (result.status === 'ok' ? { ...result, snapshot: { ...result.snapshot, positions: [] } } : result))
    const context = await contextOf({ snapshots: withoutPositions })
    expect(relayGasFactsOf(values, FIXTURE_TOKENS, context)).toEqual(acknowledged)
  })

  test('a loaded position gives its own relay gas, so the minimum of the gas limit follows what the mediator said', async () => {
    const loaded = (await contextOf()).snapshots!
    const unnamed = await contextOf({ snapshots: withRelayGas(loaded, 'first', usdc.address, unacknowledged) })
    expect(relayGasFactsOf(values, FIXTURE_TOKENS, unnamed)).toEqual(unacknowledged)
    const copied = await contextOf({ snapshots: withRelayGas(loaded, 'first', usdc.address, copy) })
    expect(relayGasFactsOf(values, FIXTURE_TOKENS, copied)).toEqual(copy)
  })

  test('the snapshot of the other side is not used, because the same facts on the wrong chain would set the wrong minimum', async () => {
    const loaded = (await contextOf()).snapshots!
    const otherSideOnly = withRelayGas(loaded, 'second', zkUsdc.address, copy)
    const context = await contextOf({ snapshots: otherSideOnly })
    expect(relayGasFactsOf(values, FIXTURE_TOKENS, context)).toEqual(acknowledged)
    const own = withRelayGas(otherSideOnly, 'first', usdc.address, unacknowledged)
    expect(relayGasFactsOf(values, FIXTURE_TOKENS, await contextOf({ snapshots: own }))).toEqual(unacknowledged)
  })
})
