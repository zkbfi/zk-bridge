import { describe, expect, test } from 'bun:test'
import { FEE_SETTING, decodeFeeDirector, encodeFeeDirector, maximumFee } from '@zk-bridge/shared'
import { decodeFunctionData, getAddress } from 'viem'
import { buildBridgeSteps, deliveryRouterOf } from '../../src/app/actions'
import type { RouterAddressesReading } from '../../src/chain/live-reads'
import { createFixtureChainAccess } from '../../src/chain/fixture-chain-access'
import { FIXTURE_ACCOUNT, FIXTURE_NOW, FIXTURE_PAIR, FIXTURE_TOKENS, buildFixtureDeliveryCost } from '../../src/data/fixtures'
import { tokenMediatorAbi } from '../../src/tx/abis'
import { PlanInputError, planRelay } from '../../src/tx/plan'
import { reviewLines } from '../../src/ui/review-lines'
import { lineText } from '../../src/ui/rich-text'

const usdc = FIXTURE_TOKENS[0]!
const zkUsdc = FIXTURE_TOKENS[1]!
const receiver = '0x00000000000000000000000000000000000000d1'
const valuations = { [zkUsdc.address.toLowerCase()]: 400_000_000_000_000n }
const values = { token: `first:${usdc.address}`, amount: '100', receiver, mode: 'plain', delivery: 'yes', feeMode: 'percentage', feeMargin: '10', feePriorityGwei: '1' }

async function stepsFor(overrides: Record<string, string>, extra: { pair?: typeof FIXTURE_PAIR; deliveryCost?: ReturnType<typeof buildFixtureDeliveryCost> | null; tokenValuationsWei?: Record<string, bigint>; routerAddresses?: RouterAddressesReading } = {}) {
  const snapshots = await createFixtureChainAccess(FIXTURE_PAIR).readSnapshots({ account: FIXTURE_ACCOUNT, tokens: FIXTURE_TOKENS })
  return buildBridgeSteps({ ...values, ...overrides }, FIXTURE_TOKENS, {
    pair: extra.pair ?? FIXTURE_PAIR,
    snapshots,
    signerAddress: FIXTURE_ACCOUNT,
    deliveryCost: extra.deliveryCost === undefined ? buildFixtureDeliveryCost(369, FIXTURE_NOW) : extra.deliveryCost,
    tokenValuationsWei: extra.tokenValuationsWei ?? valuations,
    ...(extra.routerAddresses === undefined ? {} : { routerAddresses: extra.routerAddresses }),
  })
}

async function relayOf(overrides: Record<string, string>, extra: Parameters<typeof stepsFor>[1] = {}) {
  const steps = await stepsFor(overrides, extra)
  return steps[steps.length - 1]!.plan
}

async function reviewTextOf(plan: Awaited<ReturnType<typeof relayOf>>): Promise<string> {
  return reviewLines({ plan, from: FIXTURE_ACCOUNT, unsigned: { type: 'eip1559', chainId: 1, nonce: 1, to: plan.to, data: plan.data, value: 0n, gas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }, gasEstimate: 1n, gasLimit: 1n, maximumNetworkFee: 1n }, { position: null, calldata: 'summary', wrapWidth: 80 })
    .map(lineText)
    .join('\n')
}

