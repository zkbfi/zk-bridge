import { describe, expect, test } from 'bun:test'
import { GATE_BLOCK_SECONDS, GATE_SAFETY_SECONDS, GateEvidenceError, type GateConfirmation } from '@zk-bridge/shared'
import { getAddress } from 'viem'
import { FIXTURE_PAIR, FIXTURE_TOKENS } from '../../src/data/fixtures'
import { confirmAnswer, EVIDENCE, GATE, VALID_UNTIL } from '../support/gate-fixture'
import { decideGateStep, GATE_WAIT_LIMIT, gateErrorText, passesGate, planGateConfirm, withKnownGas } from '../../src/tx/gate-step'
import { planApproval, planRelay, planSendMessage, planWrapAndRelay, type PlannedTransaction } from '../../src/tx/plan'

const chain = FIXTURE_PAIR.first
const gate = GATE
const evidence = EVIDENCE

const receiver = '0x0000000000000000000000000000000000000abc'
const usdc = FIXTURE_TOKENS[0]!

describe('passesGate', () => {
  test('counts every send on a chain with a gate: relays, the native route and messages', () => {
    const relay = planRelay({ chain, token: usdc, receiver, amount: 1n, mode: { kind: 'plain' } })
    const relayAndCall = planRelay({ chain, token: usdc, receiver, amount: 1n, mode: { kind: 'call', data: '0x01' }, callbackGas: 100_000n })
    const wrap = planWrapAndRelay({ chain, receiver, value: 1n })
    const message = planSendMessage({ chain, target: receiver, data: '0x' })
    for (const plan of [relay, relayAndCall, wrap, message]) expect(passesGate(plan)).toBe(true)
    // The router's relay has the mediator's name; a later wrap variant counts too.
    expect(passesGate({ ...relay, functionName: 'wrapAndRelayTokensAndCall' })).toBe(true)
  })

  test('leaves out an approval, a confirmation, and every send on a chain with no gate', () => {
    expect(passesGate(planApproval({ chain, token: usdc, spender: chain.contracts.tokenMediator, spenderLabel: 'mediator', amount: 1n }))).toBe(false)
    expect(passesGate(planGateConfirm(chain, confirmAnswer()))).toBe(false)
    const relay = planRelay({ chain, token: usdc, receiver, amount: 1n, mode: { kind: 'plain' } })
    expect(passesGate({ ...relay, chain: { ...chain, contracts: { ...chain.contracts, gate: null } } })).toBe(false)
  })
})

describe('planGateConfirm', () => {
  test('is confirm(bytes) on the gate with no value, and says the epoch and the deadline in numbers', () => {
    const plan = planGateConfirm(chain, confirmAnswer())
    expect(plan).toMatchObject({ title: 'Confirm this epoch on the gate (epoch 360335)', to: getAddress(gate), functionSignature: 'confirm(bytes)', functionName: 'confirm', value: 0n })
    expect(plan.arguments).toEqual([{ name: 'evidence', type: 'bytes', value: evidence }])
    expect(plan.notes).toEqual([
      'The Ethereum deposit gate admits sends in epoch 360335 once one transaction confirms it. This transaction confirms it. Your send follows as the next step.',
      'The evidence proves fork version 0x90000075 with the beacon header of slot 11530720. The gate checks it against the beacon root on chain.',
      'It must be mined before 08:00:00 UTC, the end of epoch 360335. It sends no ETH.',
    ])
  })
})

