import { beforeEach, describe, expect, it } from 'vitest'
import { roles } from '../src/accounts.js'
import { chainB } from '../src/chains.js'
import { deployFreshBridge, type BridgeDeployment } from '../src/deploy.js'
import { relayBlock } from '../src/relayer.js'

let bridge: BridgeDeployment

beforeEach(async () => {
  bridge = await deployFreshBridge()
})

/**
 * Specification claim: an update costs about 342 signature recoveries plus 342 Merkle proofs
 * (H-15). The specification also calls the bridge "0% fee", so nobody is paid to carry this
 * cost. This test measures the real gas, so the cost is a number and not a guess.
 */
describe('H-15: the gas cost of one light client update, with nobody paid for it', () => {
  it('measures the gas of a 342-signature updateSyncState call', async () => {
    const attestedHeader = `0x${'ab'.repeat(32)}` as const
    const result = await relayBlock({
      committee: bridge.committeeA,
      blockHash: attestedHeader,
      period: 2,
      destination: chainB,
      lightClient: bridge.b.lightClient,
      account: roles.honestRelayer,
      gas: 10_000_000n,
    })

    // The relayer pays this gas and the specification gives it no fee to recover it from.
    expect(result.gasUsed).toBeGreaterThan(5_000_000n)
    // eslint-disable-next-line no-console
    console.log(`H-15: updateSyncState with 342 signatures used ${result.gasUsed} gas`)
  })
})
