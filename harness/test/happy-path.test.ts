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
 * The honest path, in both directions. The specification claims a user can deposit on one
 * chain and withdraw on the other once the destination light client has the source block root.
 * This test shows that path works end to end against real contracts and a real receipts trie.
 */
describe('happy path: honest deposit, relay, and withdraw', () => {
  it('bridges chain A to chain B', async () => {
    // `deposit` locks tokens in the vault on the chain where it is called, not on the target
    // chain. So a deposit called on chain B, in the opposite direction, is what seeds chain B's
    // vault with the liquidity that a later chain A -> chain B withdrawal pays out from. The
    // specification has no liquidity model (H-09): this seed deposit is never itself withdrawn.
    await fundedDeposit({
      side: bridge.b,
      user: roles.liquidityProvider,
      recipient: roles.liquidityProvider.address,
      amount: 500n,
      targetChainId: 1,
    })

    const depositAmount = 100n
    const depositHash = await fundedDeposit({
      side: bridge.a,
      user: roles.honestUser,
      recipient: roles.honestUser.address,
      amount: depositAmount,
      targetChainId: 369,
    })
    const vaultBalanceAfterDeposit = await tokenBalance(bridge.a, bridge.a.token, bridge.a.vault)
    expect(vaultBalanceAfterDeposit).toBe(depositAmount)

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

    const balanceBefore = await tokenBalance(bridge.b, bridge.b.token, roles.honestUser.address)
    await withdraw({ side: bridge.b, caller: roles.honestUser, proof })
    const balanceAfter = await tokenBalance(bridge.b, bridge.b.token, roles.honestUser.address)
    expect(balanceAfter - balanceBefore).toBe(depositAmount)
    expect(await isNonceProcessed(bridge.b, proof.inputs.depositNonce)).toBe(true)
  })

  it('bridges chain B to chain A', async () => {
    // Seed chain A's vault with liquidity: a deposit called on chain A, in the opposite
    // direction, locks tokens in chain A's vault for a later chain B -> chain A withdrawal.
    await fundedDeposit({
      side: bridge.a,
      user: roles.liquidityProvider,
      recipient: roles.liquidityProvider.address,
      amount: 500n,
      targetChainId: 369,
    })

    const depositAmount = 77n
    const depositHash = await fundedDeposit({
      side: bridge.b,
      user: roles.secondHonestUser,
      recipient: roles.secondHonestUser.address,
      amount: depositAmount,
      targetChainId: 1,
    })
    const witness = await fetchWitness(chainB.publicClient, depositHash)
    const proof = await proveDeposit(witness, 369)

    await relayBlock({
      committee: bridge.committeeB,
      blockHash: proof.inputs.confirmedBlockRoot,
      period: 2,
      destination: chainA,
      lightClient: bridge.a.lightClient,
      account: roles.honestRelayer,
    })

    const balanceBefore = await tokenBalance(bridge.a, bridge.a.token, roles.secondHonestUser.address)
    await withdraw({ side: bridge.a, caller: roles.secondHonestUser, proof })
    const balanceAfter = await tokenBalance(bridge.a, bridge.a.token, roles.secondHonestUser.address)
    expect(balanceAfter - balanceBefore).toBe(depositAmount)
  })
})
