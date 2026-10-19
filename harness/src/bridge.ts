import { erc20Abi, type Abi, type Account, type Address, type Hex, type TransactionReceipt } from 'viem'
import { roles } from './accounts.js'
import { artifacts } from './artifacts.js'
import { walletFor, type ChainHandle } from './chains.js'
import type { ChainDeployment } from './deploy.js'
import type { DepositProof } from './prover/guest.js'

/** Options for `sendDeposit`. */
export interface DepositOptions {
  readonly side: ChainDeployment
  readonly user: Account
  readonly recipient: Address
  readonly amount: bigint
  readonly targetChainId: number
  /** Defaults to the shared mock token. */
  readonly token?: Address
}

const vaultAbi = (): Abi => artifacts.vault().abi
const tokenAbi = (): Abi => artifacts.token().abi

/** Waits for a transaction and throws when it did not succeed. */
export const waitForSuccess = async (handle: ChainHandle, hash: Hex): Promise<TransactionReceipt> => {
  const receipt = await handle.publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`Transaction ${hash} reverted`)
  return receipt
}

/** Mints mock tokens to an account. The deployer owns no special right: `mint` is public. */
export const mintTokens = async (side: ChainDeployment, token: Address, to: Address, amount: bigint): Promise<void> => {
  const hash = await walletFor(side.handle, roles.deployer).writeContract({
    address: token,
    abi: tokenAbi(),
    functionName: 'mint',
    args: [to, amount],
  })
  await waitForSuccess(side.handle, hash)
}

/** Reads an ERC-20 balance. */
export const tokenBalance = (side: ChainDeployment, token: Address, holder: Address): Promise<bigint> =>
  side.handle.publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [holder] })

/** Approves the vault to pull tokens and waits for the approval. */
export const approveVault = async (
  side: ChainDeployment,
  user: Account,
  amount: bigint,
  token: Address = side.token,
): Promise<void> => {
  const hash = await walletFor(side.handle, user).writeContract({
    address: token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [side.vault, amount],
  })
  await waitForSuccess(side.handle, hash)
}

/**
 * Sends `ZKBridgeVault.deposit` and returns the hash without waiting.
 * The caller must have approved the vault.
 */
export const sendDeposit = (options: DepositOptions): Promise<Hex> => {
  const { side, user, recipient, amount, targetChainId, token = side.token } = options
  return walletFor(side.handle, user).writeContract({
    address: side.vault,
    abi: vaultAbi(),
    functionName: 'deposit',
    args: [token, recipient, amount, BigInt(targetChainId)],
  })
}

/** Mints, approves, deposits, and waits. Returns the deposit transaction hash. */
export const fundedDeposit = async (options: DepositOptions): Promise<Hex> => {
  const { side, user, amount, token = side.token } = options
  await mintTokens(side, token, user.address, amount)
  await approveVault(side, user, amount, token)
  const hash = await sendDeposit(options)
  await waitForSuccess(side.handle, hash)
  return hash
}

/** Options for `sendWithdraw`. */
export interface WithdrawOptions {
  readonly side: ChainDeployment
  readonly caller: Account
  readonly proof: DepositProof
}

/** Sends `ZKBridgeVault.withdraw` and returns the hash without waiting. */
export const sendWithdraw = (options: WithdrawOptions): Promise<Hex> => {
  const { side, caller, proof } = options
  return walletFor(side.handle, caller).writeContract({
    address: side.vault,
    abi: vaultAbi(),
    functionName: 'withdraw',
    args: [proof.proof, proof.publicInputsBytes],
  })
}

/** Sends `withdraw` and waits for success. */
export const withdraw = async (options: WithdrawOptions): Promise<TransactionReceipt> =>
  waitForSuccess(options.side.handle, await sendWithdraw(options))

/** Reads the nullifier flag for a deposit nonce. */
export const isNonceProcessed = (side: ChainDeployment, nonce: Hex): Promise<boolean> =>
  side.handle.publicClient.readContract({
    address: side.vault,
    abi: vaultAbi(),
    functionName: 'processedNonces',
    args: [nonce],
  }) as Promise<boolean>

/** Reads `isVerifiedBlockRoot` from a light client. */
export const isBlockRootVerified = (side: ChainDeployment, blockRoot: Hex): Promise<boolean> =>
  side.handle.publicClient.readContract({
    address: side.lightClient,
    abi: artifacts.lightClient().abi,
    functionName: 'isVerifiedBlockRoot',
    args: [blockRoot],
  }) as Promise<boolean>

/** Hash of the newest block on a chain. */
export const latestBlockHash = async (handle: ChainHandle): Promise<Hex> => {
  const block = await handle.publicClient.getBlock({ blockTag: 'latest' })
  return block.hash
}
