import { afterEach, describe, expect, test } from 'bun:test'
import { getAddress } from 'viem'
import { createFixtureChainAccess } from '../../src/chain/fixture-chain-access'
import { FIXTURE_PAIR, FIXTURE_TOKENS } from '../../src/data/fixtures'
import { signerFromPrivateKeyText } from '../../src/signing/key-sources'
import { TEST_KEY, renderApp } from './harness'

type App = Awaited<ReturnType<typeof renderApp>>
let app: App | null = null
afterEach(() => {
  app?.destroy()
  app = null
})

const zkUsdc = FIXTURE_TOKENS[1]!
const priced = { [zkUsdc.address.toLowerCase()]: 400_000_000_000_000n }

/** Opens the bridge form, types an amount and moves to the tip field. */
async function openOnTipField(options: { pair?: typeof FIXTURE_PAIR; token?: 'next'; tokenValuationsWei?: Record<string, bigint>; chainAccess?: ReturnType<typeof createFixtureChainAccess> } = {}) {
  app = await renderApp({
    width: 130,
    height: 46,
    initialSigner: signerFromPrivateKeyText(TEST_KEY),
    ...(options.chainAccess === undefined ? {} : { chainAccess: options.chainAccess }),
    ...(options.pair === undefined ? {} : { pair: options.pair }),
    ...(options.tokenValuationsWei === undefined ? {} : { tokenValuationsWei: options.tokenValuationsWei }),
  })
  await app.press('ARROW_DOWN')
  await app.press('RETURN')
  if (options.token === 'next') await app.press('ARROW_RIGHT')
  await app.press('TAB')
  await app.type('100')
  await app.press('TAB') // receiver
  await app.press('TAB') // tip for delivery (the mode field is hidden while the tip is on)
  await app.settle(100)
  return app
}

