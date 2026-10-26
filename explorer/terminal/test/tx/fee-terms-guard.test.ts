import { describe, expect, test } from 'bun:test'
import { decodeFeeDirector } from '@zk-bridge/shared'
import { buildBridgeSteps } from '../../src/app/actions'
import { createFixtureChainAccess } from '../../src/chain/fixture-chain-access'
import { FIXTURE_ACCOUNT, FIXTURE_PAIR, FIXTURE_TOKENS, buildFixtureDeliveryCost, FIXTURE_NOW } from '../../src/data/fixtures'
import { encodeDirectorFor, feeTermsContextOf, isDeploymentDeliveryRouter, requireValidRouterRelay } from '../../src/tx/fee-terms-guard'
import { PlanInputError } from '../../src/tx/plan'

const usdc = FIXTURE_TOKENS[0]!
const router = FIXTURE_PAIR.second.contracts.deliveryRouter!
const person = '0x00000000000000000000000000000000000000d1'
const word = (address: string) => address.slice(2).toLowerCase().padStart(64, '0')
const directorFor = (recipient: string) => `0x${word(recipient)}${'0'.repeat(63)}8${'0'.repeat(64)}${'0'.repeat(63)}5`
const director = (recipient: string) => ({ recipient: recipient as `0x${string}`, settings: 8n, limit: 0n, multiplier: 5n })

async function stepsFor(values: Record<string, string>, pair = FIXTURE_PAIR) {
  const snapshots = await createFixtureChainAccess(pair).readSnapshots({ account: FIXTURE_ACCOUNT, tokens: FIXTURE_TOKENS })
  return buildBridgeSteps({ token: `first:${usdc.address}`, amount: '1', delivery: 'no', ...values }, FIXTURE_TOKENS, {
    pair,
    snapshots,
    signerAddress: FIXTURE_ACCOUNT,
    deliveryCost: buildFixtureDeliveryCost(369, FIXTURE_NOW),
  })
}

describe('a hand written relay to a delivery router', () => {
  test('is built when the data is a valid director', async () => {
    const steps = await stepsFor({ receiver: router, mode: 'call', data: directorFor(person) })
    expect(steps.length).toBeGreaterThan(0)
  })

  test('is refused for a recipient that is zero, the router, another delivery router, a mediator or a bridge', async () => {
    const own = FIXTURE_PAIR.first.contracts
    const other = FIXTURE_PAIR.second.contracts
    const refused: readonly [string, RegExp][] = [
      ['0x0000000000000000000000000000000000000000', /zero address/],
      [router, /router itself/],
      [own.tokenMediator, /mediator of/],
      [other.tokenMediator, /mediator of/],
      [own.messageBridge, /bridge of/],
      [other.messageBridge, /bridge of/],
    ]
    for (const [recipient, message] of refused) {
      await expect(stepsFor({ receiver: router, mode: 'call', data: directorFor(recipient) })).rejects.toThrow(message)
    }
  })

  test('is refused for data that is empty, short or long, and for a plain relay to the router', async () => {
    for (const data of ['', '0x1234', `${directorFor(person)}00`]) {
      await expect(stepsFor({ receiver: router, mode: 'call', data })).rejects.toThrow(PlanInputError)
    }
    await expect(stepsFor({ receiver: router, mode: 'plain' })).rejects.toThrow(/128 byte/)
    await expect(stepsFor({ receiver: router, mode: 'fallback', data: '', fallback: person })).rejects.toThrow(/128 byte/)
  })

  test('is refused in the 20 byte legacy shape for a token that is not the wrapped native token', async () => {
    await expect(stepsFor({ receiver: router, mode: 'call', data: person })).rejects.toThrow(/wrapped native token/)
  })

  test('is built in the 20 byte legacy shape for the wrapped native token', async () => {
    const pair = { ...FIXTURE_PAIR, second: { ...FIXTURE_PAIR.second, contracts: { ...FIXTURE_PAIR.second.contracts, wrappedNative: usdc.counterpart! } } }
    const steps = await stepsFor({ receiver: router, mode: 'call', data: person }, pair)
    expect(steps.length).toBeGreaterThan(0)
  })

  test('is refused for the wrap route with no data', async () => {
    await expect(stepsFor({ token: 'first:native', receiver: router })).rejects.toThrow(/128 byte/)
  })

  test('leaves a relay to an ordinary receiver alone', async () => {
    const steps = await stepsFor({ receiver: person, mode: 'call', data: '0x1234' })
    expect(steps.length).toBeGreaterThan(0)
  })
})

