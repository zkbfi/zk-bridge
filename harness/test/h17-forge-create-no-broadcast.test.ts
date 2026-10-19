import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { beforeEach, describe, expect, it } from 'vitest'
import { anvilPrivateKey, roles } from '../src/accounts.js'
import { resetChain } from '../src/anvil.js'
import { chainA } from '../src/chains.js'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(import.meta.dirname, '../..')

/**
 * Specification claim: `deploy.sh` runs `forge create ... --json | jq -r '.deployedTo'` with no
 * `--broadcast` flag (H-17). In Foundry 1.x, `forge create` without `--broadcast` only
 * simulates the transaction locally; it never sends it to the RPC endpoint.
 *
 * Result: running the exact invocation shape from `deploy.sh` (minus `--broadcast`, kept out of
 * this test on purpose) against a real local Anvil chain, using a real contract and a real
 * Anvil private key, produces no deployment: the JSON output has no `deployedTo` field, and the
 * deployer's on-chain nonce never advances.
 */
describe('H-17: forge create without --broadcast only simulates', () => {
  beforeEach(async () => {
    // Other test files share this Anvil process and advance the deployer's nonce.
    // Reset to genesis so the nonce assertions below mean what they say.
    await resetChain(chainA)
  })

  it('deploys nothing and leaves the deployer nonce at zero', async () => {
    const nonceBefore = await chainA.publicClient.getTransactionCount({ address: roles.deployer.address })
    expect(nonceBefore).toBe(0)

    const { stdout } = await execFileAsync('forge', [
      'create',
      '--root',
      repositoryRoot,
      'src/mocks/MockERC20.sol:MockERC20',
      '--rpc-url',
      chainA.rpcUrl,
      '--private-key',
      anvilPrivateKey(0),
      '--json',
      '--constructor-args',
      'Mock Token',
      'MOCK',
    ])

    const output = JSON.parse(stdout) as Record<string, unknown>
    expect(output.deployedTo).toBeUndefined()
    expect('contract' in output).toBe(true)

    const nonceAfter = await chainA.publicClient.getTransactionCount({ address: roles.deployer.address })
    expect(nonceAfter).toBe(0)

    // Control: the same invocation WITH --broadcast does deploy, advances the nonce, and
    // reports a `deployedTo` address. This is the "honest path" that shows the hole is real,
    // not a wrong RPC URL or a misnamed contract.
    const { stdout: broadcastStdout } = await execFileAsync('forge', [
      'create',
      '--root',
      repositoryRoot,
      'src/mocks/MockERC20.sol:MockERC20',
      '--rpc-url',
      chainA.rpcUrl,
      '--private-key',
      anvilPrivateKey(0),
      '--broadcast',
      '--json',
      '--constructor-args',
      'Mock Token',
      'MOCK',
    ])
    const broadcastOutput = JSON.parse(broadcastStdout) as Record<string, unknown>
    expect(typeof broadcastOutput.deployedTo).toBe('string')
    const nonceAfterBroadcast = await chainA.publicClient.getTransactionCount({ address: roles.deployer.address })
    expect(nonceAfterBroadcast).toBe(1)
  })
})
