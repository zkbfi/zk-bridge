/**
 * The deposit gate in the terminal's send flow: the step `confirm(evidence)` goes in before a gated send when the epoch
 * needs it, with the same window, waits, sealed refusal, rollover redo and revert texts as the web page.
 */
import { describe, expect, test } from 'bun:test'
import { beaconForkGateAbi, GateEvidenceError, GATE_BLOCK_SECONDS, type GateCheck, type GateConfirmation } from '@zk-bridge/shared'
import { encodeErrorResult, type Hash, type Hex, type TransactionReceipt } from 'viem'
import { FIXTURE_PAIR, FIXTURE_TOKENS } from '../../src/data/fixtures'
import { createTransactionFlow, type FlowChainClient, type FlowState, type TransactionFlow } from '../../src/flow/transaction-flow'
import { signerFromPrivateKeyText } from '../../src/signing/key-sources'
import { GATE_WAIT_LIMIT } from '../../src/tx/gate-step'
import { planApproval, planRelay, planSendMessage } from '../../src/tx/plan'
import { confirmAnswer, GATE, VALID_UNTIL } from '../support/gate-fixture'

// The first public Anvil development key. It is a published test value.
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const signer = signerFromPrivateKeyText(TEST_KEY)

const chain = FIXTURE_PAIR.first
const usdc = FIXTURE_TOKENS[0]!
const receiver = '0x0000000000000000000000000000000000000abc'
const relayPlan = planRelay({ chain, token: usdc, receiver, amount: 1_000_000n, mode: { kind: 'plain' } })
const approvalPlan = planApproval({ chain, token: usdc, spender: chain.contracts.tokenMediator, spenderLabel: 'TokenMediator', amount: 1_000_000n })
const noGateChain = { ...chain, contracts: { ...chain.contracts, gate: null } }

const EARLY = Number(VALID_UNTIL - 300n) * 1000
const LATE = Number(VALID_UNTIL - 20n) * 1000
const CONFIRMED: GateConfirmation = { kind: 'not-needed', reason: 'confirmed', epoch: 360_335n }

/** The revert data of `ForkNotConfirmed(epoch)`, wrapped like a viem estimate error. */
const forkNotConfirmed = (epoch: bigint) => {
  const data = encodeErrorResult({ abi: beaconForkGateAbi, errorName: 'ForkNotConfirmed', args: [epoch] })
  return Object.assign(new Error('Execution reverted with reason: custom error.'), { cause: { data } })
}

interface ClientScript {
  /** Errors that the send's estimates throw, in order; later estimates succeed. */
  readonly estimateErrors?: unknown[]
  /** Receipt statuses of the sends, in order; later ones succeed. */
  readonly receipts?: ('success' | 'reverted')[]
}

function fakeClient(script: ClientScript = {}) {
  const sent: Hex[] = []
  const log: string[] = []
  const client: FlowChainClient = {
    async estimateGas({ to }) {
      log.push(`estimate ${to.toLowerCase() === GATE.toLowerCase() ? 'gate' : 'send'}`)
      const error = script.estimateErrors?.shift()
      if (error !== undefined) throw error
      return 100_000n
    },
    async getTransactionCount() {
      return sent.length
    },
    async estimateFeesPerGas() {
      return { maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }
    },
    async sendRawTransaction({ serializedTransaction }) {
      sent.push(serializedTransaction)
      log.push('send')
      return `0x${sent.length.toString(16).padStart(64, '0')}` as Hash
    },
    async waitForTransactionReceipt({ hash }) {
      return { status: script.receipts?.shift() ?? 'success', transactionHash: hash } as TransactionReceipt
    },
  }
  return { client, sent, log }
}

/** A gate check that answers from a queue (the last answer repeats) and records its questions. */
function scriptedGate(...answers: (GateConfirmation | Error)[]) {
  const asked: Parameters<GateCheck>[0][] = []
  const check: GateCheck = async (input) => {
    asked.push(input)
    const answer = answers.length > 1 ? answers.shift()! : answers[0]!
    if (answer instanceof Error) throw answer
    return answer
  }
  return { check, asked }
}