describe('a relay that pays for delivery', () => {
  const delivery = { delivery: 'yes', feeMode: 'percentage', feePercent: '0.5', feePriorityGwei: '1', feeMargin: '10', mode: 'plain' }
  const valuations = { [FIXTURE_TOKENS[1]!.address.toLowerCase()]: 400_000_000_000_000n }

  async function deliveryStepsFor(values: Record<string, string>) {
    const snapshots = await createFixtureChainAccess(FIXTURE_PAIR).readSnapshots({ account: FIXTURE_ACCOUNT, tokens: FIXTURE_TOKENS })
    return buildBridgeSteps({ token: `first:${usdc.address}`, amount: '100', ...delivery, ...values }, FIXTURE_TOKENS, {
      pair: FIXTURE_PAIR,
      snapshots,
      signerAddress: FIXTURE_ACCOUNT,
      deliveryCost: buildFixtureDeliveryCost(369, FIXTURE_NOW),
      tokenValuationsWei: valuations,
    })
  }

  test('is built for a person as the recipient', async () => {
    const steps = await deliveryStepsFor({ receiver: person })
    expect(steps.length).toBeGreaterThan(0)
  })

  test('is refused when the recipient is a delivery router, a mediator or a bridge, before any review', async () => {
    for (const recipient of [router, FIXTURE_PAIR.first.contracts.tokenMediator, FIXTURE_PAIR.second.contracts.messageBridge]) {
      await expect(deliveryStepsFor({ receiver: recipient })).rejects.toThrow(PlanInputError)
    }
  })

  test('is refused when the recipient is the zero address', async () => {
    await expect(deliveryStepsFor({ receiver: '0x0000000000000000000000000000000000000000' })).rejects.toThrow(/zero address/)
  })
})

describe('the helpers', () => {
  test('know the delivery routers of the deployment in any letter case', () => {
    expect(isDeploymentDeliveryRouter(FIXTURE_PAIR, router)).toBe(true)
    expect(isDeploymentDeliveryRouter(FIXTURE_PAIR, router.toLowerCase() as `0x${string}`)).toBe(true)
    expect(isDeploymentDeliveryRouter(FIXTURE_PAIR, person)).toBe(false)
  })

  test('encodeDirectorFor reports a refusal as a PlanInputError and keeps a valid encoding', () => {
    expect(() => encodeDirectorFor(director(router), FIXTURE_PAIR, router)).toThrow(PlanInputError)
    expect(decodeFeeDirector(encodeDirectorFor(director(person), FIXTURE_PAIR, router)).multiplier).toBe(5n)
  })

  test('the context lists a router, a mediator and a bridge for each chain that has them', () => {
    expect(feeTermsContextOf(FIXTURE_PAIR, router).protectedAddresses).toHaveLength(5)
  })

  test('other errors pass through unchanged', () => {
    expect(() => requireValidRouterRelay({ pair: FIXTURE_PAIR, destination: FIXTURE_PAIR.second, router: '0x12' as `0x${string}`, data: '0x', destinationToken: null })).toThrow(PlanInputError)
    expect(() => encodeDirectorFor({ ...director(person), settings: -1n }, FIXTURE_PAIR, router)).toThrow()
    expect(() => encodeDirectorFor({ ...director(person), settings: -1n }, FIXTURE_PAIR, router)).not.toThrow(PlanInputError)
  })
})
