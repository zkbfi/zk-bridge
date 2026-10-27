import { afterEach, describe, expect, test } from 'bun:test'
import { encodeAbiParameters, encodeFunctionData, type Hex } from 'viem'
import { createFixtureChainAccess } from '../../src/chain/fixture-chain-access'
import { FIXTURE_PAIR, FIXTURE_TOKENS } from '../../src/data/fixtures'
import { signerFromPrivateKeyText } from '../../src/signing/key-sources'
import { messageBridgeAbi } from '../../src/tx/abis'
import { lightClientOutputParameters } from '../tx/light-client-output'
import { encodeUpdateCalldata } from '../../src/tx/operator'
import { TEST_KEY, renderApp } from './harness'

type App = Awaited<ReturnType<typeof renderApp>>
let app: App | null = null
afterEach(() => {
  app?.destroy()
  app = null
})

const signer = () => signerFromPrivateKeyText(TEST_KEY)

/** The default tip is gas based and needs a price: one zkbUSDC is worth 4e14 wei. */
const tokenValuationsWei = { [FIXTURE_TOKENS[1]!.address.toLowerCase()]: 400_000_000_000_000n }

async function openAction(target: App, downs: number) {
  for (let step = 0; step < downs; step += 1) await target.press('ARROW_DOWN')
  await target.press('RETURN')
}

