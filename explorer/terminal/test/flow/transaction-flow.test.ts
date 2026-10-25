import { describe, expect, test } from 'bun:test'
import type { Hash, Hex, TransactionReceipt, TransactionSerializableEIP1559 } from 'viem'
import { FIXTURE_PAIR, FIXTURE_TOKENS } from '../../src/data/fixtures'
import {
  createTransactionFlow,
  type FlowChainClient,
  type FlowState,
  type TransactionFlow,
} from '../../src/flow/transaction-flow'
import { signerFromPrivateKeyText } from '../../src/signing/key-sources'
import type { Signer } from '../../src/signing/signer'
import { planApproval, planRelay } from '../../src/tx/plan'

// The first public Anvil development key. It is a published test value.
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const OTHER_TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'

const chain = FIXTURE_PAIR.first
const usdc = FIXTURE_TOKENS[0]!
const receiver = '0x0000000000000000000000000000000000000abc'

const relayPlan = planRelay({ chain, token: usdc, receiver, amount: 1_000_000n, mode: { kind: 'plain' }, currentFeeRate: 10n ** 15n })
const approvalPlan = planApproval({ chain, token: usdc, spender: chain.contracts.tokenMediator, spenderLabel: 'TokenMediator', amount: 1_000_000n })

interface FakeClientOptions {
  readonly estimateFails?: boolean
  readonly receiptStatus?: 'success' | 'reverted'
}

function fakeClient(options: FakeClientOptions = {}) {
  const sent: Hex[] = []
  const log: string[] = []
  const client: FlowChainClient = {
    async estimateGas() {
      log.push('estimate')
      if (options.estimateFails === true) throw new Error('execution reverted: FeeAboveLimit')
      return 100_000n
    },
    async getTransactionCount() {
      return sent.length + 3
    },
    async estimateFeesPerGas() {
      return { maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }
    },
    async sendRawTransaction({ serializedTransaction }) {
      log.push('send')
      sent.push(serializedTransaction)
      return `0x${sent.length.toString(16).padStart(64, '0')}` as Hash
    },
    async waitForTransactionReceipt({ hash }) {
      return { status: options.receiptStatus ?? 'success', gasUsed: 90_000n, blockNumber: 5n, transactionHash: hash } as TransactionReceipt
    },
  }
  return { client, sent, log }
}

/** Counts how often the signer is asked. */
function countingSigner(base: Signer): { signer: Signer; calls: () => number } {
  let count = 0
  return {
    signer: {
      ...base,
      async signTransaction(transaction: TransactionSerializableEIP1559, options) {
        count += 1
        return base.signTransaction(transaction, options)
      },
    },
    calls: () => count,
  }
}

async function until(flow: TransactionFlow, predicate: (state: FlowState) => boolean): Promise<FlowState> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate(flow.getState())) return flow.getState()
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error(`The flow did not reach the wanted state. It is in phase ${flow.getState().phase}.`)
}

function setup(options: FakeClientOptions = {}, signerOverride?: Signer) {
  const chainClient = fakeClient(options)
  const signed = countingSigner(signerOverride ?? signerFromPrivateKeyText(TEST_KEY))
  const flow = createTransactionFlow({ signer: signed.signer, clientFor: () => chainClient.client })
  return { flow, ...chainClient, signCalls: signed.calls, signer: signed.signer }
}