describe('relay that pays for delivery', () => {
  test('the calldata is relayTokensAndCall to the fee router of the other chain with the chosen director as data', async () => {
    const plan = await relayOf({ feeMode: 'percentage', feePercent: '0.5' })
    const decoded = decodeFunctionData({ abi: tokenMediatorAbi, data: plan.data })
    expect(decoded.functionName).toBe('relayTokensAndCall')
    const [token, relayReceiver, amount, data] = decoded.args as [string, string, bigint, `0x${string}`]
    expect(token).toBe(usdc.address)
    expect(relayReceiver).toBe(FIXTURE_PAIR.second.contracts.feeRouter!)
    expect(amount).toBe(100_000_000n)
    expect(decodeFeeDirector(data)).toEqual({ recipient: getAddress(receiver), settings: FEE_SETTING.shareOfValue, limit: 0n, multiplier: 5n * 10n ** 15n })
    expect(plan.deliveryFee?.director).toEqual(decodeFeeDirector(data))
  })

  test('a typed fixed fee and the wrapped native payout are encoded as the flags of the router', async () => {
    const plan = await relayOf({ feeMode: 'fixed', feeFixed: '1.5', feePayout: 'native' })
    const [, , , data] = decodeFunctionData({ abi: tokenMediatorAbi, data: plan.data }).args as [string, string, bigint, `0x${string}`]
    // zkbUSDC is not the wrapped native token of the fixture pair, so the native payout is ignored.
    expect(decodeFeeDirector(data).settings).toBe(FEE_SETTING.fixedFee)
    expect(decodeFeeDirector(data).limit).toBe(1_500_000n)
  })

  test('the fee recipient defaults to the receiver and can be another address', async () => {
    const other = '0x00000000000000000000000000000000000000e5'
    const plan = await relayOf({ feeMode: 'fixed', feeFixed: '1', feeRecipient: other })
    const [, , , data] = decodeFunctionData({ abi: tokenMediatorAbi, data: plan.data }).args as [string, string, bigint, `0x${string}`]
    expect(decodeFeeDirector(data).recipient).toBe(getAddress(other))
  })

  test('the maximum on the review is the most the router can take', async () => {
    // A gas based fee fits only the wrapped native token: WETH bridges to zkbWETH, the wrapped native token of this pair.
    const pair = { ...FIXTURE_PAIR, second: { ...FIXTURE_PAIR.second, contracts: { ...FIXTURE_PAIR.second.contracts, wrappedNative: FIXTURE_TOKENS[3]!.address } } }
    const plan = await relayOf({ token: `first:${FIXTURE_TOKENS[2]!.address}`, feeMode: 'gas', feeMultiplier: '1.2' }, { pair, tokenValuationsWei: {} })
    const review = plan.deliveryFee!
    expect(review.description.certainty).toBe('estimate')
    expect(review.description.maximumUnits).toBe(maximumFee(review.director, 99_900_000_000_000_000_000n))
  })

  test('the confirmation screen states mode, numbers, label, maximum, data source and the router rule', async () => {
    const plan = await relayOf({ feeMode: 'percentage', feePercent: '0.5' })
    const text = reviewLines({ plan, from: FIXTURE_ACCOUNT, unsigned: { type: 'eip1559', chainId: 1, nonce: 1, to: plan.to, data: plan.data, value: 0n, gas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }, gasEstimate: 1n, gasLimit: 1n, maximumNetworkFee: 1n }, { position: null, calldata: 'summary', wrapWidth: 80 })
      .map(lineText)
      .join('\n')
    expect(text).toContain('Tip for delivery')
    expect(text).toContain(`Router        ${FIXTURE_PAIR.second.contracts.feeRouter!} (the fee router of the deployment)`)
    expect(text).toContain('Tip mode      percentage of the transfer')
    expect(text).toContain(`Recipient     ${getAddress(receiver)}`)
    expect(text).toContain('Flags         share of the value')
    expect(text).toContain('Multiplier    0.5% of the transfer')
    expect(text).toContain('Tip now       0.4995 zkbUSDC (exact)')
    expect(text).toContain('Most the tip  0.4995 zkbUSDC')
    expect(text).toContain('Data source   measured from 40 recent deliveries, p90, 210000 gas')
    expect(text).toContain('on PulseChain. The tokens go to')
    expect(text).toContain('The tip goes to the reward address of the fee router, not to the runner account')
    expect(text).toContain('Only the one whitelisted runner account can deliver through the router, and it receives no tip')
    expect(text).not.toContain('pays the tip only to its one whitelisted runner')
    expect(text).toContain('no reward address is recorded, no tip is paid, and the recipient gets everything')
    expect(text).toContain('When the router cannot deliver to the recipient, it hands the tokens to its failed delivery address.')
  })

  test('the confirmation screen shows the two addresses that the router returned, whichever they are', async () => {
    const first = '0x00000000000000000000000000000000000000f1'
    const second = '0x00000000000000000000000000000000000000f2'
    const third = '0x00000000000000000000000000000000000000f3'
    for (const [rewardAddress, failedDeliveryAddress] of [[first, second], [second, third]] as const) {
      const text = await reviewTextOf(await relayOf({}, { routerAddresses: { kind: 'read', rewardAddress, failedDeliveryAddress } }))
      expect(text).toContain(`Tip goes to   ${getAddress(rewardAddress)} (reward address of the router)`)
      expect(text).toMatch(new RegExp(`On failure\\s*the tokens go to ${getAddress(failedDeliveryAddress)} \\(failed delivery address of the router\\)`))
      expect(text).not.toContain('Warning: the router did not return its addresses')
    }
    // A reader who trusts the screen must not see the tip address where the rescued tokens go.
    const swapped = await reviewTextOf(await relayOf({}, { routerAddresses: { kind: 'read', rewardAddress: second, failedDeliveryAddress: third } }))
    expect(swapped).not.toContain(getAddress(first))
    expect(swapped).not.toContain(`the tokens go to ${getAddress(second)}`)
  })

  test('a failed read says so plainly, names no address in either row, and does not block the send', async () => {
    const reason = 'The contract function "failedDeliveryAddress" reverted.'
    const plan = await relayOf({}, { routerAddresses: { kind: 'unreadable', reason } })
    const text = await reviewTextOf(plan)
    expect(text).toContain('Tip goes to   unknown')
    expect(text).toMatch(/On failure\s*unknown/)
    expect(text).toContain('Warning: the router did not return its addresses')
    expect(text).toContain(reason)
    expect(text).toContain('It may be an older router that pays the tip to the runner')
    expect(text).not.toContain('(reward address of the router)')
    expect(text).not.toContain('(failed delivery address of the router)')
    // The plan still exists: the user decides.
    expect(plan.functionName).toBe('relayTokensAndCall')
  })

  test('a build that nobody gave a reading to shows the warning and never an invented address', async () => {
    const text = await reviewTextOf(await relayOf({}))
    expect(text).toContain('Tip goes to   unknown')
    expect(text).toMatch(/On failure\s*unknown/)
    expect(text).toContain('The addresses were not read from the router.')
  })

  test('the router to ask is the router that the form names: the default, or the advanced field', async () => {
    const snapshots = await createFixtureChainAccess(FIXTURE_PAIR).readSnapshots({ account: FIXTURE_ACCOUNT, tokens: FIXTURE_TOKENS })
    const context = { pair: FIXTURE_PAIR, snapshots, signerAddress: FIXTURE_ACCOUNT, deliveryCost: buildFixtureDeliveryCost(369, FIXTURE_NOW), tokenValuationsWei: valuations }
    expect(deliveryRouterOf({ ...values }, FIXTURE_TOKENS, context)).toEqual({ chainId: FIXTURE_PAIR.second.chainId, router: FIXTURE_PAIR.second.contracts.feeRouter! })
    const chosen = '0x00000000000000000000000000000000000000c7'
    expect(deliveryRouterOf({ ...values, feeRouter: chosen }, FIXTURE_TOKENS, context)).toEqual({ chainId: FIXTURE_PAIR.second.chainId, router: getAddress(chosen) })
    expect(deliveryRouterOf({ ...values, delivery: 'no' }, FIXTURE_TOKENS, context)).toBeNull()
    expect(deliveryRouterOf({ ...values, token: 'first:native' }, FIXTURE_TOKENS, context)).toBeNull()
  })

  test('refuses a tip without a loaded report, and sends a plain relay where no tip can travel', async () => {
    await expect(stepsFor({}, { deliveryCost: null })).rejects.toThrow('The delivery cost is not loaded yet')
    // A chain with no fee router in the deployment, and the wrap route, carry no tip. The relay is the plain one.
    const wpls = FIXTURE_TOKENS[4]!
    const withoutRouter = await relayOf({ token: `second:${wpls.address}` })
    expect(withoutRouter.deliveryFee).toBeUndefined()
    expect(withoutRouter.functionName).toBe('relayTokens')
    const wrap = await relayOf({ token: 'first:native', amount: '0.01' })
    expect(wrap.deliveryFee).toBeUndefined()
  })

  test('the tip is 0.1 percent when the percentage is blank: the default, in the share mode', async () => {
    const plan = await relayOf({ feeMode: 'percentage', feePercent: '' })
    const [, , , data] = decodeFunctionData({ abi: tokenMediatorAbi, data: plan.data }).args as [string, string, bigint, `0x${string}`]
    expect(decodeFeeDirector(data)).toEqual({ recipient: getAddress(receiver), settings: FEE_SETTING.shareOfValue, limit: 0n, multiplier: 10n ** 15n })
    expect(plan.deliveryFee?.description.summary).toBe('0.0999 zkbUSDC (exact)')
  })

  test('the router is chosen in the extra data: the relay targets the router of the form, and the review marks it', async () => {
    const chosen = '0x00000000000000000000000000000000000000f7'
    const plan = await relayOf({ feeMode: 'percentage', feePercent: '0.1', feeRouter: chosen })
    const [, relayReceiver] = decodeFunctionData({ abi: tokenMediatorAbi, data: plan.data }).args as [string, string, bigint, `0x${string}`]
    expect(relayReceiver).toBe(getAddress(chosen))
    expect(plan.deliveryFee?.router).toBe(getAddress(chosen))
    expect(plan.deliveryFee?.defaultRouter).toBe(FIXTURE_PAIR.second.contracts.feeRouter!)
    const text = reviewLines({ plan, from: FIXTURE_ACCOUNT, unsigned: { type: 'eip1559', chainId: 1, nonce: 1, to: plan.to, data: plan.data, value: 0n, gas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }, gasEstimate: 1n, gasLimit: 1n, maximumNetworkFee: 1n }, { position: null, calldata: 'summary', wrapWidth: 80 })
      .map(lineText)
      .join('\n')
    expect(text).toContain(`${getAddress(chosen)} (not the fee router of the deployment)`)
    await expect(stepsFor({ feeRouter: 'not an address' })).rejects.toThrow(PlanInputError)
  })

  test('the gas multiplier works for a token that is not the native coin: the sender price is folded into the multiplier', async () => {
    // The sender says one native coin of PulseChain is worth 0.003 zkbUSDC: 3,000 base units for 1e18 wei.
    // multiplier = 3,000 / 1e18 * 1.2 * 1e18 = 3,600.
    const plan = await relayOf({ feeMode: 'gas', feeMultiplier: '1.2', feeSenderPrice: '0.003', feeCeilingGwei: '10' })
    const [, , , data] = decodeFunctionData({ abi: tokenMediatorAbi, data: plan.data }).args as [string, string, bigint, `0x${string}`]
    const director = decodeFeeDirector(data)
    expect(director.multiplier).toBe(3_600n)
    expect(director.settings).toBe(0n)
    // The limit is the fee in token units at the ceiling: (210,000 + 100,000) gas * 3,600 * (10 gwei ceiling + 1 gwei priority fee) / 1e18, rounded up.
    expect(director.limit).toBe((310_000n * 3_600n * 11n * 10n ** 9n + 10n ** 18n - 1n) / 10n ** 18n)
    expect(plan.deliveryFee?.description.certainty).toBe('estimate')
  })

  test('the gas multiplier without a price of the token and without a price from the sender is refused with the reason', async () => {
    await expect(stepsFor({ feeMode: 'gas', feeMultiplier: '1.2' }, { tokenValuationsWei: {} })).rejects.toThrow('enter your price of the native coin in this token')
  })

  test('shows the reason of an invalid fee instead of sending a guess', async () => {
    await expect(stepsFor({ feeMode: 'fixed', feeFixed: 'abc' })).rejects.toThrow(PlanInputError)
    await expect(stepsFor({ feeMode: 'fixed' }, { tokenValuationsWei: {} })).rejects.toThrow('no value of the token is configured')
  })

  test('with No the relay is the plain one: no router, no fee terms', async () => {
    const plan = await relayOf({ delivery: 'no' })
    expect(plan.functionName).toBe('relayTokens')
    expect(plan.deliveryFee).toBeUndefined()
  })
})

