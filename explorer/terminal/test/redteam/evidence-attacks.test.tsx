/**
 * Red team (2026-10-29): a malicious archive or backend hands the terminal evidence, proofs and status text. These tests
 * show what the terminal refuses and what it lets through to the review screen.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { testRender } from '@opentui/react/test-utils'
import { act } from 'react'
import { encodeFunctionData, type Hex } from 'viem'
import { proofStartProblem, readProvenMessage } from '@zk-bridge/shared'
import { FIXTURE_PAIR } from '../../src/data/fixtures'
import { planMessageExecution } from '../../src/tx/operator'
import { messageBridgeAbi } from '../../src/tx/abis'
import { RichLine, plain } from '../../src/ui/rich-text'
import { directionLines } from '../../src/ui/proof-panel'
import { EVIDENCE_EXECUTE_CALL, evidence } from '../support/evidence-fixture'
import { proofMessage } from '../support/proof-fixtures'

const bridge = FIXTURE_PAIR.second.contracts.messageBridge
const vectorDir = join(import.meta.dir, '../../../../light-client/tests/fixtures/message')
const vectorCall = (name: string): Hex => (JSON.parse(readFileSync(join(vectorDir, `${name}.json`), 'utf8')) as { calldata: Hex }).calldata

/** Evidence whose labels are copied from the proof itself, so every label check passes. */
function consistentEvidence(calldata: Hex, changes: Record<string, unknown> = {}): string {
  const proven = readProvenMessage(calldata)
  const base = JSON.parse(evidence()) as Record<string, unknown>
  const logIndex = Number((JSON.parse(JSON.stringify(decodeLogIndex(calldata)))))
  return JSON.stringify({
    ...base,
    sourceTransactionHash: proven.sourceTransactionHash,
    logIndex,
    message: { ...(base.message as object), messageId: proven.messageId, sender: proven.sender, executor: proven.executor, gasLimit: Number(proven.gasLimit) },
    execute: { to: bridge, data: calldata },
    ...changes,
  })
}

function decodeLogIndex(calldata: Hex): string {
  // logIndex is the last word of the static part of the proof tuple; reading it through the planner's error is simpler.
  for (let index = 0; index < 64; index++) {
    try {
      planMessageExecution(JSON.stringify({ ...JSON.parse(evidence()), logIndex: index, execute: { to: bridge, data: calldata } }), FIXTURE_PAIR)
      return String(index)
    } catch (error) {
      if (!(error as Error).message.includes('logIndex')) return String(index)
    }
  }
  throw new Error('no log index')
}

const layoutRow = (data: Hex, fn: string) => ({ function: fn, reason: 'no validated block hash row covers the source slot', to: bridge, data })

describe('evidence bound to the proof (fix 3473404)', () => {
  test('ATTACK evidence labels name another message id than the proof: BLOCKED', () => {
    const file = JSON.parse(evidence()) as { message: Record<string, unknown> }
    file.message.messageId = `0x${'ab'.repeat(32)}`
    expect(() => planMessageExecution(JSON.stringify(file), FIXTURE_PAIR)).toThrow(/messageId in the file/)
  })

  for (const [field, value, pattern] of [
    ['sender', '0x00000000000000000000000000000000000000c4', /sender in the file/],
    ['executor', '0x00000000000000000000000000000000000000d5', /executor in the file/],
    ['gasLimit', 300_001, /gasLimit in the file/],
  ] as const) {
    test(`ATTACK evidence label ${field} differs from the proof: BLOCKED`, () => {
      const file = JSON.parse(evidence()) as { message: Record<string, unknown> }
      file.message[field] = value
      expect(() => planMessageExecution(JSON.stringify(file), FIXTURE_PAIR)).toThrow(pattern)
    })
  }

  test('ATTACK evidence source transaction hash differs from the proof: BLOCKED', () => {
    expect(() => planMessageExecution(evidence({ sourceTransactionHash: `0x${'cd'.repeat(32)}` }), FIXTURE_PAIR)).toThrow(/sourceTransactionHash/)
  })

  test('ATTACK evidence logIndex label differs from the calldata: BLOCKED', () => {
    expect(() => planMessageExecution(evidence({ logIndex: 1 }), FIXTURE_PAIR)).toThrow(/logIndex/)
  })

  test('ATTACK evidence for PulseChain re-labelled as Ethereum (wrong-chain signing): BLOCKED', () => {
    const first = FIXTURE_PAIR.first.contracts
    const text = evidence({ destination: { chainId: 1, bridge: first.messageBridge, lightClient: first.lightClient }, execute: { to: first.messageBridge, data: EVIDENCE_EXECUTE_CALL } })
    expect(() => planMessageExecution(text, FIXTURE_PAIR)).toThrow(/proven message is for chain 369/)
  })

  test('ATTACK execute call aimed at another contract than the bridge: BLOCKED', () => {
    expect(() => planMessageExecution(evidence({ execute: { to: '0x00000000000000000000000000000000000000ee', data: EVIDENCE_EXECUTE_CALL } }), FIXTURE_PAIR)).toThrow(/target of execute/)
  })

  test('ATTACK evidence says delivered=false but status "delivered": BLOCKED', () => {
    expect(() => planMessageExecution(evidence({ deliveryStatus: 'delivered' }), FIXTURE_PAIR)).toThrow(/already delivered/)
  })

  test('ATTACK the plan signs exactly the execute calldata of the file and shows proven fields', () => {
    const plan = planMessageExecution(evidence(), FIXTURE_PAIR)
    const execute = plan.steps.at(-1)!
    expect(execute.plan.data).toBe(EVIDENCE_EXECUTE_CALL.toLowerCase() as Hex)
    expect(execute.plan.chain.chainId).toBe(369)
    expect(execute.plan.to).toBe(bridge)
    expect(execute.plan.arguments.find((argument) => argument.name === 'message.messageId')?.value).toBe(readProvenMessage(EVIDENCE_EXECUTE_CALL).messageId)
  })
})

