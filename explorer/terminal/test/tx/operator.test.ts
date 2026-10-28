import { describe, expect, test } from 'bun:test'
import { encodeAbiParameters, encodeFunctionData, type Hex } from 'viem'
import { FIXTURE_PAIR } from '../../src/data/fixtures'
import { OperatorFileError, encodeUpdateCalldata, planLightClientUpdate, planMessageExecution } from '../../src/tx/operator'
import { messageBridgeAbi } from '../../src/tx/abis'
import { lightClientOutputParameters } from './light-client-output'

const word = (digit: string): Hex => `0x${digit.repeat(64)}`
const header = (slot: bigint) => ({
  slot,
  proposerIndex: 5n,
  parentRoot: word('1'),
  stateRoot: word('2'),
  bodyRoot: word('3'),
})

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

  test('refuses a chain that is not in the pair with the error class the screens catch', () => {
    expect(() => planLightClientUpdate(handoff({ destination: { chainId: 56, lightClient } }), FIXTURE_PAIR)).toThrow(OperatorFileError)
  })
})

function executeCall(logIndex: bigint): Hex {
  return encodeFunctionData({
    abi: messageBridgeAbi,
    functionName: 'executeMessage',
    args: [
      {
        anchorHeader: header(14_100_000n),
        sourceHeader: header(14_099_000n),
        ancestryBranch: [word('4'), word('5')],
        blockHashBranch: [word('6')],
        executionHeaderRlp: '0xf90211',
        receiptProof: ['0x01', '0x02'],
        receiptIndex: 3n,
        transactionProof: ['0x03'],
        transactionIndex: 3n,
        logIndex,
      },
    ],
  })
}

function prerequisiteCall(): Hex {
  return encodeFunctionData({
    abi: messageBridgeAbi,
    functionName: 'addBlockHashLayout',
    args: [(2n ** 4n + 9n) * 2n ** 4n + 12n, { header: header(14_099_840n), branch: [word('7'), word('8')] }],
  })
}

function evidence(changes: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 2,
    route: 'ethereum_to_pulsechain',
    sourceTransactionHash: word('a'),
    logIndex: 1,
    message: {
      messageId: word('c'),
      sender: '0x0000000000000000000000000000000000000abc',
      executor: '0x0000000000000000000000000000000000000abd',
      gasLimit: 250_000,
      dataType: 0,
      data: '0xabcdef',
      sourceBlockNumber: 15,
      sourceBlockHash: word('d'),
      sourceSlot: 14_099_000,
    },
    destination: { chainId: 369, bridge, lightClient },
    anchor: { slot: 14_100_000, root: word('e') },
    deliveryStatus: 'notDelivered',
    alreadyDelivered: false,
    execute: { to: bridge, data: executeCall(1n) },
    prerequisites: [
      { function: 'addBlockHashLayout', reason: 'no validated block hash row covers the source slot', to: bridge, data: prerequisiteCall() },
    ],
    createdAt: '2026-10-24T09:31:00Z',
    ...changes,
  })
}

describe('planMessageExecution (adapter)', () => {
  test('maps every step to a transaction on the chain, labelled with the bridge', () => {
    const { steps, summary } = planMessageExecution(evidence(), FIXTURE_PAIR)
    expect(steps.map((step) => step.role)).toEqual(['prerequisite', 'execute'])
    expect(steps.every((step) => step.plan.to === bridge && step.plan.chain === FIXTURE_PAIR.second)).toBe(true)
    expect(steps[1]?.plan.contractLabel).toBe('MessageBridge (PulseChain)')
    expect(steps[1]?.plan.functionName).toBe('executeMessage')
    expect(summary.messageId).toBe(word('c'))
  })

  test('maps a message on the first chain to that chain', () => {
    const first = FIXTURE_PAIR.first
    const text = evidence({
      destination: { chainId: 1, bridge: first.contracts.messageBridge, lightClient: first.contracts.lightClient },
      execute: { to: first.contracts.messageBridge, data: executeCall(1n) },
      prerequisites: [],
    })
    expect(planMessageExecution(text, FIXTURE_PAIR).steps[0]?.plan.chain).toBe(first)
  })

  test('refuses a delivered message with the error class the screens catch', () => {
    expect(() => planMessageExecution(evidence({ alreadyDelivered: true, deliveryStatus: 'succeeded' }), FIXTURE_PAIR)).toThrow(OperatorFileError)
  })
})
