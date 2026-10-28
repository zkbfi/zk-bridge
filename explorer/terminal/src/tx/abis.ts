/**
 * The contract functions that the dashboard calls or reads, as small human-readable ABI fragments.
 *
 * The full generated ABIs live in `explorer/shared`. The delivery router ABI is re-exported from there whole. The other
 * ABIs are small fragments with only what the terminal needs. `test/tx/abis.test.ts` checks every fragment against the
 * shared ABIs and the Foundry build output, so a contract change that breaks a selector fails a test.
 */
import { parseAbi } from 'viem'

/** The token mediator: relays and the views that the dashboard reads. */
export const tokenMediatorAbi = parseAbi([
  'function relayTokens(address token, address receiver, uint256 value)',
  'function relayTokens(address token, uint256 value)',
  'function relayTokens(address token, address receiver, uint256 value, uint256 gasLimit)',
  'function relayTokensAndCall(address token, address receiver, uint256 value, bytes data)',
  'function relayTokensAndCall(address token, address receiver, uint256 value, bytes data, uint256 gasLimit)',
  'function mediatorBalance(address token) view returns (uint256)',
  'function bridgedTokenAddress(address nativeToken) view returns (address)',
  'function nativeTokenAddress(address bridgedToken) view returns (address)',
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

/**
 * The delivery router, exactly as the compiled contract describes it: its functions, its events (`DeliveryFailed`,
 * `Swept`, `HandOffRefused` and `CallFailed`) and its errors. It comes from the generated ABI in `explorer/shared`, so
 * a change of the Solidity interface reaches the terminal when that ABI is generated again, and no second copy can drift.
 */
export { deliveryRouterAbi } from '@zk-bridge/shared'

/** The light client: post an update and read the stored head. */
export const beaconLightClientAbi = parseAbi([
  'function update(bytes proof, bytes publicValues)',
  'function head() view returns (uint64)',
])

/** Every ABI that the dashboard can decode a transaction with. */
export const knownAbis = [
  tokenMediatorAbi,
  messageBridgeAbi,
  beaconLightClientAbi,
] as const
