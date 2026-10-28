/**
 * Fork evidence for the deposit gate of a local chain, which has no beacon node of its own.
 *
 * The gate reads a beacon block root from the EIP-4788 contract and checks two branches from a beacon state to the state
 * root of that block: one from the fork version leaf and one from the genesis validators root leaf, which pins the shape. On Anvil nothing writes the roots, so this module builds a small beacon state
 * (32 fields, `Fork` at field 3) with the supported version, a header over it, and writes the header root into the ring
 * buffer of the contract with `anvil_setStorageAt`, under the time of the latest block. The gate then accepts the
 * evidence for the current epoch. The tree is real SSZ (Simple Serialize) hashing: only the other 31 fields are filler.
 * SYNTHETIC: no beacon chain stands behind it. The gate code that checks it is the real one.
 */
import { concatHex, encodeAbiParameters, hexToBytes, numberToHex, padHex, sha256, toHex, type Address, type Hex } from "viem";

/** The length of the ring buffer of the beacon roots contract: `timestamp % 8191` is the position of an entry. */
export const RING_LENGTH = 8191n;
/** The number of fields of the synthetic beacon state at depth 5. */
const STATE_LEAVES = 32;
/** The index of the `fork` field of a `BeaconState`. */
const FORK_FIELD = 3;
/** The index of the `genesis_validators_root` field of a `BeaconState`. */
const GENESIS_VALIDATORS_ROOT_FIELD = 1;

const ZERO: Hex = `0x${"00".repeat(32)}`;

/** The SHA-256 of two chunks, as the SSZ tree hashes a node. */
export const hashPair = (left: Hex, right: Hex): Hex => sha256(concatHex([left, right]));

/** A little endian `uint64` as a 32 byte chunk. */
const uint64Chunk = (value: bigint): Hex => {
  const bytes = hexToBytes(padHex(numberToHex(value), { size: 8 }));
  return padHex(toHex(bytes.reverse()), { size: 32, dir: "right" });
};

/** The beacon block header that the gate hashes. */
export interface Header {
  readonly slot: bigint;
  readonly proposerIndex: bigint;
  readonly parentRoot: Hex;
  readonly stateRoot: Hex;
  readonly bodyRoot: Hex;
}

/** The hash tree root of a header: five chunks, padded to eight. */
export const headerRoot = (header: Header): Hex => {
  const chunks: Hex[] = [uint64Chunk(header.slot), uint64Chunk(header.proposerIndex), header.parentRoot, header.stateRoot, header.bodyRoot];
  while (chunks.length < 8) chunks.push(ZERO);
  const level1 = [hashPair(chunks[0]!, chunks[1]!), hashPair(chunks[2]!, chunks[3]!), hashPair(chunks[4]!, chunks[5]!), hashPair(chunks[6]!, chunks[7]!)];
  return hashPair(hashPair(level1[0]!, level1[1]!), hashPair(level1[2]!, level1[3]!));
};

/** The siblings of the leaf at `index` of a full binary tree, deepest first, and the root. */
export const branchOf = (leaves: readonly Hex[], index: number): { readonly branch: readonly Hex[]; readonly root: Hex } => {
  let level = [...leaves];
  let position = index;
  const branch: Hex[] = [];
  while (level.length > 1) {
    branch.push(level[position ^ 1]!);
    level = Array.from({ length: level.length / 2 }, (_, pair) => hashPair(level[2 * pair]!, level[2 * pair + 1]!));
    position >>= 1;
  }
  return { branch, root: level[0]! };
};

/** True when the branch leads from the leaf to the root. `generalizedIndex` is the index of the leaf in the tree. */
export const isValidBranch = (leaf: Hex, branch: readonly Hex[], generalizedIndex: bigint, root: Hex): boolean => {
  let node = leaf;
  let index = generalizedIndex;
  for (const sibling of branch) {
    node = index % 2n === 1n ? hashPair(sibling, node) : hashPair(node, sibling);
    index >>= 1n;
  }
  return index === 1n && node === root;
};

/** The state, the branch of its version leaf and the root. */
export interface ForkState {
  readonly stateRoot: Hex;
  /** From the version leaf to the state root, deepest first: two entries inside `Fork`, five inside the state. */
  readonly branch: readonly Hex[];
  /** From the genesis validators root leaf to the state root, deepest first: five entries. */
  readonly genesisValidatorsRootBranch: readonly Hex[];
}

