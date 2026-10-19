import { beforeEach, describe, expect, it } from 'vitest'
import { roles } from '../src/accounts.js'
import { fundedDeposit, isNonceProcessed, tokenBalance, withdraw } from '../src/bridge.js'
import { chainA, chainB } from '../src/chains.js'
import { deployFreshBridge, type BridgeDeployment } from '../src/deploy.js'
import { proveDeposit } from '../src/prover/guest.js'
import { fetchWitness } from '../src/prover/host.js'
import { relayBlock } from '../src/relayer.js'

let bridge: BridgeDeployment

beforeEach(async () => {
  bridge = await deployFreshBridge()
})

/**
 * Specification claim: `updateSyncState` attests `attestedHeader`, a plain header hash, not a
 * finalized checkpoint (H-08). If the source chain reorganizes after the update, the orphaned
 * block root stays `isVerifiedBlockRoot[...] == true` on the destination forever.
 *
 * Result: a deposit is made on chain A, witnessed, and attested on chain B. Chain A then
 * reorganizes the deposit away (the receipt and the tokens return to the user), yet the
 * withdrawal on chain B still succeeds against the now-nonexistent deposit.
 */
describe('H-08: an attested header survives its own chain reorganizing it away', () => {
  it('pays a withdrawal whose source deposit no longer exists', async () => {
    await fundedDeposit({
      side: bridge.b,
      user: roles.liquidityProvider,
      recipient: roles.liquidityProvider.address,
      amount: 1_000n,
      targetChainId: 1,
    })

    const snapshotId = (await chainA.testClient.snapshot()) as unknown as `0x${string}`

    const depositHash = await fundedDeposit({
      side: bridge.a,
      user: roles.honestUser,
      recipient: roles.honestUser.address,
      amount: 50n,
      targetChainId: 369,
    })
    const witness = await fetchWitness(chainA.publicClient, depositHash)
    const proof = await proveDeposit(witness, 1)

    await relayBlock({
      committee: bridge.committeeA,
      blockHash: proof.inputs.confirmedBlockRoot,
      period: 2,
      destination: chainB,
      lightClient: bridge.b.lightClient,
      account: roles.honestRelayer,
    })

    // Chain A reorganizes: the deposit block is undone and replaced with empty blocks.
    await chainA.testClient.revert({ id: snapshotId })
    await chainA.testClient.mine({ blocks: 1 })

    // The reorg undoes the deposit transaction itself, so the mint-and-approve that preceded it
    // is gone too: the user's tokens never left their wallet in the surviving chain history.
    const depositStillMined = await chainA.publicClient.getTransactionReceipt({ hash: depositHash }).catch(() => null)
    expect(depositStillMined).toBeNull()
    const userBalanceAfterReorg = await tokenBalance(bridge.a, bridge.a.token, roles.honestUser.address)
    expect(userBalanceAfterReorg).toBe(0n)
    const vaultBalanceAfterReorg = await tokenBalance(bridge.a, bridge.a.token, bridge.a.vault)
    expect(vaultBalanceAfterReorg).toBe(0n)

    const withdrawBalanceBefore = await tokenBalance(bridge.b, bridge.b.token, roles.honestUser.address)
    await withdraw({ side: bridge.b, caller: roles.honestUser, proof })
    const withdrawBalanceAfter = await tokenBalance(bridge.b, bridge.b.token, roles.honestUser.address)
    expect(withdrawBalanceAfter - withdrawBalanceBefore).toBe(50n)
    expect(await isNonceProcessed(bridge.b, proof.inputs.depositNonce)).toBe(true)
  })
})