describe('confirm before send', () => {
  test('stops at the review: nothing is signed or sent until the user confirms', async () => {
    const { flow, sent, signCalls } = setup()
    flow.start([{ plan: relayPlan, skippable: false }])
    const state = await until(flow, (current) => current.phase === 'review')
    expect(state.prepared?.plan).toBe(relayPlan)
    // Let any stray asynchronous work run. A flow that sends early would have sent by now.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(sent).toHaveLength(0)
    expect(signCalls()).toBe(0)
    expect(flow.getState().phase).toBe('review')
  })

  test('the prepared transaction holds the nonce, the gas with margin and the fee cap', async () => {
    const { flow } = setup()
    flow.start([{ plan: relayPlan, skippable: false }])
    const { prepared } = await until(flow, (current) => current.phase === 'review')
    expect(prepared?.gasEstimate).toBe(100_000n)
    expect(prepared?.gasLimit).toBe(120_000n)
    expect(prepared?.unsigned.nonce).toBe(3)
    expect(prepared?.maximumNetworkFee).toBe(120_000n * 30_000_000_000n)
    expect(prepared?.unsigned.to).toBe(chain.contracts.tokenMediator)
    expect(prepared?.unsigned.chainId).toBe(1)
  })

  test('cancel at the review sends nothing and signs nothing', async () => {
    const { flow, sent, signCalls } = setup()
    flow.start([{ plan: relayPlan, skippable: false }])
    await until(flow, (current) => current.phase === 'review')
    flow.cancel()
    expect(flow.getState().phase).toBe('cancelled')
    flow.confirm()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(flow.getState().phase).toBe('cancelled')
    expect(sent).toHaveLength(0)
    expect(signCalls()).toBe(0)
  })

  test('confirm outside the review does nothing', async () => {
    const { flow, sent, signCalls } = setup()
    flow.confirm()
    expect(flow.getState().phase).toBe('idle')
    flow.start([{ plan: relayPlan, skippable: false }])
    flow.confirm() // still preparing
    await until(flow, (current) => current.phase === 'review')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sent).toHaveLength(0)
    expect(signCalls()).toBe(0)
  })

  test('confirm signs once, sends once and finishes; a second confirm does not send twice', async () => {
    const { flow, sent, signCalls } = setup()
    flow.start([{ plan: relayPlan, skippable: false }])
    await until(flow, (current) => current.phase === 'review')
    flow.confirm()
    flow.confirm()
    const done = await until(flow, (current) => current.phase === 'finished')
    expect(sent).toHaveLength(1)
    expect(signCalls()).toBe(1)
    expect(done.outcomes).toEqual([{ title: relayPlan.title, status: 'success', transactionHash: `0x${'1'.padStart(64, '0')}` }])
  })

  test('a sequence asks for a new confirmation before every transaction', async () => {
    const { flow, sent, log } = setup()
    flow.start([
      { plan: approvalPlan, skippable: false },
      { plan: relayPlan, skippable: false },
    ])
    const first = await until(flow, (current) => current.phase === 'review')
    expect(first.stepIndex).toBe(0)
    flow.confirm()
    const second = await until(flow, (current) => current.phase === 'review' && current.stepIndex === 1)
    expect(second.prepared?.plan).toBe(relayPlan)
    // The second transaction is estimated only after the first one is mined, and is not sent before its own confirm.
    expect(sent).toHaveLength(1)
    expect(log).toEqual(['estimate', 'send', 'estimate'])
    flow.confirm()
    await until(flow, (current) => current.phase === 'finished')
    expect(sent).toHaveLength(2)
  })

  test('the signer shows its prompt in the state while the device waits', async () => {
    const base = signerFromPrivateKeyText(TEST_KEY)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow: Signer = {
      ...base,
      async signTransaction(transaction, options) {
        options?.onDevicePrompt?.('Approve on the device')
        await gate
        return base.signTransaction(transaction)
      },
    }
    const { flow } = setup({}, slow)
    flow.start([{ plan: relayPlan, skippable: false }])
    await until(flow, (current) => current.phase === 'review')
    flow.confirm()
    const waiting = await until(flow, (current) => current.devicePrompt !== null)
    expect(waiting.phase).toBe('signing')
    expect(waiting.devicePrompt).toBe('Approve on the device')
    release()
    await until(flow, (current) => current.phase === 'finished')
  })
})