/** Builds a state of depth 5 whose `Fork.current_version` is `version` and whose genesis validators root is `genesisValidatorsRoot`. */
export const forkState = (version: Hex, previousVersion: Hex, epoch: bigint, genesisValidatorsRoot: Hex): ForkState => {
  const versionLeaf = padHex(version, { size: 32, dir: "right" });
  const previousLeaf = padHex(previousVersion, { size: 32, dir: "right" });
  const forkLeaves = [previousLeaf, versionLeaf, uint64Chunk(epoch), ZERO];
  const fork = branchOf(forkLeaves, 1);
  const stateLeaves = Array.from({ length: STATE_LEAVES }, (_, field) => (field === FORK_FIELD ? fork.root : field === GENESIS_VALIDATORS_ROOT_FIELD ? genesisValidatorsRoot : sha256(toHex(`state field ${field}`))));
  const state = branchOf(stateLeaves, FORK_FIELD);
  const rootBranch = branchOf(stateLeaves, GENESIS_VALIDATORS_ROOT_FIELD);
  return { stateRoot: state.root, branch: [...fork.branch, ...state.branch], genesisValidatorsRootBranch: rootBranch.branch };
};

/** The generalized index of `Fork.current_version` in a state of depth 5: `((2**5 + 3) * 4) + 1`. */
export const VERSION_GENERALIZED_INDEX = BigInt((2 ** 5 + FORK_FIELD) * 4 + 1);

/** The generalized index of `genesis_validators_root` in a state of depth 5: `2**5 + 1`. */
export const GENESIS_VALIDATORS_ROOT_GENERALIZED_INDEX = BigInt(2 ** 5 + GENESIS_VALIDATORS_ROOT_FIELD);

/** The ABI type of the evidence that `BeaconForkGate.confirm` decodes. */
const EVIDENCE_TYPE = [
  {
    type: "tuple",
    components: [
      { name: "timestamp", type: "uint256" },
      {
        name: "header",
        type: "tuple",
        components: [
          { name: "slot", type: "uint64" },
          { name: "proposerIndex", type: "uint64" },
          { name: "parentRoot", type: "bytes32" },
          { name: "stateRoot", type: "bytes32" },
          { name: "bodyRoot", type: "bytes32" },
        ],
      },
      { name: "version", type: "bytes4" },
      { name: "branch", type: "bytes32[]" },
      { name: "genesisValidatorsRootBranch", type: "bytes32[]" },
    ],
  },
] as const;

/** What the builder needs from the chain and the gate. */
export interface GateEvidenceInput {
  /** The time of the latest block. The gate reads the beacon root under this time. */
  readonly timestamp: bigint;
  /** The `genesisTime` of the gate. */
  readonly genesisTime: bigint;
  readonly secondsPerSlot: bigint;
  readonly slotsPerEpoch: bigint;
  /** A fork version to claim. The gate proves it but does not judge its name. */
  readonly version: Hex;
  /** The `genesisValidatorsRoot` of the gate. */
  readonly genesisValidatorsRoot: Hex;
}

/** The evidence, the root to write into the ring buffer and the epoch that the header lies in. */
export interface GateEvidence {
  readonly encoded: Hex;
  readonly beaconRoot: Hex;
  readonly timestamp: bigint;
  readonly epoch: bigint;
  /** The two storage writes that put the root into the beacon roots contract. */
  readonly storageWrites: readonly { readonly slot: Hex; readonly value: Hex }[];
}

/**
 * Builds the evidence for the epoch of `timestamp`.
 *
 * @throws Error when the time lies before the genesis time of the gate.
 */
export const buildGateEvidence = (input: GateEvidenceInput): GateEvidence => {
  if (input.timestamp < input.genesisTime) throw new Error("the latest block lies before the genesis time of the gate");
  const slot = (input.timestamp - input.genesisTime) / input.secondsPerSlot;
  const state = forkState(input.version, "0x00000000", slot / input.slotsPerEpoch, input.genesisValidatorsRoot);
  const header: Header = {
    slot,
    proposerIndex: 7n,
    parentRoot: sha256(toHex(`parent of ${slot}`)),
    stateRoot: state.stateRoot,
    bodyRoot: sha256(toHex(`body of ${slot}`)),
  };
  const beaconRoot = headerRoot(header);
  const position = input.timestamp % RING_LENGTH;
  const word = (value: bigint): Hex => padHex(numberToHex(value), { size: 32 });
  const encoded = encodeAbiParameters(EVIDENCE_TYPE, [{ timestamp: input.timestamp, header, version: input.version, branch: [...state.branch], genesisValidatorsRootBranch: [...state.genesisValidatorsRootBranch] }]);
  return {
    encoded,
    beaconRoot,
    timestamp: input.timestamp,
    epoch: slot / input.slotsPerEpoch,
    storageWrites: [
      { slot: word(position), value: word(input.timestamp) },
      { slot: word(position + RING_LENGTH), value: beaconRoot },
    ],
  };
};

/** The address type of the beacon roots contract, for the callers. */
export type BeaconRootsAddress = Address;
