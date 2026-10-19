import { beforeEach, describe, expect, it } from 'vitest'
import { roles } from '../src/accounts.js'
import { approveVault, isNonceProcessed, mintTokens, sendDeposit, tokenBalance, waitForSuccess, withdraw } from '../src/bridge.js'
import { chainA, chainB } from '../src/chains.js'
import { deployFreshBridge, type BridgeDeployment } from '../src/deploy.js'
import { decodeBridgeInputs, proveDeposit } from '../src/prover/guest.js'
import { fetchWitness } from '../src/prover/host.js'
import { relayBlock } from '../src/relayer.js'

let bridge: BridgeDeployment

beforeEach(async () => {
  bridge = await deployFreshBridge()
})

/**
 * Specification claim: `nonce = keccak256(msg.sender, recipient, amount, block.timestamp,
 * block.prevrandao)` (H-12). Two identical deposits from the same sender, in the same block,
 * produce the same nonce, because every input to the hash is identical.
 *
 * Result: an attacker (or just an unlucky honest user) sends two identical deposits in one
 * block on chain A. Both lock tokens. Only one of the two withdrawals on chain B succeeds,
 * because `processedNonces` can only be cleared once per nonce; the second one reverts with
 * "Bridge transaction already claimed" even though a second, distinct deposit paid for it.
 */
describe('H-12: two identical deposits in one block share a nonce', () => {
  it('locks two deposits but allows only one withdrawal', async () => {
    // Seed chain B's vault with liquidity for the withdrawals under test, via an
    // opposite-direction deposit called on chain B.
    await mintTokens(bridge.b, bridge.b.token, roles.liquidityProvider.address, 100n)
    await approveVault(bridge.b, roles.liquidityProvider, 100n)
    const seedHash = await sendDeposit({
      side: bridge.b,
      user: roles.liquidityProvider,
      recipient: roles.liquidityProvider.address,
      amount: 100n,
      targetChainId: 1,
    })
    await waitForSuccess(chainB, seedHash)

    await mintTokens(bridge.a, bridge.a.token, roles.honestUser.address, 200n)
    await approveVault(bridge.a, roles.honestUser, 200n)

    await chainA.testClient.setAutomine(false)
    const depositArgs = {
      side: bridge.a,
      user: roles.honestUser,
      recipient: roles.honestUser.address,
      amount: 25n,
      targetChainId: 369,
    } as const
    const firstHash = await sendDeposit(depositArgs)
    const secondHash = await sendDeposit({ ...depositArgs, token: bridge.a.token })
    await chainA.testClient.mine({ blocks: 1 })
    await chainA.testClient.setAutomine(true)

    await waitForSuccess(chainA, firstHash)
    await waitForSuccess(chainA, secondHash)
    const sameBlock = (await chainA.publicClient.getTransaction({ hash: firstHash })).blockNumber
    expect((await chainA.publicClient.getTransaction({ hash: secondHash })).blockNumber).toBe(sameBlock)

    const firstWitness = await fetchWitness(chainA.publicClient, firstHash)
    const secondWitness = await fetchWitness(chainA.publicClient, secondHash)
    // Both logs sit in the same block; the host finds the deposit log for each transaction's
    // own receipt, but both receipts carry the identical nonce.
    const firstProof = await proveDeposit(firstWitness, 1)
    const secondProof = await proveDeposit(secondWitness, 1)
    expect(decodeBridgeInputs(firstProof.publicInputsBytes).depositNonce).toBe(
      decodeBridgeInputs(secondProof.publicInputsBytes).depositNonce,
    )
    // Both deposits really did lock tokens: the vault holds both amounts.
    expect(await tokenBalance(bridge.a, bridge.a.token, bridge.a.vault)).toBe(50n)

    await relayBlock({
      committee: bridge.committeeA,
      blockHash: firstProof.inputs.confirmedBlockRoot,
      period: 2,
      destination: chainB,
      lightClient: bridge.b.lightClient,
      account: roles.honestRelayer,
    })

    await withdraw({ side: bridge.b, caller: roles.honestUser, proof: firstProof })
    expect(await isNonceProcessed(bridge.b, firstProof.inputs.depositNonce)).toBe(true)

    // The second, distinct deposit's withdrawal reverts: the nonce is already marked claimed.
    await expect(withdraw({ side: bridge.b, caller: roles.honestUser, proof: secondProof })).rejects.toThrow(
      /already claimed/,
    )

    // Control: a deposit in a DIFFERENT block (different timestamp/prevrandao) gets its own
    // nonce and withdraws without colliding with anything.
    await mintTokens(bridge.a, bridge.a.token, roles.honestUser.address, 25n)
    await approveVault(bridge.a, roles.honestUser, 25n)
    const laterHash = await sendDeposit(depositArgs)
    await waitForSuccess(chainA, laterHash)
    const laterWitness = await fetchWitness(chainA.publicClient, laterHash)
    const laterProof = await proveDeposit(laterWitness, 1)
    expect(laterProof.inputs.depositNonce).not.toBe(firstProof.inputs.depositNonce)
    await relayBlock({
      committee: bridge.committeeA,
      blockHash: laterProof.inputs.confirmedBlockRoot,
      period: 3,
      destination: chainB,
      lightClient: bridge.b.lightClient,
      account: roles.honestRelayer,
    })
    await expect(withdraw({ side: bridge.b, caller: roles.honestUser, proof: laterProof })).resolves.toBeDefined()
  })
})
