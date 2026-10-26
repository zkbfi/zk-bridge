/**
 * The contract functions that the dashboard calls or reads, as small human-readable ABI fragments.
 *
 * The full generated ABIs live in `explorer/shared`. These fragments hold only what the terminal needs, so the
 * terminal builds without the shared package. `test/tx/abis.test.ts` checks every fragment against the shared ABIs
 * and the Foundry build output, so a contract change that breaks a selector fails a test.
 */
import { parseAbi } from 'viem'

/** The token mediator: relays, claims and the views that the dashboard reads. */
export const tokenMediatorAbi = parseAbi([
  'function relayTokens(address token, address receiver, uint256 value)',
  'function relayTokens(address token, uint256 value)',
  'function relayTokensAndCall(address token, address receiver, uint256 value, bytes data)',
  'function relayTokensWithFallback(address token, address receiver, uint256 value, bytes data, address fallbackRecipient)',
  'function claim(address token, address account)',
  'function currentFeeRate() view returns (uint256)',
  'function claimable(address token, address account) view returns (uint256)',
  'function mediatorBalance(address token) view returns (uint256)',
  'function accruedFees(address token) view returns (uint256)',
  'function bridgedTokenAddress(address nativeToken) view returns (address)',
  'function nativeTokenAddress(address bridgedToken) view returns (address)',
])

/** The router that wraps the native coin and relays it. */
export const wrappedNativeRouterAbi = parseAbi([
  'function wrapAndRelayTokens() payable',
  'function wrapAndRelayTokens(address receiver) payable',
])

/** The shared structures of the message bridge. */
const messageBridgeStructures = [
  'struct BeaconBlockHeader { uint64 slot; uint64 proposerIndex; bytes32 parentRoot; bytes32 stateRoot; bytes32 bodyRoot; }',
  'struct MessageProof { BeaconBlockHeader anchorHeader; BeaconBlockHeader sourceHeader; bytes32[] ancestryBranch; bytes32[] blockHashBranch; bytes executionHeaderRlp; bytes[] receiptProof; uint256 receiptIndex; bytes[] transactionProof; uint256 transactionIndex; uint256 logIndex; }',
  'struct BlockRootsEvidence { BeaconBlockHeader laterHeader; uint64 earlierSlotA; uint64 earlierSlotB; bytes32[] branchA; bytes32[] branchB; }',
  'struct BlockHashEvidence { BeaconBlockHeader header; bytes32[] branch; }',
  'struct HistoricalSummariesEvidence { BeaconBlockHeader anchorHeader; uint64 earlierSlot; bytes32[] branch; }',
] as const

/** The message bridge: send a message, execute a message with evidence, and add layout rows. */
export const messageBridgeAbi = parseAbi([
  ...messageBridgeStructures,
  'function requireToPassMessage(address target, bytes data, uint256 gas) returns (bytes32)',
  'function executeMessage(MessageProof proof)',
  'function addBlockRootsLayout(uint256 blockRootsGindex, BlockRootsEvidence evidence)',
  'function addBlockHashLayout(uint256 blockHashGindex, BlockHashEvidence evidence)',
  'function addHistoricalSummariesLayout(uint256 historicalSummariesGindex, HistoricalSummariesEvidence evidence)',
  'function maxGasPerTx() pure returns (uint256)',
])

/** The light client: post an update and read the stored head. */
export const beaconLightClientAbi = parseAbi([
  'function update(bytes proof, bytes publicValues)',
  'function head() view returns (uint64)',
])

/** The public values that the light client program outputs, in `abi.encode` order. */
export const lightClientOutputParameters = [
  { name: 'genesisValidatorsRoot', type: 'bytes32' },
  { name: 'previousHeaderRoot', type: 'bytes32' },
  { name: 'previousHeadSlot', type: 'uint64' },
  { name: 'previousSyncCommitteeHash', type: 'bytes32' },
  { name: 'startNextSyncCommitteeHash', type: 'bytes32' },
  { name: 'newHeaderRoot', type: 'bytes32' },
  { name: 'newHeadSlot', type: 'uint64' },
  { name: 'executionBlockHash', type: 'bytes32' },
  { name: 'executionBlockNumber', type: 'uint64' },
  { name: 'syncCommitteeHash', type: 'bytes32' },
  { name: 'nextSyncCommitteeHash', type: 'bytes32' },
] as const

/** The byte length of the encoded light client output: eleven static words. */
export const LIGHT_CLIENT_OUTPUT_LENGTH = 352

/** Every ABI that the dashboard can decode a transaction with. */
export const knownAbis = [
  tokenMediatorAbi,
  wrappedNativeRouterAbi,
  messageBridgeAbi,
  beaconLightClientAbi,
] as const