function setup(input: { gate?: GateCheck; script?: ClientScript; now?: () => number } = {}) {
  const chainClient = fakeClient(input.script)
  const sleeps: number[] = []
  const flow = createTransactionFlow({
    signer,
    clientFor: () => chainClient.client,
    ...(input.gate === undefined ? {} : { checkGate: input.gate }),
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds)
    },
    now: input.now ?? (() => EARLY),
  })
  return { flow, sleeps, ...chainClient }
}

async function until(flow: TransactionFlow, predicate: (state: FlowState) => boolean): Promise<FlowState> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate(flow.getState())) return flow.getState()
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error(`The flow did not reach the wanted state. It is in phase ${flow.getState().phase}: ${flow.getState().error}`)
}

describe('the gate step goes in before a gated send', () => {
  test('inserts "Confirm this epoch on the gate (epoch N)" with the simulated gas, then the send after it is mined', async () => {
    const gate = scriptedGate(confirmAnswer(), CONFIRMED)
    const { flow, sent, log } = setup({ gate: gate.check })
    flow.start([{ plan: approvalPlan, skippable: false }, { plan: relayPlan, skippable: false }])
    // The approval passes no gate: no question for it.
    await until(flow, (state) => state.phase === 'review' && state.stepIndex === 0)
    expect(gate.asked).toHaveLength(0)
    flow.confirm()
    const confirm = await until(flow, (state) => state.phase === 'review' && state.stepIndex === 1)
    expect(gate.asked).toEqual([{ chainId: chain.chainId, gate: GATE, account: signer.address }])
    expect(confirm.steps.map((step) => step.plan.title)).toEqual([approvalPlan.title, 'Confirm this epoch on the gate (epoch 360335)', relayPlan.title])
    expect(confirm.steps[1]).toMatchObject({ skippable: false, gateConfirm: { epoch: 360_335n, gas: 150_000n, validUntil: VALID_UNTIL } })
    // The review shows the simulation's gas with the usual margin; the node is not asked to estimate the confirmation.
    expect(confirm.prepared?.plan.functionSignature).toBe('confirm(bytes)')
    expect(confirm.prepared?.gasEstimate).toBe(150_000n)
    expect(confirm.prepared?.gasLimit).toBe(180_000n)
    expect(log).toEqual(['estimate send', 'send'])
    flow.confirm()
    const send = await until(flow, (state) => state.phase === 'review' && state.stepIndex === 2)
    expect(send.prepared?.plan).toBe(relayPlan)
    expect(send.outcomes[1]).toMatchObject({ title: 'Confirm this epoch on the gate (epoch 360335)', status: 'success', gateConfirm: true })
    // The send asks the gate again right before its estimate, and the epoch is confirmed now.
    expect(gate.asked).toHaveLength(2)
    flow.confirm()
    const done = await until(flow, (state) => state.phase === 'finished')
    expect(sent).toHaveLength(3)
    expect(done.outcomes.map((outcome) => outcome.status)).toEqual(['success', 'success', 'success'])
  })

  test('inserts nothing when the epoch is confirmed, the gate does not enforce, or the chain has no gate', async () => {
    for (const answer of [CONFIRMED, { kind: 'not-needed', reason: 'not-enforcing', epoch: 1n } satisfies GateConfirmation]) {
      const gate = scriptedGate(answer)
      const { flow } = setup({ gate: gate.check })
      flow.start([{ plan: relayPlan, skippable: false }])
      const state = await until(flow, (current) => current.phase === 'review')
      expect(state.steps).toHaveLength(1)
      expect(gate.asked).toHaveLength(1)
    }
    const gate = scriptedGate(confirmAnswer())
    const { flow } = setup({ gate: gate.check })
    flow.start([{ plan: { ...relayPlan, chain: noGateChain }, skippable: false }])
    const state = await until(flow, (current) => current.phase === 'review')
    expect(state.steps).toHaveLength(1)
    expect(gate.asked).toHaveLength(0)
  })

  test('a message send passes the gate too', async () => {
    const gate = scriptedGate(confirmAnswer())
    const { flow } = setup({ gate: gate.check })
    flow.start([{ plan: planSendMessage({ chain, target: receiver, data: '0x' }), skippable: false }])
    const state = await until(flow, (current) => current.phase === 'review')
    expect(state.steps[0]?.plan.functionName).toBe('confirm')
  })

  test('with no gate check (fixture data), the flow asks nothing', async () => {
    const { flow } = setup()
    flow.start([{ plan: relayPlan, skippable: false }])
    const state = await until(flow, (current) => current.phase === 'review')
    expect(state.steps).toHaveLength(1)
  })
})

