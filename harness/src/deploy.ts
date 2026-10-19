import type { Abi, Address } from 'viem'
import { roles } from './accounts.js'
import { artifacts, type Artifact } from './artifacts.js'
import { chainA, chainB, walletFor, type ChainHandle } from './chains.js'
import { createCommittee, type Committee } from './committee.js'
import { INITIAL_PERIOD, PROGRAM_VKEY } from './constants.js'
import { proverOracleAddress } from './prover/guest.js'
import { resetBothChains } from './anvil.js'

/** The contracts on one chain. */
export interface ChainDeployment {
  readonly handle: ChainHandle
  readonly token: Address
  readonly lightClient: Address
  readonly verifier: Address
  readonly vault: Address
}

/** The whole bridge on both chains. */
export interface BridgeDeployment {
  readonly a: ChainDeployment
  readonly b: ChainDeployment
  /** The committee that attests chain A blocks. The light client on chain B tracks it. */
  readonly committeeA: Committee
  /** The committee that attests chain B blocks. The light client on chain A tracks it. */
  readonly committeeB: Committee
}

/** Options for `deployBridge`. */
export interface DeployBridgeOptions {
  readonly initialPeriod?: number
}

/** Deploys one contract from the deployer account and returns its address. */
export const deployContract = async (
  handle: ChainHandle,
  artifact: Artifact,
  args: readonly unknown[] = [],
  account = roles.deployer,
): Promise<Address> => {
  const hash = await walletFor(handle, account).deployContract({
    abi: artifact.abi as Abi,
    bytecode: artifact.bytecode,
    args,
  })
  const receipt = await handle.publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`Deployment ${hash} failed`)
  return receipt.contractAddress
}

/**
 * Burns one deployer nonce so that later contracts get different addresses on chain B.
 * The token is the first transaction on both chains, so it keeps the same address.
 */
const separateAddressSpaces = async (handle: ChainHandle): Promise<void> => {
  const wallet = walletFor(handle, roles.deployer)
  const hash = await wallet.sendTransaction({ to: roles.deployer.address, value: 0n })
  await handle.publicClient.waitForTransactionReceipt({ hash })
}

const deployChain = async (
  handle: ChainHandle,
  trackedCommittee: Committee,
  initialPeriod: number,
): Promise<ChainDeployment> => {
  const token = await deployContract(handle, artifacts.token(), ['Mock Token', 'MOCK'])
  if (handle.name === 'chainB') await separateAddressSpaces(handle)
  const lightClient = await deployContract(handle, artifacts.lightClient(), [trackedCommittee.root, initialPeriod])
  const verifier = await deployContract(handle, artifacts.verifier(), [proverOracleAddress])
  const vault = await deployContract(handle, artifacts.vault(), [verifier, PROGRAM_VKEY, BigInt(handle.chainId), lightClient])
  return { handle, token, lightClient, verifier, vault }
}

/**
 * Deploys the bridge with the correct wiring (not the inverted wiring in `deploy.sh`, hole H-06).
 * The light client on chain A tracks chain B's committee. The light client on chain B tracks chain A's.
 * Deployer account 0 deploys `MockERC20` first on each chain, so the token has the same address on both.
 */
export const deployBridge = async (options: DeployBridgeOptions = {}): Promise<BridgeDeployment> => {
  const { initialPeriod = INITIAL_PERIOD } = options
  const committeeA = createCommittee(chainA.committeeLabel)
  const committeeB = createCommittee(chainB.committeeLabel)
  const [a, b] = await Promise.all([
    deployChain(chainA, committeeB, initialPeriod),
    deployChain(chainB, committeeA, initialPeriod),
  ])
  return { a, b, committeeA, committeeB }
}

/** Resets both chains to genesis and deploys a fresh bridge. Every test starts here. */
export const deployFreshBridge = async (options: DeployBridgeOptions = {}): Promise<BridgeDeployment> => {
  await resetBothChains()
  return deployBridge(options)
}
