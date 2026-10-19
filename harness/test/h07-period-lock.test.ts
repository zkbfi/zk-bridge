import { beforeEach, describe, expect, it } from 'vitest'
import { roles } from '../src/accounts.js'
import { fundedDeposit, withdraw } from '../src/bridge.js'
import { chainA, chainB } from '../src/chains.js'
import { deployFreshBridge, type BridgeDeployment } from '../src/deploy.js'
import { hashHeader } from '../src/header.js'
import { proveDeposit } from '../src/prover/guest.js'
import { fetchWitness } from '../src/prover/host.js'
import { buildUpdate, relayBlock, submitUpdate } from '../src/relayer.js'

let bridge: BridgeDeployment

beforeEach(async () => {
  bridge = await deployFreshBridge()
})

/**
 * Specification claim: `finalizedPeriods[period] = true` after the first accepted update for
 * that period (H-07). A period lasts about 27 hours on the real network. Whoever submits the
 * earliest signed header of a period locks it, and a deposit in a later block of the same
 * period cannot be attested until the next period.
 *
 * Result: a relayer finalizes period P with an early header. A user deposits afterwards, in a
 * later block of the same period. Attesting that later block for period P reverts, and the
 * withdrawal reverts too. The control shows the very same deposit becomes provable once a
 * later period opens for it.
 */
describe('H-07: a period accepts only the earliest attested header', () => {
  it('locks out a deposit that lands after the period is finalized', async () => {
    // Withdrawals in this test happen on chain B, so seed chain B's vault with liquidity via
    // an opposite-direction deposit called on chain B.
    await fundedDeposit({
      side: bridge.b,
      user: roles.liquidityProvider,
      recipient: roles.liquidityProvider.address,
      amount: 1_000n,
      targetChainId: 1,
    })

    const earlyHash = await fundedDeposit({
      side: bridge.a,
      user: roles.liquidityProvider,
      recipient: roles.liquidityProvider.address,
      amount: 10n,
      targetChainId: 369,
    })
    const earlyWitness = await fetchWitness(chainA.publicClient, earlyHash)

    await relayBlock({
      committee: bridge.committeeA,
      blockHash: hashHeader(earlyWitness.headerRlp),
      period: 2,
      destination: chainB,
      lightClient: bridge.b.lightClient,
      account: roles.honestRelayer,
    })

    // A user deposits afterwards, in a later block, still inside period 2 (no period argument
    // on the real network ties a block to a period directly; this harness treats "period 2" as
    // whatever a relayer chooses, which is exactly the hole: nothing on-chain checks that the
    // attested header truly belongs to the period number submitted).
    const lateHash = await fundedDeposit({
      side: bridge.a,
      user: roles.honestUser,
      recipient: roles.honestUser.address,
      amount: 5n,
      targetChainId: 369,
    })
    const lateWitness = await fetchWitness(chainA.publicClient, lateHash)
    const lateProof = await proveDeposit(lateWitness, 1)

    // Attesting the later block for the already-finalized period 2 reverts.
    const update = await buildUpdate({
      committee: bridge.committeeA,
      blockHash: lateProof.inputs.confirmedBlockRoot,
      period: 2,
    })
    // A fixed gas limit skips eth_estimateGas, which would otherwise throw on the revert
    // before the transaction ever reaches a block.
    const hash = await submitUpdate({
      destination: chainB,
      lightClient: bridge.b.lightClient,
      account: roles.honestRelayer,
      update,
      gas: 30_000_000n,
    })
    const receipt = await chainB.publicClient.waitForTransactionReceipt({ hash })
    expect(receipt.status).toBe('reverted')

    // The withdrawal reverts too: the later deposit's block root was never confirmed.
    await expect(withdraw({ side: bridge.b, caller: roles.honestUser, proof: lateProof })).rejects.toThrow()

    // Control: in period 3, the very same block root becomes attestable and the withdrawal succeeds.
    await relayBlock({
      committee: bridge.committeeA,
      blockHash: lateProof.inputs.confirmedBlockRoot,
      period: 3,
      destination: chainB,
      lightClient: bridge.b.lightClient,
      account: roles.honestRelayer,
    })
    await expect(withdraw({ side: bridge.b, caller: roles.honestUser, proof: lateProof })).resolves.toBeDefined()
  })
})