describe('waits', () => {
  test('waits a slot while the beacon header of the epoch is not on chain, then asks again', async () => {
    const gate = scriptedGate({ kind: 'wait', epoch: 7n, headerEpoch: 6n, retryAfterSeconds: 12 }, confirmAnswer())
    const { flow, sleeps } = setup({ gate: gate.check })
    const seen: FlowState[] = []
    flow.subscribe(() => seen.push(flow.getState()))
    flow.start([{ plan: relayPlan, skippable: false }])
    const state = await until(flow, (current) => current.phase === 'review')
    expect(sleeps).toEqual([12_000])
    expect(seen.find((current) => current.phase === 'waiting')?.gateWait).toEqual({ chainName: 'Ethereum', epoch: 7n, seconds: 12 })
    expect(state.gateWait).toBeNull()
    expect(state.steps[0]?.gateConfirm?.epoch).toBe(360_335n)
  })

  test('waits for the next epoch and its first block when too little of the epoch is left', async () => {
    let now = LATE
    const gate = scriptedGate(confirmAnswer(), confirmAnswer({ epoch: 360_336n, validUntil: VALID_UNTIL + 384n }))
    const { flow, sleeps } = setup({ gate: gate.check, now: () => now })
    const seen: FlowState[] = []
    flow.subscribe(() => {
      if (flow.getState().phase === 'waiting') now = EARLY + 384_000
      seen.push(flow.getState())
    })
    flow.start([{ plan: relayPlan, skippable: false }])
    const state = await until(flow, (current) => current.phase === 'review')
    expect(sleeps).toEqual([(20 + GATE_BLOCK_SECONDS) * 1000])
    expect(seen.find((current) => current.phase === 'waiting')?.gateWait).toEqual({ chainName: 'Ethereum', epoch: 360_335n, seconds: 32, epochSecondsLeft: 20 })
    expect(state.steps[0]?.plan.title).toBe('Confirm this epoch on the gate (epoch 360336)')
  })

  test('waits on a real timer and reads the real clock by default', async () => {
    const gate = scriptedGate({ kind: 'wait', epoch: 7n, headerEpoch: 6n, retryAfterSeconds: 0 }, CONFIRMED)
    const chainClient = fakeClient()
    const flow = createTransactionFlow({ signer, clientFor: () => chainClient.client, checkGate: gate.check })
    flow.start([{ plan: relayPlan, skippable: false }])
    await until(flow, (current) => current.phase === 'review')
    expect(gate.asked).toHaveLength(2)
  })

  test('gives up after the wait limit, and nothing was sent', async () => {
    const gate = scriptedGate({ kind: 'wait', epoch: 7n, headerEpoch: 6n, retryAfterSeconds: 12 })
    const { flow, sleeps, sent } = setup({ gate: gate.check })
    flow.start([{ plan: relayPlan, skippable: false }])
    const state = await until(flow, (current) => current.phase === 'error')
    expect(sleeps).toHaveLength(GATE_WAIT_LIMIT)
    expect(state.error).toBe(`The beacon header of epoch 7 is not on Ethereum after ${GATE_WAIT_LIMIT} checks 12 seconds apart. Nothing was sent.`)
    expect(sent).toHaveLength(0)
  })

  test('a cancel during a wait drops the later answer', async () => {
    const gate = scriptedGate({ kind: 'wait', epoch: 7n, headerEpoch: 6n, retryAfterSeconds: 12 }, confirmAnswer())
    let release: () => void = () => {}
    const chainClient = fakeClient()
    const flow = createTransactionFlow({
      signer,
      clientFor: () => chainClient.client,
      checkGate: gate.check,
      sleep: () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
      now: () => EARLY,
    })
    flow.start([{ plan: relayPlan, skippable: false }])
    await until(flow, (current) => current.phase === 'waiting')
    flow.cancel()
    expect(flow.getState()).toMatchObject({ phase: 'cancelled', gateWait: null })
    release()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(flow.getState().phase).toBe('cancelled')
    expect(gate.asked).toHaveLength(1)
  })
})

