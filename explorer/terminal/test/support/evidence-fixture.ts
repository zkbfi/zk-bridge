/**
 * Evidence files of `zk-bridge-prover evidence` for the tests of the operator actions. The execute call is a contract
 * test vector of the light client, so its proof names a real message; the other values are made up.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodeFunctionData, type Hex } from 'viem'
import { FIXTURE_PAIR } from '../../src/data/fixtures'
import type { PairConfig } from '../../src/model/types'
import { messageBridgeAbi } from '../../src/tx/abis'

/** A 32 byte word made of one hex digit. */
export const word = (digit: string): Hex => `0x${digit.repeat(64)}`

const vector = JSON.parse(
  readFileSync(join(import.meta.dir, '../../../../light-client/tests/fixtures/message/electra_accept_second_message_in_same_receipt.json'), 'utf8'),
) as { calldata: Hex; expected: { message: { messageId: Hex; sourceTransactionHash: Hex } } }

/** The message identifier of the default evidence: the message that the proof of its execute call delivers. */
export const EVIDENCE_MESSAGE_ID = vector.expected.message.messageId

/** The source transaction hash of that message. */
export const EVIDENCE_SOURCE_TRANSACTION = vector.expected.message.sourceTransactionHash

/** The `executeMessage` call of the evidence, with a real proof. */
export const EVIDENCE_EXECUTE_CALL = vector.calldata

const header = (slot: bigint) => ({
  slot,
  proposerIndex: 5n,
  parentRoot: word('1'),
  stateRoot: word('2'),
  bodyRoot: word('3'),
})

/** The `executeMessage` call of the evidence. */
export function executeCall(logIndex: bigint): Hex {
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

/** The prerequisite call of the evidence. */
export function prerequisiteCall(): Hex {
  return encodeFunctionData({
    abi: messageBridgeAbi,
    functionName: 'addBlockHashLayout',
    args: [(2n ** 4n + 9n) * 2n ** 4n + 12n, { header: header(14_099_840n), branch: [word('7'), word('8')] }],
  })
}

/** The evidence file for the default message, as text. `changes` replaces top level fields. The pair names the chain that delivers: its second chain. */
export function evidence(changes: Record<string, unknown> = {}, pair: PairConfig = FIXTURE_PAIR): string {
  const { messageBridge: bridge, lightClient } = pair.second.contracts
  return JSON.stringify({
    schemaVersion: 2,
    route: 'ethereum_to_pulsechain',
    sourceTransactionHash: EVIDENCE_SOURCE_TRANSACTION,
    logIndex: 2,
    message: {
      messageId: EVIDENCE_MESSAGE_ID,
      sender: '0x00000000000000000000000000000000000000c3',
      executor: '0x00000000000000000000000000000000000000d4',
      gasLimit: 300_000,
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
    execute: { to: bridge, data: EVIDENCE_EXECUTE_CALL },
    prerequisites: [
      { function: 'addBlockHashLayout', reason: 'no validated block hash row covers the source slot', to: bridge, data: prerequisiteCall() },
    ],
    createdAt: '2026-10-24T09:31:00Z',
    ...changes,
  })
}
