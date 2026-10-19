import { keccak256, type Hex } from 'viem'
import { beforeEach, describe, expect, it } from 'vitest'
import { fundedDeposit, sendDeposit, approveVault, mintTokens, waitForSuccess } from '../src/bridge.js'
import { roles } from '../src/accounts.js'
import { chainA, walletFor } from '../src/chains.js'
import { deployFreshBridge, type BridgeDeployment } from '../src/deploy.js'
import { DEPOSIT_INITIATED_TOPIC } from '../src/constants.js'
import { hashHeader, readReceiptsRoot } from '../src/header.js'
import { fetchWitness } from '../src/prover/host.js'
import { proveDeposit } from '../src/prover/guest.js'
import { computeReceiptsRoot, decodeReceipt, encodeReceipt, fromRpcReceipt } from '../src/receipts.js'

let bridge: BridgeDeployment

beforeEach(async () => {
  bridge = await deployFreshBridge()
})

describe('header and receipts trie against real Anvil blocks', () => {
  it('reproduces the block hash and receiptsRoot for a block with a type-2 deposit', async () => {
    const hash = await fundedDeposit({
      side: bridge.a,
      user: roles.honestUser,
      recipient: roles.honestUser.address,
      amount: 10n ** 18n,
      targetChainId: 369,
    })
    const witness = await fetchWitness(chainA.publicClient, hash)
    const block = await chainA.publicClient.getBlock({ blockHash: hashHeader(witness.headerRlp) })

    // The header RLP hashes to Anvil's block hash.
    expect(hashHeader(witness.headerRlp)).toBe(block.hash)
    // Field 5 of the header equals Anvil's receiptsRoot, and so does the rebuilt trie.
    expect(readReceiptsRoot(witness.headerRlp)).toBe(block.receiptsRoot)
    expect(await computeReceiptsRoot(witness.receipts)).toBe(block.receiptsRoot)

    // The deposit transaction is type 2, and its receipt carries the deposit log.
    const transaction = await chainA.publicClient.getTransaction({ hash })
    expect(transaction.type).toBe('eip1559')
    const receipt = decodeReceipt(witness.receipts[witness.txIndex]!)
    expect(receipt.type).toBe(2)
    expect(receipt.logs[witness.logIndex]!.topics[0]).toBe(DEPOSIT_INITIATED_TOPIC)
    expect(receipt.logs[witness.logIndex]!.address.toLowerCase()).toBe(bridge.a.vault.toLowerCase())

    // Control: a changed receipt gives a different root, so the check can fail.
    const tampered = [...witness.receipts]
    tampered[witness.txIndex] = `${tampered[witness.txIndex]!.slice(0, -2)}00` as Hex
    expect(await computeReceiptsRoot(tampered)).not.toBe(block.receiptsRoot)
  })

  it('handles block indexes above 127 (multi-byte trie keys)', async () => {
    const wallet = walletFor(chainA, roles.attacker)
    await chainA.testClient.setAutomine(false)
    const hashes: Hex[] = []
    const base = await chainA.publicClient.getTransactionCount({ address: roles.attacker.address, blockTag: 'pending' })
    for (let offset = 0; offset < 140; offset++) {
      hashes.push(await wallet.sendTransaction({ to: roles.honestUser.address, value: 1n, nonce: base + offset, gas: 21000n }))
    }
    await chainA.testClient.mine({ blocks: 1 })
    await chainA.testClient.setAutomine(true)
    const lastHash = hashes[hashes.length - 1]!
    await waitForSuccess(chainA, lastHash)
    const transaction = await chainA.publicClient.getTransaction({ hash: lastHash })
    expect(transaction.transactionIndex).toBeGreaterThan(127)

    // Deposit logs are absent, so call the host with an explicit log index and only check the trie.
    const block = await chainA.publicClient.getBlock({ blockNumber: transaction.blockNumber })
    const rawReceipts = (await chainA.publicClient.request({
      method: 'eth_getBlockReceipts',
      params: [`0x${block.number.toString(16)}`],
    } as never)) as never[]
    const encoded = rawReceipts.map((receipt) => encodeReceipt(fromRpcReceipt(receipt)))
    expect(encoded.length).toBeGreaterThan(128)
    expect(await computeReceiptsRoot(encoded)).toBe(block.receiptsRoot)
  })

  it('keeps the prover honest: it rejects a witness whose receipts do not match the header', async () => {
    await mintTokens(bridge.a, bridge.a.token, roles.honestUser.address, 5n)
    await approveVault(bridge.a, roles.honestUser, 5n)
    const hash = await sendDeposit({
      side: bridge.a,
      user: roles.honestUser,
      recipient: roles.honestUser.address,
      amount: 5n,
      targetChainId: 369,
    })
    await waitForSuccess(chainA, hash)
    const witness = await fetchWitness(chainA.publicClient, hash)
    const proof = await proveDeposit(witness, 1)
    expect(proof.inputs.confirmedBlockRoot).toBe(keccak256(witness.headerRlp))
    expect(proof.inputs.amount).toBe(5n)
    // Control: swapping the amount inside the log data breaks the trie root.
    const forged = witness.receipts.map((receipt) => receipt)
    forged[witness.txIndex] = forged[witness.txIndex]!.replace(/0{63}5/, `${'0'.repeat(63)}9`) as Hex
    await expect(proveDeposit({ ...witness, receipts: forged }, 1)).rejects.toThrow(/does not match header receipts root/)
  })
})
