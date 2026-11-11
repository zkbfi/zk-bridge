/** Answers of the deposit gate check for the tests of the gate step, the flow and the review. */
import type { GateConfirmation, SendEvidence } from '@zk-bridge/shared'
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'
import { FIXTURE_PAIR } from '../../src/data/fixtures'

export const GATE: Address = FIXTURE_PAIR.first.contracts.gate as Address
export const EVIDENCE: Hex = `0x${'ab'.repeat(40)}`
/** The end of epoch 360335 in the fixture answers: 08:00:00 UTC. */
export const VALID_UNTIL = 1_762_502_400n

/** A `confirm` answer: the simulated confirmation of epoch 360335 with 150000 gas. */
export const confirmAnswer = (overrides: Partial<Extract<GateConfirmation, { kind: 'confirm' }>> = {}): Extract<GateConfirmation, { kind: 'confirm' }> =>
  ({
    kind: 'confirm',
    call: { to: GATE, data: encodeFunctionData({ abi: parseAbi(['function confirm(bytes evidence)']), functionName: 'confirm', args: [EVIDENCE] }) },
    gas: 150_000n,
    epoch: 360_335n,
    forkVersion: '0x90000075',
    shape: 6,
    validUntil: VALID_UNTIL,
    evidence: { encoded: EVIDENCE, header: { slot: 11_530_720n } },
    ...overrides,
  }) as unknown as Extract<GateConfirmation, { kind: 'confirm' }>

/** An `evidence` answer for a send through the router: the evidence of epoch 360335. */
export const evidenceAnswer = (overrides: Partial<Extract<SendEvidence, { kind: 'evidence' }>> = {}): Extract<SendEvidence, { kind: 'evidence' }> =>
  ({
    kind: 'evidence',
    gateEvidence: EVIDENCE,
    epoch: 360_335n,
    forkVersion: '0x90000075',
    shape: 6,
    validUntil: VALID_UNTIL,
    evidence: { encoded: EVIDENCE, header: { slot: 11_530_720n } },
    ...overrides,
  }) as unknown as Extract<SendEvidence, { kind: 'evidence' }>
