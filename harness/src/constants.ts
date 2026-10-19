import { keccak256, stringToBytes, toEventSelector } from 'viem'

/** Chain A plays the Ethereum role. */
export const CHAIN_A_ID = 1
/** Chain B plays the PulseChain role. */
export const CHAIN_B_ID = 369

export const CHAIN_A_PORT = 18545
export const CHAIN_B_PORT = 18546

/** The default mnemonic of Anvil. Every key derived from it is public knowledge. */
export const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk'

/** Number of committee keys in each light client committee. */
export const COMMITTEE_SIZE = 512
/** Smallest signature count that `LightClientSync` accepts. */
export const SIGNATURE_QUORUM = 342
/** Depth of the sorted-pair Merkle tree over 512 leaves. */
export const COMMITTEE_TREE_DEPTH = 9

/** The period that every `LightClientSync` starts in. */
export const INITIAL_PERIOD = 1

/** Fixed fingerprint of the circuit that the specification describes. */
export const PROGRAM_VKEY = keccak256(stringToBytes('spec-circuit'))

/** Topic 0 of the vault event `DepositInitiated`. */
export const DEPOSIT_INITIATED_TOPIC = toEventSelector(
  'DepositInitiated(address,address,address,uint256,bytes32,uint64)',
)

/** The all-zero 32-byte value. */
export const ZERO_HASH = `0x${'00'.repeat(32)}` as const