describe('confirm before send: bridge tokens', () => {
  test('without a signer the action asks for one and opens nothing', async () => {
    app = await renderApp({ width: 120, height: 40 })
    await openAction(app, 1)
    expect(app.frame()).toContain('Connect a signer first')
    expect(app.frame()).not.toContain('Bridge tokens (')
  })

  test('shows the whole transaction and sends nothing until y; n cancels without sending', async () => {
    const chainAccess = createFixtureChainAccess(FIXTURE_PAIR)
    app = await renderApp({ width: 120, height: 40, initialSigner: signer(), chainAccess, tokenValuationsWei })
    await openAction(app, 1)
    await app.press('TAB')
    await app.type('1')
    await app.press('RETURN')
    await app.settle(80)
    const review = app.frame()
    expect(review).toContain('Step 1 of 2')
    expect(review).toContain('Approve USDC for TokenMediator')
    for (const text of ['Chain', 'Ethereum (chain id 1)', 'Contract', 'Function', 'approve(address,uint256)', 'spender', 'amount', 'Gas', 'estimate 150000, limit 180000', 'Network fee', 'y sign and send']) {
      expect(review).toContain(text)
    }
    expect(chainAccess.sentTransactions).toHaveLength(0)
    await app.press('n')
    expect(app.frame()).not.toContain('Step 1 of 2')
    expect(chainAccess.sentTransactions).toHaveLength(0)
  })

  test('with no price for the default gas tip, Enter shows the reason and opens no review', async () => {
    const chainAccess = createFixtureChainAccess(FIXTURE_PAIR)
    app = await renderApp({ width: 120, height: 40, initialSigner: signer(), chainAccess })
    await openAction(app, 1)
    await app.press('TAB')
    await app.type('1')
    await app.press('RETURN')
    await app.settle(80)
    expect(app.frame()).toContain('enter your price of the native coin in this token')
    expect(app.frame()).not.toContain('Step 1 of')
  })

  test('y signs and sends the approval, then shows the relay for its own confirmation', async () => {
    const chainAccess = createFixtureChainAccess(FIXTURE_PAIR)
    app = await renderApp({ width: 120, height: 40, initialSigner: signer(), chainAccess })
    await openAction(app, 1)
    await app.press('TAB')
    await app.type('1')
    await app.press('TAB') // receiver
    await app.press('TAB') // tip for delivery
    await app.press('ARROW_RIGHT') // no tip: a plain relay
    await app.press('RETURN')
    await app.settle(80)
    await app.press('y')
    await app.settle(150)
    expect(chainAccess.sentTransactions).toHaveLength(1)
    const second = app.frame()
    expect(second).toContain('Step 2 of 2')
    expect(second).toContain('Relay USDC to the other chain')
    expect(second).toContain('relayTokens(address,address,uint256)')
    expect(second).not.toContain('Bridge fee')
    expect(second).not.toContain('taken by the mediator')
    // The relay is not sent before its own confirmation.
    expect(chainAccess.sentTransactions).toHaveLength(1)
    await app.press('y')
    await app.settle(150)
    expect(chainAccess.sentTransactions).toHaveLength(2)
    expect(app.frame()).toContain('All transactions are mined.')
  })

  test('with an allowance in place the relay is the only step', async () => {
    const chainAccess = createFixtureChainAccess(FIXTURE_PAIR, { allowance: 10n ** 30n })
    app = await renderApp({ width: 120, height: 40, initialSigner: signer(), chainAccess })
    await openAction(app, 1)
    await app.press('TAB')
    await app.type('1')
    await app.press('TAB') // receiver
    await app.press('TAB') // tip for delivery
    await app.press('ARROW_RIGHT') // no tip: a plain relay
    await app.press('RETURN')
    await app.settle(80)
    expect(app.frame()).toContain('Relay USDC to the other chain')
    expect(app.frame()).not.toContain('Step 1 of')
  })

  test('the fallback mode shows the five-argument call and no mediator fee', async () => {
    const chainAccess = createFixtureChainAccess(FIXTURE_PAIR, { allowance: 10n ** 30n })
    app = await renderApp({ width: 120, height: 40, initialSigner: signer(), chainAccess })
    await openAction(app, 1)
    await app.press('TAB')
    await app.type('2.5')
    await app.press('TAB') // receiver
    await app.press('TAB') // tip for delivery
    await app.press('ARROW_RIGHT') // no tip: a plain relay
    await app.press('ARROW_UP') // mode, which shows once the tip is off
    await app.press('ARROW_RIGHT') // call
    await app.press('ARROW_RIGHT') // fallback
    await app.press('RETURN')
    await app.settle(80)
    const frame = app.frame()
    expect(frame).toContain('relayTokensWithFallback(address,address,uint256,bytes,address)')
    expect(frame).not.toContain('maxFeeRate')
    expect(frame).not.toContain('Fee rate')
    expect(frame).not.toContain('Bridge fee')
  })

  test('shows input errors on the form and opens no review', async () => {
    const chainAccess = createFixtureChainAccess(FIXTURE_PAIR)
    app = await renderApp({ width: 120, height: 40, initialSigner: signer(), chainAccess })
    await openAction(app, 1)
    await app.press('RETURN')
    expect(app.frame()).toContain('is not a decimal number')
    await app.press('TAB')
    await app.type('999999999')
    await app.press('RETURN')
    expect(app.frame()).toContain('more than your USDC balance')
    expect(app.frame()).not.toContain('Step 1 of')
    expect(chainAccess.sentTransactions).toHaveLength(0)
  })

  test('a failed gas estimate shows the reason and sends nothing', async () => {
    const chainAccess = createFixtureChainAccess(FIXTURE_PAIR, { allowance: 10n ** 30n })
    const failing = { ...chainAccess, flowClient: () => ({ ...chainAccess.flowClient(1), estimateGas: async () => { throw new Error('execution reverted: FeeAboveLimit') } }) }
    app = await renderApp({ width: 120, height: 40, initialSigner: signer(), chainAccess: failing, tokenValuationsWei })
    await openAction(app, 1)
    await app.press('TAB')
    await app.type('1')
    await app.press('RETURN')
    await app.settle(80)
    expect(app.frame()).toContain('FeeAboveLimit')
    expect(chainAccess.sentTransactions).toHaveLength(0)
  })

  test('the review fits an 80 by 24 terminal and scrolls', async () => {
    const chainAccess = createFixtureChainAccess(FIXTURE_PAIR, { allowance: 10n ** 30n })
    app = await renderApp({ width: 80, height: 24, initialSigner: signer(), chainAccess, tokenValuationsWei })
    await openAction(app, 1)
    await app.press('TAB')
    await app.type('1')
    await app.press('RETURN')
    await app.settle(80)
    expect(app.frame()).toContain('Function')
    expect(app.frame()).toContain('y sign and send')
    await app.press('ARROW_DOWN')
    await app.press('ARROW_DOWN')
    expect(app.frame()).toContain('y sign and send')
  })
})