describe('planRelay refuses a delivery fee that the data does not carry', () => {
  const director = { recipient: getAddress(receiver), settings: FEE_SETTING.fixedFee, limit: 1n, multiplier: 0n }
  const router = FIXTURE_PAIR.second.contracts.feeRouter!
  const base = { chain: FIXTURE_PAIR.first, token: usdc, amount: 5n, currentFeeRate: 0n }
  const review = { router, defaultRouter: router, routerChainName: 'PulseChain', director, token: { symbol: 'zkbUSDC', decimals: 6 }, description: undefined as never, dataSource: undefined as never, routerAddresses: { kind: 'read' as const, rewardAddress: router, failedDeliveryAddress: router } }

  test('a plain mode, another receiver and other data are each refused', () => {
    expect(() => planRelay({ ...base, receiver: router, mode: { kind: 'plain' }, deliveryFee: review })).toThrow('needs relayTokensAndCall')
    expect(() => planRelay({ ...base, receiver, mode: { kind: 'call', data: encodeFeeDirector(director, { router, protectedAddresses: [] }) }, deliveryFee: review })).toThrow('router of the other chain as the receiver')
    expect(() => planRelay({ ...base, receiver: router, mode: { kind: 'call', data: '0x' }, deliveryFee: review })).toThrow('does not hold the fee terms')
  })
})