describe('the tip field of the bridge form', () => {
  test('is on by default at 0.1 percent, with the fee fields, the router field and the live panel shown', async () => {
    const screen = await openOnTipField({ tokenValuationsWei: priced })
    const frame = screen.frame()
    for (const shown of ['Tip for delivery', 'Yes, 0.1% by default', 'Tip mode', 'Percentage of the transfer', 'Percentage', '0.1', 'Router (advanced)', 'Fee recipient', 'Margin percent', 'Priority fee gwei', 'Delivery cost on PulseChain', 'Router          0x', '(the fee router of the deployment)', 'measured from 40 recent deliveries, p90', 'Base fee', 'at block 21000000', 'Your tip        0.0999 zkbUSDC (exact)']) {
      expect(frame).toContain(shown)
    }
    // The Mode field (relayTokens) is gone: the call data holds the tip terms.
    expect(frame).not.toMatch(/Mode {2,}relayTokens/)
  })

  test('can be removed: No tip hides the tip fields and shows the plain relay mode', async () => {
    const screen = await openOnTipField({ tokenValuationsWei: priced })
    await screen.press('ARROW_RIGHT')
    await screen.settle(100)
    const frame = screen.frame()
    expect(frame).toContain('< No tip >')
    for (const hidden of ['Tip mode', 'Router (advanced)', 'Fee recipient', 'Margin percent', 'Delivery cost on']) expect(frame).not.toContain(hidden)
    expect(frame).toContain('Mode ')
  })

  test('choosing the fixed mode fills the fixed amount with the suggestion, and editing it rebuilds the tip', async () => {
    const screen = await openOnTipField({ tokenValuationsWei: priced })
    await screen.press('TAB') // tip mode
    await screen.press('ARROW_RIGHT') // fixed
    expect(screen.frame()).toMatch(/Fixed amount {2,}4\.642/)
    await screen.press('TAB') // the fixed amount
    await screen.press('BACKSPACE')
    await screen.type('9')
    const frame = screen.frame()
    expect(frame).toMatch(/Fixed amount {2,}4\.649/)
    expect(frame).toContain('Your tip        4.649 zkbUSDC (exact)')
  })

  test('the gas multiplier works for any token, with the price of the sender labelled as theirs', async () => {
    const screen = await openOnTipField({ tokenValuationsWei: priced })
    await screen.press('TAB') // tip mode
    await screen.press('ARROW_RIGHT') // fixed
    await screen.press('ARROW_RIGHT') // gas
    await screen.settle(50)
    const frame = screen.frame()
    expect(frame).toContain('Your coin price')
    expect(frame).toMatch(/Your coin price {2,}2500/)
    expect(frame).toMatch(/estimate, at most [\d.]+ zkbUSDC/)
    expect(frame).toMatch(/Your tip {8}about [\d.]+ zkbUSDC now/)
  })

  test('on the wrapped native token the gas multiplier offers the native payout', async () => {
    const pair = { ...FIXTURE_PAIR, second: { ...FIXTURE_PAIR.second, contracts: { ...FIXTURE_PAIR.second.contracts, wrappedNative: FIXTURE_TOKENS[3]!.address } } }
    const screen = await openOnTipField({ pair, token: 'next' })
    await screen.press('TAB') // tip mode
    await screen.press('ARROW_RIGHT') // fixed
    await screen.press('ARROW_RIGHT') // gas
    await screen.settle(50)
    const frame = screen.frame()
    expect(frame).toContain('WETH on Ethereum')
    expect(frame).toContain('Pay the reward address in')
    expect(frame).toMatch(/estimate, at most [\d.]+ zkbWETH/)
  })

  test('says that no value is known when the destination token has none, and the default tip stays', async () => {
    const screen = await openOnTipField()
    const frame = screen.frame()
    expect(frame).toContain('unavailable: no value of the token is configured')
    expect(frame).toContain('Your tip        0.0999 zkbUSDC (exact)')
  })

  test('Enter reviews relayTokensAndCall to the router with the tip terms, and sends nothing', async () => {
    const chainAccess = createFixtureChainAccess(FIXTURE_PAIR, { allowance: 10n ** 30n })
    const screen = await openOnTipField({ tokenValuationsWei: priced, chainAccess })
    await screen.press('RETURN')
    await screen.settle(120)
    const frame = screen.frame()
    for (const shown of ['relayTokensAndCall(address,address,uint256,bytes)', 'Tip for delivery', 'Router', '(the fee router of the deployment)', 'Tip mode', 'percentage of the transfer', 'Tip goes to', 'On failure']) {
      expect(frame).toContain(shown)
    }
    expect(chainAccess.sentTransactions).toHaveLength(0)
  })

  test('Enter reads both addresses from the router and the review shows them; a second pair proves they are read', async () => {
    const pairs = [
      ['0x00000000000000000000000000000000000000f1', '0x00000000000000000000000000000000000000f3'],
      ['0x00000000000000000000000000000000000000f2', '0x00000000000000000000000000000000000000f4'],
    ] as const
    for (const [rewardAddress, failedDeliveryAddress] of pairs) {
      const chainAccess = createFixtureChainAccess(FIXTURE_PAIR, { allowance: 10n ** 30n, routerAddresses: { kind: 'read', rewardAddress, failedDeliveryAddress } })
      const screen = await openOnTipField({ tokenValuationsWei: priced, chainAccess })
      await screen.press('RETURN')
      await screen.settle(120)
      const frame = screen.frame()
      expect(frame).toContain('Tip goes to')
      expect(frame).toContain(getAddress(rewardAddress))
      expect(frame).toContain('On failure')
      expect(frame).toContain(getAddress(failedDeliveryAddress))
      expect(frame).not.toContain('did not return its addresses')
      screen.destroy()
      app = null
    }
  })

  test('Enter with a router that does not answer still opens the review, with the warning and no address', async () => {
    const chainAccess = createFixtureChainAccess(FIXTURE_PAIR, { allowance: 10n ** 30n, routerAddresses: { kind: 'unreadable', reason: 'execution reverted' } })
    const screen = await openOnTipField({ tokenValuationsWei: priced, chainAccess })
    await screen.press('RETURN')
    await screen.settle(120)
    const frame = screen.frame()
    expect(frame).toContain('relayTokensAndCall(address,address,uint256,bytes)')
    expect(frame).toContain('Tip goes to   unknown')
    expect(frame).toMatch(/On failure\s*unknown/)
    expect(frame).toContain('Warning: the router did not return its addresses (execution reverted).')
  })

  test('is not offered when the deployment has no fee router for the destination, and the form says why', async () => {
    const screen = await openOnTipField({ tokenValuationsWei: priced })
    // Back to the token field, then to zkbUSDC on PulseChain: its destination is Ethereum, which has no fee router.
    for (let step = 0; step < 3; step += 1) await screen.press('ARROW_UP') // receiver, amount, token
    for (let step = 0; step < 4; step += 1) await screen.press('ARROW_RIGHT')
    const frame = screen.frame()
    expect(frame).toContain('zkbUSDC on PulseChain')
    expect(frame).not.toContain('Tip for delivery')
    expect(frame).toContain('The deployment names no fee router for Ethereum')
  })
})