describe('evidence that the contract would refuse', () => {
  for (const name of ['electra_reject_log_from_another_emitter', 'electra_reject_wrong_source_chain', 'electra_reject_bad_version', 'electra_reject_bad_data_type']) {
    test(`ATTACK SUCCEEDS planner accepts ${name}: the user signs a call that reverts`, () => {
      const plan = planMessageExecution(consistentEvidence(vectorCall(name)), FIXTURE_PAIR)
      expect(plan.steps.at(-1)!.role).toBe('execute')
    })
  }
})

describe('prerequisite rows from the archive', () => {
  test('ATTACK SUCCEEDS a prerequisite that sends a new message as the user (requireToPassMessage)', () => {
    const data = encodeFunctionData({ abi: messageBridgeAbi, functionName: 'requireToPassMessage', args: ['0x000000000000000000000000000000000000beef', '0xdeadbeef', 500_000n] })
    const plan = planMessageExecution(evidence({ prerequisites: [layoutRow(data, 'requireToPassMessage')] }), FIXTURE_PAIR)
    const step = plan.steps[0]!
    expect(step.role).toBe('prerequisite')
    expect(step.plan.functionName).toBe('requireToPassMessage')
    // The review title calls it a layout row.
    expect(step.plan.title).toBe('Add a layout row: requireToPassMessage')
  })

  test('ATTACK SUCCEEDS a prerequisite that executes a different message (user pays its gas)', () => {
    const other = vectorCall('electra_accept_dynamic_fee_receipt')
    const plan = planMessageExecution(evidence({ prerequisites: [layoutRow(other, 'executeMessage')] }), FIXTURE_PAIR)
    expect(plan.steps[0]!.plan.functionName).toBe('executeMessage')
    expect(plan.steps[0]!.plan.title).toBe('Add a layout row: executeMessage')
  })

  test('ATTACK prerequisite aimed at a contract other than the bridge: BLOCKED', () => {
    const row = { ...layoutRow(vectorCall('electra_accept_dynamic_fee_receipt'), 'executeMessage'), to: '0x00000000000000000000000000000000000000ee' }
    expect(() => planMessageExecution(evidence({ prerequisites: [row] }), FIXTURE_PAIR)).toThrow(/prerequisite 0/)
  })

  test('ATTACK prerequisite with an unknown selector (token approve): BLOCKED', () => {
    const row = layoutRow('0x095ea7b3000000000000000000000000000000000000000000000000000000000000beef0000000000000000000000000000000000000000000000000000000000000001', 'approve')
    expect(() => planMessageExecution(evidence({ prerequisites: [row] }), FIXTURE_PAIR)).toThrow(/not a known message bridge call/)
  })

  test('ATTACK prerequisite function label differs from its calldata: BLOCKED', () => {
    const row = layoutRow(vectorCall('electra_accept_dynamic_fee_receipt'), 'addBlockHashLayout')
    expect(() => planMessageExecution(evidence({ prerequisites: [row] }), FIXTURE_PAIR)).toThrow(/function named in the file/)
  })
})

describe('labels not bound to the calldata', () => {
  test('ATTACK SUCCEEDS summary sourceSlot, anchorSlot and route come from the file, not the proof', () => {
    const plan = planMessageExecution(evidence({ route: 'pulsechain_to_ethereum', anchor: { slot: 1, root: `0x${'e'.repeat(64)}` } }), FIXTURE_PAIR)
    expect(plan.summary.route).toBe('pulsechain_to_ethereum')
    expect(plan.summary.anchorSlot).toBe(1n)
  })
})

describe('posting a proof (fix 2caba1f)', () => {
  test('ATTACK a proof that does not start at the head read again: BLOCKED', () => {
    const message = proofMessage({ startSlot: 100n, newSlot: 200n } as never)
    expect(proofStartProblem(message, message.startSlot + 1n)).not.toBeNull()
    expect(proofStartProblem(message, message.newSlot)).not.toBeNull()
    expect(proofStartProblem(message, message.startSlot)).toBeNull()
  })
})

describe('terminal escape injection', () => {
  const hostile = 'boom\u001b]8;;https://evil.example/\u0007click\u001b]8;;\u0007\u001b[2J‮evil'

  test('ATTACK SUCCEEDS backend job error with escape sequences reaches the screen line unchanged', () => {
    const row = { direction: 'first-to-second' as const, reading: { kind: 'none' as const, notes: [] }, job: { kind: 'unknown' as const, note: hostile } }
    const lines = directionLines(FIXTURE_PAIR, row as never, 0, (text) => text)
    expect(lines[1]!.map((segment) => segment.text).join('')).toContain('\u001b]8;;')
  })

  test('ATTACK SUCCEEDS escape bytes survive into the OpenTUI cell buffer', async () => {
    const setup = await testRender(<RichLine line={[plain(hostile)]} />, { width: 120, height: 2 })
    await act(async () => {
      await setup.renderOnce()
    })
    const frame = setup.captureCharFrame()
    setup.renderer.destroy()
    // ESC and BEL are kept as cells, so the OSC 8 link and the clear-screen sequence go to the terminal as written.
    expect(frame).toContain('\u001b]8;;https://evil.example/\u0007')
    expect(frame).toContain('\u001b[2J')
  })
})
