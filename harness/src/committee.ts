import { concat, encodePacked, keccak256, type Address, type Hex } from 'viem'
import { privateKeyToAddress, sign } from 'viem/accounts'
import { COMMITTEE_SIZE, COMMITTEE_TREE_DEPTH, SIGNATURE_QUORUM } from './constants.js'

/** One committee member. */
export interface CommitteeMember {
  readonly privateKey: Hex
  readonly address: Address
  /** Position of the member in the Merkle tree. */
  readonly leafIndex: number
}

/** A committee of 512 keys with its sorted-pair Merkle tree. */
export interface Committee {
  readonly label: string
  /** Members in tree order. */
  readonly members: readonly CommitteeMember[]
  /** Members in ascending address order, the order that signatures must follow. */
  readonly membersByAddress: readonly CommitteeMember[]
  readonly root: Hex
  /** Merkle tree levels. Level 0 holds the leaves. The last level holds the root. */
  readonly levels: readonly (readonly Hex[])[]
}

/** A set of signatures with the Merkle proofs that go with them. */
export interface SignedAttestation {
  readonly signatures: readonly Hex[]
  readonly merkleProofs: readonly (readonly Hex[])[]
}

/**
 * Hashes two nodes the way OpenZeppelin `MerkleProof` does: smaller value first.
 */
export const hashSortedPair = (left: Hex, right: Hex): Hex =>
  BigInt(left) <= BigInt(right) ? keccak256(concat([left, right])) : keccak256(concat([right, left]))

/** Leaf hash of a committee member, as `LightClientSync` computes it. */
export const committeeLeaf = (address: Address): Hex => keccak256(encodePacked(['address'], [address]))

/** Private key of committee member `index`, as the build contract derives it. */
export const committeePrivateKey = (label: string, index: number): Hex =>
  keccak256(encodePacked(['string', 'string', 'uint256'], ['committee', label, BigInt(index)]))

/**
 * Checks a Merkle proof the way OpenZeppelin `MerkleProof.verify` does.
 */
export const verifyMerkleProof = (proof: readonly Hex[], root: Hex, leaf: Hex): boolean =>
  proof.reduce<Hex>((computed, sibling) => hashSortedPair(computed, sibling), leaf) === root

const buildLevels = (leaves: readonly Hex[]): readonly (readonly Hex[])[] => {
  const levels: Hex[][] = [[...leaves]]
  for (let depth = 0; depth < COMMITTEE_TREE_DEPTH; depth++) {
    const below = levels[depth]!
    const above: Hex[] = []
    for (let position = 0; position < below.length; position += 2) {
      above.push(hashSortedPair(below[position]!, below[position + 1]!))
    }
    levels.push(above)
  }
  return levels
}

const compareAddresses = (left: CommitteeMember, right: CommitteeMember) => {
  const difference = BigInt(left.address) - BigInt(right.address)
  return difference < 0n ? -1 : difference > 0n ? 1 : 0
}

const committeeCache = new Map<string, Committee>()

/**
 * Builds the committee for a label. The result is cached, because deriving 512 keys is slow.
 * The tree has 512 leaves, so every proof is nine hashes deep.
 */
export const createCommittee = (label: string): Committee => {
  const cached = committeeCache.get(label)
  if (cached) return cached
  const members = Array.from({ length: COMMITTEE_SIZE }, (_, leafIndex): CommitteeMember => {
    const privateKey = committeePrivateKey(label, leafIndex)
    return { privateKey, address: privateKeyToAddress(privateKey), leafIndex }
  })
  const levels = buildLevels(members.map((member) => committeeLeaf(member.address)))
  const committee: Committee = {
    label,
    members,
    membersByAddress: [...members].sort(compareAddresses),
    root: levels[COMMITTEE_TREE_DEPTH]![0]!,
    levels,
  }
  committeeCache.set(label, committee)
  return committee
}

/** Merkle proof for the leaf at `leafIndex`. */
export const merkleProofFor = (committee: Committee, leafIndex: number): readonly Hex[] =>
  Array.from({ length: COMMITTEE_TREE_DEPTH }, (_, depth) => {
    const position = leafIndex >> depth
    return committee.levels[depth]![position ^ 1]!
  })

/** The digest that committee members sign: `keccak256(abi.encodePacked(attestedHeader, period))`. */
export const signingRootFor = (attestedHeader: Hex, period: number): Hex =>
  keccak256(encodePacked(['bytes32', 'uint32'], [attestedHeader, period]))

/** Options for `attest`. */
export interface AttestOptions {
  readonly committee: Committee
  readonly attestedHeader: Hex
  readonly period: number
  /** How many members sign. Defaults to the quorum of 342. */
  readonly signerCount?: number
}

/**
 * Signs the raw `signingRoot` with the first `signerCount` members by ascending address.
 * Signatures and proofs come back in the order that `updateSyncState` requires.
 */
export const attest = async (options: AttestOptions): Promise<SignedAttestation> => {
  const { committee, attestedHeader, period, signerCount = SIGNATURE_QUORUM } = options
  const hash = signingRootFor(attestedHeader, period)
  const signers = committee.membersByAddress.slice(0, signerCount)
  const signatures = await Promise.all(signers.map((member) => sign({ hash, privateKey: member.privateKey, to: 'hex' })))
  return {
    signatures,
    merkleProofs: signers.map((member) => merkleProofFor(committee, member.leafIndex)),
  }
}