describe('failures stop before the network', () => {
  test('a failed estimate shows the reason, signs nothing, and a retry prepares again', async () => {
    const { flow, sent, signCalls } = setup({ estimateFails: true })
    flow.start([{ plan: relayPlan, skippable: false }])
    const failed = await until(flow, (current) => current.phase === 'error')
    expect(failed.error).toContain('FeeAboveLimit')
    expect(sent).toHaveLength(0)
    expect(signCalls()).toBe(0)
    flow.retry()
    await until(flow, (current) => current.phase === 'error')
  })

  test('a signature from another account is refused and never sent', async () => {
    const wrongSigner: Signer = { ...signerFromPrivateKeyText(OTHER_TEST_KEY), address: signerFromPrivateKeyText(TEST_KEY).address }
    const { flow, sent } = setup({}, wrongSigner)
    flow.start([{ plan: relayPlan, skippable: false }])
    await until(flow, (current) => current.phase === 'review')
    flow.confirm()
    const failed = await until(flow, (current) => current.phase === 'error')
    expect(failed.error).toContain('Not sent')
    expect(failed.error).toContain('signature is from')
    expect(sent).toHaveLength(0)
  })

  test('a device that returns a signature for other content is refused and never sent', async () => {
    const base = signerFromPrivateKeyText(TEST_KEY)
    const tampering: Signer = {
      ...base,
      signTransaction: (transaction) => base.signTransaction({ ...transaction, value: transaction.value! + 1n }),
    }
    const { flow, sent } = setup({}, tampering)
    flow.start([{ plan: relayPlan, skippable: false }])
    await until(flow, (current) => current.phase === 'review')
    flow.confirm()
    const failed = await until(flow, (current) => current.phase === 'error')
    expect(failed.error).toContain('differs from the one shown')
    expect(sent).toHaveLength(0)
  })

  test('a rejection on the device ends in an error and sends nothing', async () => {
    const base = signerFromPrivateKeyText(TEST_KEY)
    const rejecting: Signer = {
      ...base,
      async signTransaction() {
        throw new Error('You rejected the request on the device. Nothing was signed.')
      },
    }
    const { flow, sent } = setup({}, rejecting)
    flow.start([{ plan: relayPlan, skippable: false }])
    await until(flow, (current) => current.phase === 'review')
    flow.confirm()
    const failed = await until(flow, (current) => current.phase === 'error')
    expect(failed.error).toContain('rejected')
    expect(sent).toHaveLength(0)
  })

  test('a reverted transaction is reported with its hash and stops the sequence', async () => {
    const { flow, sent } = setup({ receiptStatus: 'reverted' })
    flow.start([
      { plan: approvalPlan, skippable: false },
      { plan: relayPlan, skippable: false },
    ])
    await until(flow, (current) => current.phase === 'review')
    flow.confirm()
    const failed = await until(flow, (current) => current.phase === 'error')
    expect(failed.error).toContain('reverted')
    expect(failed.outcomes[0]?.status).toBe('reverted')
    expect(sent).toHaveLength(1)
  })
})

describe('skip, cancel and stale work', () => {
  test('skip moves past a skippable step without sending it, and refuses a step that is not skippable', async () => {
    const { flow, sent } = setup()
    flow.start([
      { plan: approvalPlan, skippable: true },
      { plan: relayPlan, skippable: false },
    ])
    await until(flow, (current) => current.phase === 'review')
    flow.skip()
    const second = await until(flow, (current) => current.phase === 'review' && current.stepIndex === 1)
    expect(second.outcomes[0]?.status).toBe('skipped')
    flow.skip() // the relay is not skippable
    expect(flow.getState().stepIndex).toBe(1)
    expect(sent).toHaveLength(0)
  })

  test('a preparation that finishes after cancel does not bring the review back', async () => {
    const slow = fakeClient()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const client: FlowChainClient = {
      ...slow.client,
      async estimateGas(parameters) {
        await gate
        return slow.client.estimateGas(parameters)
      },
    }
    const flow = createTransactionFlow({ signer: signerFromPrivateKeyText(TEST_KEY), clientFor: () => client })
    flow.start([{ plan: relayPlan, skippable: false }])
    flow.cancel()
    release()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(flow.getState().phase).toBe('cancelled')
    expect(slow.sent).toHaveLength(0)
  })

  test('subscribers hear every change and can unsubscribe', async () => {
    const { flow } = setup()
    const phases: string[] = []
    const unsubscribe = flow.subscribe(() => phases.push(flow.getState().phase))
    flow.start([{ plan: relayPlan, skippable: false }])
    await until(flow, (current) => current.phase === 'review')
    unsubscribe()
    flow.cancel()
    expect(phases).toEqual(['preparing', 'preparing', 'review'])
  })
})