describe('decideGateStep', () => {
  const early = Number(VALID_UNTIL - 300n) * 1000
  const decide = (answer: GateConfirmation, waits = 0, nowMilliseconds = early) => decideGateStep(answer, { chain, nowMilliseconds, waits })

  test('sends when the gate needs nothing', () => {
    expect(decide({ kind: 'not-needed', reason: 'confirmed', epoch: 5n })).toEqual({ kind: 'send' })
    expect(decide({ kind: 'not-needed', reason: 'not-enforcing', epoch: 5n })).toEqual({ kind: 'send' })
  })

  test('refuses on a sealed gate', () => {
    expect(decide({ kind: 'sealed', epoch: 9n })).toEqual({ kind: 'refuse', message: 'The Ethereum deposit gate is sealed: it admits no send in epoch 9 or later. Nothing was sent.' })
  })

  test('waits a slot for the header, and gives up after the limit', () => {
    const wait: GateConfirmation = { kind: 'wait', epoch: 7n, headerEpoch: 6n, retryAfterSeconds: 12 }
    expect(decide(wait, GATE_WAIT_LIMIT - 1)).toEqual({ kind: 'wait', wait: { chainName: 'Ethereum', epoch: 7n, seconds: 12 } })
    expect(decide(wait, GATE_WAIT_LIMIT)).toEqual({
      kind: 'refuse',
      message: `The beacon header of epoch 7 is not on Ethereum after ${GATE_WAIT_LIMIT} checks 12 seconds apart. Nothing was sent.`,
    })
  })

  test('inserts the confirmation with its gas when enough of the epoch is left', () => {
    const decision = decide(confirmAnswer())
    expect(decision.kind).toBe('confirm')
    if (decision.kind !== 'confirm') return
    expect(decision.mark).toEqual({ epoch: 360_335n, gas: 150_000n, validUntil: VALID_UNTIL })
    expect(decision.plan.title).toBe('Confirm this epoch on the gate (epoch 360335)')
    // Exactly the safety window left still goes ahead.
    expect(decide(confirmAnswer(), 0, Number(VALID_UNTIL - BigInt(GATE_SAFETY_SECONDS)) * 1000).kind).toBe('confirm')
  })

  test('waits for the next epoch and its first block when the epoch is about to end, and gives up after the limit', () => {
    const late = Number(VALID_UNTIL - 20n) * 1000
    expect(decide(confirmAnswer(), 0, late)).toEqual({ kind: 'wait', wait: { chainName: 'Ethereum', epoch: 360_335n, seconds: 20 + GATE_BLOCK_SECONDS, epochSecondsLeft: 20 } })
    expect(decide(confirmAnswer(), GATE_WAIT_LIMIT, late)).toEqual({
      kind: 'refuse',
      message: `The Ethereum deposit gate still ends epoch 360335 in 20 seconds after ${GATE_WAIT_LIMIT} checks. Nothing was sent.`,
    })
  })
})

describe('gateErrorText', () => {
  test('names the chain and the reason, and adds the hint only when no beacon endpoint answered', () => {
    expect(gateErrorText('odd', 'Sepolia')).toBe('Could not confirm the Sepolia deposit gate: odd.')
    expect(gateErrorText(new Error('boom'), 'Sepolia', 'Press r.')).toBe('Could not confirm the Sepolia deposit gate: boom.')
    expect(gateErrorText(new GateEvidenceError('beacon-request-failed', 'no beacon endpoint answered'), 'Sepolia', 'Press r.')).toBe(
      'Could not confirm the Sepolia deposit gate: no beacon endpoint answered. Press r.',
    )
    expect(gateErrorText(new GateEvidenceError('beacon-request-failed', 'x'), 'Sepolia')).toBe('Could not confirm the Sepolia deposit gate: x.')
    expect(gateErrorText(new GateEvidenceError('simulation-reverted', 'confirm would revert'), 'Sepolia', 'Press r.')).toBe('Could not confirm the Sepolia deposit gate: confirm would revert.')
  })
})

describe('withKnownGas', () => {
  test('answers the estimate with the simulated gas and passes the nonce and fee reads through', async () => {
    const client = {
      estimateGas: async () => 1n,
      getTransactionCount: async () => 4,
      estimateFeesPerGas: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
    }
    const known = withKnownGas(client, 150_000n)
    const plan = { to: gate, data: '0x', value: 0n } as unknown as PlannedTransaction
    expect(await known.estimateGas({ account: gate, to: plan.to, data: plan.data, value: plan.value })).toBe(150_000n)
    expect(await known.getTransactionCount({ address: gate, blockTag: 'pending' })).toBe(4)
    expect(await known.estimateFeesPerGas()).toEqual({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n })
  })
})
