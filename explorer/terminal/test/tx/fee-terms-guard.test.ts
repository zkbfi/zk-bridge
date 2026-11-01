import { describe, expect, test } from 'bun:test'
import { decodeFeeDirector, requestedPayoutOf, routerCallbackGas, settingsOf } from '@zk-bridge/shared'
import { decodeKnownCall } from '../../src/tx/decode'
import { buildBridgeSteps } from '../../src/app/actions'
import { createFixtureChainAccess } from '../../src/chain/fixture-chain-access'
import { FIXTURE_ACCOUNT, FIXTURE_PAIR, FIXTURE_TOKENS, buildFixtureDeliveryCost, FIXTURE_NOW } from '../../src/data/fixtures'
import { encodeDirectorFor, feeTermsContextOf, isDeploymentDeliveryRouter, requireValidRouterRelay } from '../../src/tx/fee-terms-guard'
import { PlanInputError } from '../../src/tx/plan'

const usdc = FIXTURE_TOKENS[0]!
const router = FIXTURE_PAIR.second.contracts.deliveryRouter!
const target = { router, destination: FIXTURE_PAIR.second, destinationToken: usdc.counterpart }
const person = '0x00000000000000000000000000000000000000d1'
const word = (address: string) => address.slice(2).toLowerCase().padStart(64, '0')
const directorFor = (recipient: string) => `0x${word(recipient)}${'0'.repeat(63)}8${'0'.repeat(64)}${'0'.repeat(63)}5${'0'.repeat(64)}`
const director = (recipient: string) => ({ recipient: recipient as `0x${string}`, settings: 8n, limit: 0n, multiplier: 5n, callGas: 0n })

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
    await expect(stepsFor({ receiver: router, mode: 'plain' })).rejects.toThrow(/160 byte/)
  })

  test('is refused in the 20 byte legacy shape for a token that is not the wrapped native token', async () => {
    await expect(stepsFor({ receiver: router, mode: 'call', data: person })).rejects.toThrow(/wrapped native token/)
  })

  test('is built in the 20 byte legacy shape for the wrapped native token', async () => {
    const pair = { ...FIXTURE_PAIR, second: { ...FIXTURE_PAIR.second, contracts: { ...FIXTURE_PAIR.second.contracts, wrappedNative: usdc.counterpart! } } }
    const steps = await stepsFor({ receiver: router, mode: 'call', data: person }, pair)
    expect(steps.length).toBeGreaterThan(0)
  })

  test('is refused when the data asks to unwrap a token that is not the wrapped native token', async () => {
    const unwrapping = `0x${word(person)}${'0'.repeat(63)}2${'0'.repeat(64)}${'0'.repeat(64)}${'0'.repeat(64)}`
    await expect(stepsFor({ receiver: router, mode: 'call', data: unwrapping })).rejects.toThrow(/unwrap/)
    await expect(stepsFor({ receiver: router, mode: 'call', data: unwrapping })).rejects.toThrow(PlanInputError)
  })

  test('is built when the data asks to unwrap the wrapped native token', async () => {
    const pair = { ...FIXTURE_PAIR, second: { ...FIXTURE_PAIR.second, contracts: { ...FIXTURE_PAIR.second.contracts, wrappedNative: usdc.counterpart! } } }
    const unwrapping = `0x${word(person)}${'0'.repeat(63)}2${'0'.repeat(64)}${'0'.repeat(64)}${'0'.repeat(64)}`
    const steps = await stepsFor({ receiver: router, mode: 'call', data: unwrapping }, pair)
    expect(steps.length).toBeGreaterThan(0)
  })

  test('is refused for the wrap route with no data', async () => {
    await expect(stepsFor({ token: 'first:native', receiver: router })).rejects.toThrow(/160 byte/)
  })

  test('gets the callback gas that the router needs, worked out from the terms in the data', async () => {
    const steps = await stepsFor({ receiver: router, mode: 'call', data: directorFor(person) })
    expect(decodeKnownCall(steps.at(-1)!.plan.data)?.arguments.at(-1)?.value).toBe(routerCallbackGas({}).toString())
  })

  test('leaves a relay to an ordinary receiver alone, when the callback gas is given', async () => {
    const steps = await stepsFor({ receiver: person, mode: 'call', data: '0x1234', callbackGas: '250000' })
    expect(decodeKnownCall(steps.at(-1)!.plan.data)?.arguments.at(-1)?.value).toBe('250000')
  })

  test('refuses a relay with a call to an ordinary receiver that names no callback gas, because nobody can guess it', async () => {
    await expect(stepsFor({ receiver: person, mode: 'call', data: '0x1234' })).rejects.toThrow(/Enter the callback gas/)
  })

  test('refuses a callback gas that is zero or not a whole number', async () => {
    for (const callbackGas of ['0', '12.5', 'abc']) {
      await expect(stepsFor({ receiver: person, mode: 'call', data: '0x1234', callbackGas })).rejects.toThrow(/whole number above zero/)
    }
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
    expect(() => encodeDirectorFor(director(router), FIXTURE_PAIR, target)).toThrow(PlanInputError)
    expect(decodeFeeDirector(encodeDirectorFor(director(person), FIXTURE_PAIR, target)).multiplier).toBe(5n)
  })

  test('the context lists a router, a mediator and a bridge for each chain that has them', () => {
    expect(feeTermsContextOf(FIXTURE_PAIR, target).protectedAddresses).toHaveLength(6)
  })

  test('the context names the token and the wrapped native token of the destination chain', () => {
    const context = feeTermsContextOf(FIXTURE_PAIR, target)
    expect(context.destinationToken).toBe(usdc.counterpart)
    expect(context.destinationWrappedNative).toBe(FIXTURE_PAIR.second.contracts.wrappedNative)
  })

  test('the context carries the base fee support of the destination chain, and the guard refuses the base fee only flag for none', () => {
    const noBaseFee = { ...FIXTURE_PAIR, second: { ...FIXTURE_PAIR.second, baseFee: 'none' as const } }
    expect(feeTermsContextOf(noBaseFee, { ...target, destination: noBaseFee.second }).destinationBaseFee).toBe('none')
    const gasBased = { ...director(person), settings: settingsOf({ mode: 'gas', gasPrice: 'base-fee-only' }) }
    expect(() => encodeDirectorFor(gasBased, noBaseFee, { ...target, destination: noBaseFee.second })).toThrow(/no base fee/)
    expect(() => encodeDirectorFor(gasBased, FIXTURE_PAIR, target)).not.toThrow()
  })

  test('encodeDirectorFor refuses the unwrap flag for a token that is not the wrapped native token', () => {
    const unwrapping = { ...director(person), settings: settingsOf({ mode: 'share', payout: 'native' }) }
    expect(() => encodeDirectorFor(unwrapping, FIXTURE_PAIR, target)).toThrow(/unwrap/)
    expect(() => encodeDirectorFor(unwrapping, FIXTURE_PAIR, target)).toThrow(PlanInputError)
    expect(() => encodeDirectorFor(unwrapping, FIXTURE_PAIR, { ...target, destinationToken: null })).toThrow(PlanInputError)
  })

  test('encodeDirectorFor keeps the unwrap flag for the wrapped native token', () => {
    const unwrapping = { ...director(person), settings: settingsOf({ mode: 'share', payout: 'native' }) }
    const wrapped = FIXTURE_PAIR.second.contracts.wrappedNative!
    const data = encodeDirectorFor(unwrapping, FIXTURE_PAIR, { ...target, destinationToken: wrapped })
    expect(requestedPayoutOf(decodeFeeDirector(data).settings)).toBe('native')
  })

  test('other errors pass through unchanged', () => {
    expect(() => requireValidRouterRelay({ pair: FIXTURE_PAIR, destination: FIXTURE_PAIR.second, router: '0x12' as `0x${string}`, data: '0x', destinationToken: null })).toThrow(PlanInputError)
    expect(() => encodeDirectorFor({ ...director(person), settings: -1n }, FIXTURE_PAIR, target)).toThrow()
    expect(() => encodeDirectorFor({ ...director(person), settings: -1n }, FIXTURE_PAIR, target)).not.toThrow(PlanInputError)
  })
})