describe('other actions', () => {
  test('send a message reviews requireToPassMessage', async () => {
    const chainAccess = createFixtureChainAccess(FIXTURE_PAIR)
    app = await renderApp({ width: 120, height: 40, initialSigner: signer(), chainAccess })
    await openAction(app, 2)
    await app.press('TAB')
    await app.type('0x0000000000000000000000000000000000000abc')
    await app.press('TAB')
    await app.type('0x1234')
    await app.press('RETURN')
    await app.settle(80)
    expect(app.frame()).toContain('requireToPassMessage(address,bytes,uint256)')
    expect(app.frame()).toContain('MessageBridge')
    expect(chainAccess.sentTransactions).toHaveLength(0)
  })

  test('claim lists the claimable balance and reviews claim(token, account)', async () => {
    const chainAccess = createFixtureChainAccess(FIXTURE_PAIR)
    app = await renderApp({ width: 120, height: 40, initialSigner: signer(), chainAccess })
    await openAction(app, 3)
    expect(app.frame()).toContain('25 USDC on Ethereum')
    await app.press('RETURN')
    await app.settle(80)
    expect(app.frame()).toContain('claim(address,address)')
    expect(chainAccess.sentTransactions).toHaveLength(0)
  })

  test('post update reads a handoff file, checks it against the deployment, and reviews update(bytes,bytes)', async () => {
    const word = (digit: string): Hex => `0x${digit.repeat(64)}`
    const values = encodeAbiParameters(lightClientOutputParameters, [word('a'), word('b'), 100n, word('c'), word('d'), word('e'), 200n, word('f'), 5n, word('9'), word('8')])
    const proof: Hex = `0x${'12'.repeat(40)}`
    const handoff = JSON.stringify({
      schemaVersion: 1,
      route: 'ethereum_to_pulsechain',
      programKey: word('9'),
      startHeadSlot: 100,
      startHeadRoot: word('b'),
      newHeadSlot: 200,
      newHeadRoot: word('e'),
      latestFinalizedSlot: 200,
      publicValues: values,
      proof,
      updateCalldata: encodeUpdateCalldata(proof, values),
      backend: 'remote',
      destination: { chainId: 369, lightClient: FIXTURE_PAIR.second.contracts.lightClient },
      createdAt: '2026-10-24T09:30:00Z',
    })
    const chainAccess = createFixtureChainAccess(FIXTURE_PAIR)
    app = await renderApp({ width: 120, height: 40, initialSigner: signer(), chainAccess, files: { 'handoff.json': handoff } })
    await openAction(app, 4)
    await app.type('handoff.json')
    await app.press('RETURN')
    await app.settle(80)
    expect(app.frame()).toContain('update(bytes,bytes)')
    expect(app.frame()).toContain('PulseChain (chain id 369)')
    expect(app.frame()).toContain('from slot 100 to slot 200')
    expect(chainAccess.sentTransactions).toHaveLength(0)
  })

  test('a handoff for another light client is refused on the form', async () => {
    app = await renderApp({ width: 120, height: 40, initialSigner: signer(), files: { 'bad.json': '{"schemaVersion":1,"destination":{"chainId":369,"lightClient":"0x0000000000000000000000000000000000009999"}}' } })
    await openAction(app, 4)
    await app.type('bad.json')
    await app.press('RETURN')
    await app.settle(60)
    expect(app.frame()).toContain('the deployment says')
  })

  test('execute message reads evidence and offers the prerequisite as a skippable step before the execution', async () => {
    const word = (digit: string): Hex => `0x${digit.repeat(64)}`
    const header = { slot: 5n, proposerIndex: 1n, parentRoot: word('1'), stateRoot: word('2'), bodyRoot: word('3') }
    const executeData = encodeFunctionData({
      abi: messageBridgeAbi,
      functionName: 'executeMessage',
      args: [{ anchorHeader: header, sourceHeader: header, ancestryBranch: [], blockHashBranch: [], executionHeaderRlp: '0x01', receiptProof: [], receiptIndex: 1n, transactionProof: [], transactionIndex: 1n, logIndex: 0n }],
    })
    const bridge = FIXTURE_PAIR.second.contracts.messageBridge
    const evidence = JSON.stringify({
      schemaVersion: 2,
      route: 'ethereum_to_pulsechain',
      sourceTransactionHash: word('a'),
      logIndex: 0,
      message: { messageId: word('c'), sender: FIXTURE_PAIR.first.contracts.messageBridge, executor: bridge, gasLimit: 250000, dataType: 0, data: '0x', sourceBlockNumber: 1, sourceBlockHash: word('d'), sourceSlot: 5 },
      destination: { chainId: 369, bridge, lightClient: FIXTURE_PAIR.second.contracts.lightClient },
      anchor: { slot: 6, root: word('e') },
      deliveryStatus: 'notDelivered',
      alreadyDelivered: false,
      execute: { to: bridge, data: executeData },
      prerequisites: [],
      createdAt: '2026-10-24T09:31:00Z',
    })
    const chainAccess = createFixtureChainAccess(FIXTURE_PAIR)
    app = await renderApp({ width: 120, height: 40, initialSigner: signer(), chainAccess, files: { 'evidence.json': evidence } })
    await openAction(app, 5)
    await app.type('evidence.json')
    await app.press('RETURN')
    await app.settle(80)
    expect(app.frame()).toContain('executeMessage((')
    for (let step = 0; step < 25; step += 1) await app.press('ARROW_DOWN')
    expect(app.frame()).toContain('proof.logIndex')
    expect(chainAccess.sentTransactions).toHaveLength(0)
    await app.press('y')
    await app.settle(150)
    expect(chainAccess.sentTransactions).toHaveLength(1)
  })
})
