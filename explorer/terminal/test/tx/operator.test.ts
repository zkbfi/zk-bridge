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

describe('planLightClientUpdate', () => {
  test('plans the update call to the configured light client of the destination', () => {
    const plan = planLightClientUpdate(handoff(), FIXTURE_PAIR)
    expect(plan.to).toBe(lightClient)
    expect(plan.chain.chainId).toBe(369)
    expect(plan.functionSignature).toBe('update(bytes,bytes)')
    expect(plan.value).toBe(0n)
    expect(plan.arguments.find((argument) => argument.name === 'publicValues.newHeadSlot')?.value).toBe(String(NEW_SLOT))
    expect(plan.notes[0]).toContain(`from slot ${START_SLOT} to slot ${NEW_SLOT}`)
  })

  test('the calldata sent is the calldata in the file, byte for byte', () => {
    const text = handoff()
    expect(planLightClientUpdate(text, FIXTURE_PAIR).data).toBe(JSON.parse(text).updateCalldata)
  })

  test('refuses a destination that is not the configured light client', () => {
    const other = '0x0000000000000000000000000000000000009999'
    expect(() => planLightClientUpdate(handoff({ destination: { chainId: 369, lightClient: other } }), FIXTURE_PAIR)).toThrow(OperatorFileError)
  })

  test('refuses a destination chain that is not in the pair, and a file with no destination', () => {
    expect(() => planLightClientUpdate(handoff({ destination: { chainId: 56, lightClient } }), FIXTURE_PAIR)).toThrow(OperatorFileError)
    expect(() => planLightClientUpdate(handoff({ destination: undefined }), FIXTURE_PAIR)).toThrow(OperatorFileError)
  })

  test('refuses a file whose slots differ from its own public values', () => {
    expect(() => planLightClientUpdate(handoff({ newHeadSlot: NEW_SLOT + 1 }), FIXTURE_PAIR)).toThrow(/newHeadSlot/)
    expect(() => planLightClientUpdate(handoff({ startHeadSlot: START_SLOT - 1 }), FIXTURE_PAIR)).toThrow(/previousHeadSlot/)
    expect(() => planLightClientUpdate(handoff({ newHeadRoot: word('0') }), FIXTURE_PAIR)).toThrow(/newHeaderRoot/)
  })

  test('refuses calldata that does not carry the proof and public values of the file', () => {
    const swapped = encodeUpdateCalldata(`0x${'34'.repeat(260)}`, publicValues())
    expect(() => planLightClientUpdate(handoff({ updateCalldata: swapped }), FIXTURE_PAIR)).toThrow(/proof/)
    expect(() => planLightClientUpdate(handoff({ updateCalldata: '0x12345678' }), FIXTURE_PAIR)).toThrow(/update\(bytes,bytes\)/)
  })

  test('refuses public values of the wrong length, a wrong schema version, and text that is not JSON', () => {
    const short: Hex = '0x1234'
    const proof: Hex = `0x${'12'.repeat(260)}`
    expect(() => planLightClientUpdate(handoff({ publicValues: short, updateCalldata: encodeUpdateCalldata(proof, short) }, short), FIXTURE_PAIR)).toThrow(/352/)
    expect(() => planLightClientUpdate(handoff({ schemaVersion: 2 }), FIXTURE_PAIR)).toThrow(/schemaVersion/)
    expect(() => planLightClientUpdate('not json', FIXTURE_PAIR)).toThrow(/JSON/)
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

describe('planMessageExecution', () => {
  test('puts the prerequisites first and the execution last, all against the configured bridge', () => {
    const { steps, summary } = planMessageExecution(evidence(), FIXTURE_PAIR)
    expect(steps.map((step) => step.role)).toEqual(['prerequisite', 'execute'])
    expect(steps.every((step) => step.plan.to === bridge && step.plan.chain.chainId === 369)).toBe(true)
    expect(steps[0]?.reason).toContain('no validated block hash row')
    expect(summary.messageId).toBe(word('c'))
    expect(summary.sourceSlot).toBe(14_099_000n)
    expect(summary.anchorSlot).toBe(14_100_000n)
  })

  test('shows the decoded proof of the execution, not just the bytes', () => {
    const { steps } = planMessageExecution(evidence(), FIXTURE_PAIR)
    const names = steps[1]?.plan.arguments.map((argument) => argument.name) ?? []
    expect(names).toContain('proof.anchorHeader.slot')
    expect(names).toContain('proof.sourceHeader.slot')
    expect(names).toContain('proof.logIndex')
    expect(steps[1]?.plan.arguments.find((argument) => argument.name === 'proof.receiptIndex')?.value).toBe('3')
  })

  test('refuses a message that is already delivered', () => {
    for (const changes of [
      { alreadyDelivered: true, deliveryStatus: 'succeeded' },
      { alreadyDelivered: false, deliveryStatus: 'failed' },
    ]) {
      expect(() => planMessageExecution(evidence(changes), FIXTURE_PAIR)).toThrow(/already delivered/)
    }
  })

  test('refuses an execution that targets another contract than the configured bridge', () => {
    const other = '0x0000000000000000000000000000000000009999'
    expect(() => planMessageExecution(evidence({ execute: { to: other, data: executeCall(1n) } }), FIXTURE_PAIR)).toThrow(OperatorFileError)
    expect(() => planMessageExecution(evidence({ destination: { chainId: 369, bridge: other, lightClient } }), FIXTURE_PAIR)).toThrow(OperatorFileError)
  })

  test('refuses an execution whose proof names another log than the file says', () => {
    expect(() => planMessageExecution(evidence({ logIndex: 2 }), FIXTURE_PAIR)).toThrow(/logIndex/)
  })

  test('refuses calldata that is not executeMessage, and a prerequisite that is not a bridge call', () => {
    expect(() => planMessageExecution(evidence({ execute: { to: bridge, data: prerequisiteCall() } }), FIXTURE_PAIR)).toThrow(/executeMessage/)
    const unknown = { function: 'addBlockHashLayout', reason: 'x', to: bridge, data: '0x12345678' }
    expect(() => planMessageExecution(evidence({ prerequisites: [unknown] }), FIXTURE_PAIR)).toThrow(/known message bridge call/)
  })

  test('refuses a prerequisite whose named function differs from its calldata', () => {
    const mislabeled = { function: 'addBlockRootsLayout', reason: 'x', to: bridge, data: prerequisiteCall() }
    expect(() => planMessageExecution(evidence({ prerequisites: [mislabeled] }), FIXTURE_PAIR)).toThrow(/differs/)
  })

  test('an empty prerequisite list leaves only the execution', () => {
    expect(planMessageExecution(evidence({ prerequisites: [] }), FIXTURE_PAIR).steps).toHaveLength(1)
  })
})