describe('refusals and errors', () => {
  test('a sealed gate stops the send with a sentence, and nothing is sent', async () => {
    const gate = scriptedGate({ kind: 'sealed', epoch: 9n })
    const { flow, sent, log } = setup({ gate: gate.check })
    flow.start([{ plan: relayPlan, skippable: false }])
    const state = await until(flow, (current) => current.phase === 'error')
    expect(state.error).toBe('The Ethereum deposit gate is sealed: it admits no send in epoch 9 or later. Nothing was sent.')
    expect(sent).toHaveLength(0)
    expect(log).toEqual([])
  })

  test('a send paused before a fork stops with the numbers of the pause, and nothing is signed or sent', async () => {
    const fork = { version: '0x90000075', name: 'Fulu', epoch: 500, slot: 16_000, time: Math.floor(Date.now() / 1000) + 600 }
    const gate = scriptedGate({ kind: 'paused', verdict: { kind: 'paused', destinationChainId: 369, fork, pausedSince: fork.time - 3000, lightClientHead: 15_000n, leadSeconds: 3600 } })
    const { flow, sent, log } = setup({ gate: gate.check })
    flow.start([{ plan: relayPlan, skippable: false }])
    const state = await until(flow, (current) => current.phase === 'error')
    expect(state.error).toContain('Sends from Ethereum are paused')
    expect(state.error).toContain('the Fulu fork (epoch 500) starts in')
    expect(state.error).toEndWith('Nothing was sent.')
    expect(sent).toHaveLength(0)
    expect(log).toEqual([])
  })

  test('a check that fails says so, with the retry key when no beacon endpoint answered', async () => {
    const beacon = scriptedGate(new GateEvidenceError('beacon-request-failed', 'no beacon endpoint answered (2 tried; last: the beacon node answered 503 for a proof)'))
    const first = setup({ gate: beacon.check })
    first.flow.start([{ plan: relayPlan, skippable: false }])
    expect((await until(first.flow, (current) => current.phase === 'error')).error).toBe(
      'Could not confirm the Ethereum deposit gate: no beacon endpoint answered (2 tried; last: the beacon node answered 503 for a proof). Press r to try again.',
    )
    const reverted = scriptedGate(new GateEvidenceError('simulation-reverted', 'confirm would revert (simulated at block 5): HeaderNotInCurrentEpoch'))
    const second = setup({ gate: reverted.check })
    second.flow.start([{ plan: relayPlan, skippable: false }])
    expect((await until(second.flow, (current) => current.phase === 'error')).error).toBe(
      'Could not confirm the Ethereum deposit gate: confirm would revert (simulated at block 5): HeaderNotInCurrentEpoch.',
    )
  })

  test('a check that fails after a cancel changes nothing', async () => {
    let reject: (error: Error) => void = () => {}
    const check: GateCheck = () =>
      new Promise((_, fail) => {
        reject = fail
      })
    const { flow } = setup({ gate: check })
    flow.start([{ plan: relayPlan, skippable: false }])
    await until(flow, (current) => current.phase === 'preparing')
    await new Promise((resolve) => setTimeout(resolve, 5))
    flow.cancel()
    reject(new Error('late'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(flow.getState()).toMatchObject({ phase: 'cancelled', error: null })
  })

  test('an answer that comes after a cancel changes nothing', async () => {
    let resolveAnswer: (answer: GateConfirmation) => void = () => {}
    const check: GateCheck = () =>
      new Promise((resolve) => {
        resolveAnswer = resolve
      })
    const { flow } = setup({ gate: check })
    flow.start([{ plan: relayPlan, skippable: false }])
    await new Promise((resolve) => setTimeout(resolve, 5))
    flow.cancel()
    resolveAnswer(confirmAnswer())
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(flow.getState()).toMatchObject({ phase: 'cancelled' })
    expect(flow.getState().steps).toHaveLength(1)
  })

  test('a revert of the estimate reads as a sentence: the decoded gate error', async () => {
    const gate = scriptedGate(CONFIRMED)
    const { flow } = setup({ gate: gate.check, script: { estimateErrors: [forkNotConfirmed(12n), forkNotConfirmed(13n)] } })
    flow.start([{ plan: relayPlan, skippable: false }])
    const state = await until(flow, (current) => current.phase === 'error')
    expect(state.error).toBe(
      'Could not prepare the transaction: The Ethereum deposit gate needs epoch 13 confirmed first. A send in this epoch reverts until one transaction confirms it.',
    )
  })

  test('a plain estimate error keeps the node message', async () => {
    const { flow } = setup({ script: { estimateErrors: [new Error('execution reverted: FeeAboveLimit')] } })
    flow.start([{ plan: relayPlan, skippable: false }])
    expect((await until(flow, (current) => current.phase === 'error')).error).toBe('Could not prepare the transaction: execution reverted: FeeAboveLimit')
  })
})

describe('the epoch rolled over', () => {
  test('a ForkNotConfirmed estimate asks the gate once more, which inserts the confirmation of the new epoch', async () => {
    const gate = scriptedGate(CONFIRMED, confirmAnswer({ epoch: 360_336n, validUntil: VALID_UNTIL + 384n }))
    const { flow } = setup({ gate: gate.check, script: { estimateErrors: [forkNotConfirmed(360_336n)] } })
    flow.start([{ plan: relayPlan, skippable: false }])
    const state = await until(flow, (current) => current.phase === 'review')
    expect(gate.asked).toHaveLength(2)
    expect(state.steps.map((step) => step.plan.title)).toEqual(['Confirm this epoch on the gate (epoch 360336)', relayPlan.title])
  })

  test('a step that passes no gate is not redone on ForkNotConfirmed', async () => {
    const gate = scriptedGate(CONFIRMED)
    const { flow } = setup({ gate: gate.check, script: { estimateErrors: [forkNotConfirmed(1n)] } })
    flow.start([{ plan: approvalPlan, skippable: false }])
    await until(flow, (current) => current.phase === 'error')
    expect(gate.asked).toHaveLength(0)
  })
})

describe('a confirmation that fails', () => {
  test('a reverted confirmation stops with a sentence; retry moves past it and asks the gate again', async () => {
    const gate = scriptedGate(confirmAnswer(), CONFIRMED)
    const { flow, sent } = setup({ gate: gate.check, script: { receipts: ['reverted'] } })
    flow.start([{ plan: relayPlan, skippable: false }])
    await until(flow, (current) => current.phase === 'review')
    flow.confirm()
    const failed = await until(flow, (current) => current.phase === 'error')
    expect(failed.error).toBe(`The confirmation of epoch 360335 reverted in 0x${'1'.padStart(64, '0')}. Nothing else was sent. Press r to check the gate and confirm the current epoch.`)
    expect(failed.outcomes[0]).toMatchObject({ status: 'reverted', gateConfirm: true })
    flow.skip() // A confirmation cannot be skipped.
    expect(flow.getState().stepIndex).toBe(0)
    flow.retry()
    const send = await until(flow, (current) => current.phase === 'review')
    expect(send.stepIndex).toBe(1)
    expect(send.prepared?.plan).toBe(relayPlan)
    expect(sent).toHaveLength(1)
  })

  test('a confirmation that was never sent leaves the list on retry, and the send asks the gate again', async () => {
    const gate = scriptedGate(confirmAnswer(), confirmAnswer({ epoch: 360_336n, validUntil: VALID_UNTIL + 384n }))
    const chainClient = fakeClient()
    const flow = createTransactionFlow({
      signer: { ...signer, signTransaction: async () => Promise.reject(new Error('The user refused on the device.')) },
      clientFor: () => chainClient.client,
      checkGate: gate.check,
      sleep: async () => undefined,
      now: () => EARLY,
    })
    flow.start([{ plan: relayPlan, skippable: false }])
    await until(flow, (current) => current.phase === 'review')
    flow.confirm()
    const failed = await until(flow, (current) => current.phase === 'error')
    expect(failed.error).toBe('Not sent: The user refused on the device.')
    flow.retry()
    const again = await until(flow, (current) => current.phase === 'review')
    expect(again.steps.map((step) => step.plan.title)).toEqual(['Confirm this epoch on the gate (epoch 360336)', relayPlan.title])
    expect(gate.asked).toHaveLength(2)
  })
})
