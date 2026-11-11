import { describe, expect, test } from 'bun:test'
import { GATE_BLOCK_SECONDS, GATE_SAFETY_SECONDS, GateEvidenceError, type GateCheckAnswer, type GateConfirmation } from '@zk-bridge/shared'
import { getAddress } from 'viem'
import { FIXTURE_PAIR, FIXTURE_TOKENS } from '../../src/data/fixtures'
import { confirmAnswer, EVIDENCE, GATE, VALID_UNTIL } from '../support/gate-fixture'
import { decideGateStep, GATE_WAIT_LIMIT, gateErrorText, passesGate, planForkObservation, planGateConfirm, planGateSeal, withKnownGas } from '../../src/tx/gate-step'
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
  const decide = (answer: GateCheckAnswer, waits = 0, nowMilliseconds = early) => decideGateStep(answer, { chain, nowMilliseconds, waits })

  test('sends when the gate needs nothing', () => {
    expect(decide({ kind: 'not-needed', reason: 'confirmed', epoch: 5n })).toEqual({ kind: 'send' })
    expect(decide({ kind: 'not-needed', reason: 'not-enforcing', epoch: 5n })).toEqual({ kind: 'send' })
  })

  test('refuses on a sealed gate', () => {
    expect(decide({ kind: 'sealed', epoch: 9n })).toEqual({ kind: 'refuse', message: 'The Ethereum deposit gate is sealed: it admits no send in epoch 9 or later. Nothing was sent.' })
  })

  test('refuses a send paused before a fork, with the numbers of the pause', () => {
    const fork = { version: '0x90000075', name: 'Fulu', epoch: 500, slot: 16_000, time: 1_800_000 }
    const paused: GateCheckAnswer = { kind: 'paused', verdict: { kind: 'paused', destinationChainId: 369, fork, pausedSince: 1_796_400, lightClientHead: 15_000n, leadSeconds: 3600 } }
    expect(decide(paused, 0, 1_800_600_000)).toEqual({
      kind: 'refuse',
      message:
        'Sends from Ethereum are paused since 19:00 UTC: the Fulu fork (epoch 500) started 10m 00s ago. They resume once PulseChain\'s light client\'s finalized head is past slot 16000; it is slot 15000 now. Nothing was sent.',
    })
    const unnamed: GateCheckAnswer = { kind: 'paused', verdict: { kind: 'paused', destinationChainId: 424242, fork, pausedSince: 1_796_400, lightClientHead: null, leadSeconds: 3600 } }
    expect((decide(unnamed, 0, 1_800_600_000) as { message: string }).message).toContain("chain 424242's light client")
  })

  test('refuses a send while no fork schedule can be used, and names the copy a pause was decided from', () => {
    const blocked: GateCheckAnswer = { kind: 'paused', verdict: { kind: 'blocked', reason: 'no-fork-schedule', detail: 'x', newestCopyAt: null } }
    expect(decide(blocked, 0, 1_800_600_000)).toEqual({
      kind: 'refuse',
      message:
        "Sends from Ethereum wait: Ethereum's beacon node did not answer, and no copy of its fork schedule is at hand, so a fork in the next 12 hours cannot be ruled out. Sends resume once a beacon node answers (Settings, Beacon endpoints). Nothing was sent.",
    })
    const fork = { version: '0x90000075', name: 'Fulu', epoch: 500, slot: 16_000, time: 1_800_000 }
    const fromCopy: GateCheckAnswer = {
      kind: 'paused',
      verdict: { kind: 'paused', destinationChainId: 369, fork, pausedSince: 1_756_800, lightClientHead: 15_000n, leadSeconds: 43_200, schedule: { origin: 'cache', fetchedAt: 1_700_000, liveFailure: 'x' } },
    }
    expect((decide(fromCopy, 0, 1_800_600_000) as { message: string }).message).toContain(
      "now. Ethereum's beacon node did not answer, so this uses the fork schedule saved by this app at 1970-01-20 16:13 UTC. Nothing was sent.",
    )
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

describe('planGateSeal', () => {
  const call = { to: gate, data: '0xb2d3cf7a' as const }
  test('is seal(bytes) on the gate with no value, and says what the evidence is', () => {
    const viaRegistry = planGateSeal(chain, { kind: 'ready', call, evidence: '0x', gas: 90_000n, via: 'registry' })
    expect(viaRegistry).toMatchObject({ title: 'Seal the Ethereum deposit gate', to: getAddress(gate), functionSignature: 'seal(bytes)', functionName: 'seal', value: 0n })
    expect(viaRegistry.arguments).toEqual([{ name: 'evidence', type: 'bytes', value: '0x' }])
    expect(viaRegistry.notes[0]).toBe('The fork registry shows a state shape that the gate does not allow, so empty evidence seals the gate. The simulation used 90000 gas.')
    expect(viaRegistry.notes[1]).toBe('A sealed Ethereum gate admits no send, for good. Withdrawals are not affected. It sends no ETH.')
    const viaBeacon = planGateSeal(chain, { kind: 'ready', call, evidence: '0xabcd', gas: 90_000n, via: 'beacon' })
    expect(viaBeacon.notes[0]).toContain('a beacon state of a shape that the gate does not allow')
    expect(viaBeacon.arguments[0]!.value).toBe('0xabcd')
  })
})

describe('planForkObservation', () => {
  const observation = {
    chainId: 369,
    registry: gate,
    lightClient: gate,
    programKey: `0x${'66'.repeat(32)}`,
    startHeadSlot: 100,
    observedVersion: '0x0000036b',
    shape: 8,
    shapeAllowed: false,
    observedAttestedSlot: 900,
    foldSteps: 3,
    publicValues: `0x${'00'.repeat(256)}`,
    proof: '0x1234',
    provedAt: 1,
    postedTransaction: null,
  }
  const call = { to: gate, data: '0xabcd' as const }
  test('is observe(bytes,bytes) on the registry with no value, and says what the proof shows and what follows', () => {
    const plan = planForkObservation(chain, { kind: 'ready', call, gas: 280_000n, observation })
    expect(plan).toMatchObject({ title: 'Post the Ethereum fork observation', to: getAddress(gate), functionSignature: 'observe(bytes,bytes)', functionName: 'observe', value: 0n, data: '0xabcd' })
    expect(plan.arguments.map((argument) => argument.name)).toEqual(['proof', 'publicValues'])
    expect(plan.notes[0]).toBe('The proof shows the Ethereum sync committee signing under fork version 0x0000036b at slot 900, over a state of shape 8 (the gate does not allow it). The registry checks it against its light client at slot 100. The simulation used 280000 gas.')
    expect(plan.notes[1]).toBe('After it, anyone can seal the Ethereum gate with empty evidence, which stops every send for good. Withdrawals are not affected. It sends no ETH.')
    const allowed = planForkObservation(chain, { kind: 'ready', call, gas: 280_000n, observation: { ...observation, shape: 5, shapeAllowed: true } })
    expect(allowed.notes[0]).toContain('shape 5 (the gate allows it)')
    expect(allowed.notes[1]).toBe('The registry records the version; sends through the gate go on as before. It sends no ETH.')
  })
})
