import { describe, expect, test } from 'bun:test'
import { encodeAbiParameters, type Hex } from 'viem'
import { FIXTURE_PAIR } from '../../src/data/fixtures'
import { OperatorFileError, encodeUpdateCalldata, planLightClientUpdate, planMessageExecution, planProofMessageUpdate } from '../../src/tx/operator'
import { EVIDENCE_EXECUTE_CALL, EVIDENCE_MESSAGE_ID, evidence, executeCall, word } from '../support/evidence-fixture'
import { proofMessage } from '../support/proof-fixtures'
import { lightClientOutputParameters } from './light-client-output'

const START_SLOT = 14_099_840
const NEW_SLOT = 14_100_000
const lightClient = FIXTURE_PAIR.second.contracts.lightClient
const bridge = FIXTURE_PAIR.second.contracts.messageBridge

function publicValues(overrides: { previousHeadSlot?: bigint; newHeadSlot?: bigint } = {}): Hex {
  return encodeAbiParameters(lightClientOutputParameters, [
    word('a'),
    word('b'),
    overrides.previousHeadSlot ?? BigInt(START_SLOT),
    word('c'),
    word('d'),
    word('e'),
    overrides.newHeadSlot ?? BigInt(NEW_SLOT),
    word('f'),
    21_000_000n,
    word('9'),
    word('8'),
  ])
}

function handoff(changes: Record<string, unknown> = {}, values: Hex = publicValues()): string {
  const proof: Hex = `0x${'12'.repeat(260)}`
  return JSON.stringify({
    schemaVersion: 1,
    route: 'ethereum_to_pulsechain',
    programKey: word('9'),
    startHeadSlot: START_SLOT,
    startHeadRoot: word('b'),
    newHeadSlot: NEW_SLOT,
    newHeadRoot: word('e'),
    latestFinalizedSlot: NEW_SLOT,
    publicValues: values,
    proof,
    updateCalldata: encodeUpdateCalldata(proof, values),
    backend: 'remote',
    destination: { chainId: 369, lightClient },
    createdAt: '2026-10-24T09:30:00Z',
    ...changes,
  })
}

describe('planLightClientUpdate (adapter)', () => {
  test('maps the shared call to a transaction at the light client of the chain', () => {
    const plan = planLightClientUpdate(handoff(), FIXTURE_PAIR)
    expect(plan.to).toBe(lightClient)
    expect(plan.chain).toBe(FIXTURE_PAIR.second)
    expect(plan.contractLabel).toBe('BeaconLightClient (PulseChain)')
    expect(plan.functionName).toBe('update')
    expect(plan.value).toBe(0n)
    expect(plan.data).toBe(JSON.parse(handoff()).updateCalldata)
  })

  test('refuses a chain that is not in the pair, and names the pair', () => {
    const attempt = () => planLightClientUpdate(handoff({ destination: { chainId: 56, lightClient } }), FIXTURE_PAIR)
    expect(attempt).toThrow(OperatorFileError)
    expect(attempt).toThrow('The file names chain 56, which is not a chain of the pair eth-pls.')
  })
})


describe('planMessageExecution (adapter)', () => {
  test('maps every step to a transaction on the chain, labelled with the bridge', () => {
    const { steps, summary } = planMessageExecution(evidence(), FIXTURE_PAIR)
    expect(steps.map((step) => step.role)).toEqual(['prerequisite', 'execute'])
    expect(steps.every((step) => step.plan.to === bridge && step.plan.chain === FIXTURE_PAIR.second)).toBe(true)
    expect(steps[1]?.plan.contractLabel).toBe('MessageBridge (PulseChain)')
    expect(steps[1]?.plan.functionName).toBe('executeMessage')
    expect(summary.messageId).toBe(EVIDENCE_MESSAGE_ID)
  })

  test('refuses evidence that names the first chain for a message that the proof sends to the second', () => {
    const first = FIXTURE_PAIR.first
    const text = evidence({
      destination: { chainId: 1, bridge: first.contracts.messageBridge, lightClient: first.contracts.lightClient },
      execute: { to: first.contracts.messageBridge, data: EVIDENCE_EXECUTE_CALL },
      prerequisites: [],
    })
    expect(() => planMessageExecution(text, FIXTURE_PAIR)).toThrow(/for chain 369/)
  })

  test('refuses a delivered message with the error class the screens catch', () => {
    expect(() => planMessageExecution(evidence({ alreadyDelivered: true, deliveryStatus: 'succeeded' }), FIXTURE_PAIR)).toThrow(OperatorFileError)
  })

  test('names the pair for a chain that is not in the pair of an evidence file too', () => {
    const text = evidence({ destination: { chainId: 56, bridge, lightClient } })
    expect(() => planMessageExecution(text, FIXTURE_PAIR)).toThrow('not a chain of the pair eth-pls')
  })
})

describe('planProofMessageUpdate (adapter)', () => {
  test('a first-to-second proof updates the light client on the second chain, with the calldata built from the message', () => {
    const message = proofMessage()
    const plan = planProofMessageUpdate(message, FIXTURE_PAIR)
    expect(plan.chain).toBe(FIXTURE_PAIR.second)
    expect(plan.to).toBe(FIXTURE_PAIR.second.contracts.lightClient)
    expect(plan.functionSignature).toBe('update(bytes,bytes)')
    expect(plan.data).toBe(encodeUpdateCalldata(message.proof, message.publicValues))
  })

  test('a second-to-first proof updates the light client on the first chain', () => {
    const plan = planProofMessageUpdate(proofMessage({ direction: 'second-to-first' }), FIXTURE_PAIR)
    expect(plan.chain).toBe(FIXTURE_PAIR.first)
    expect(plan.to).toBe(FIXTURE_PAIR.first.contracts.lightClient)
  })

  test('a message whose slots disagree with its public values is refused', () => {
    expect(() => planProofMessageUpdate(proofMessage({ newSlot: 14_100_064n, publicValues: proofMessage().publicValues }), FIXTURE_PAIR)).toThrow(OperatorFileError)
  })
})
