/**
 * The fork evidence of the deposit gate (`BeaconForkGate`), as pure functions: the SSZ (Simple Serialize) hashing that the
 * gate does, the rule that judges the shape of the state (a port of `ForkShape.judge`), the checks of `confirm` in the
 * order the contract runs them, the compact multiproof that a beacon node serves, and the ABI encoding of the evidence.
 *
 * A send on a chain whose gate enforces passes only in an epoch that someone confirmed. `confirm(evidence)` takes a beacon
 * block header whose root the EIP-4788 contract holds for a timestamp, and two branches under the state root of that header:
 * one of `fork.current_version` and one of `genesis_validators_root`. The gate computes the positions from the shape and
 * never takes them from the caller. These functions do the same, so evidence that passes {@link checkConfirmEvidence}
 * passes the contract, given the same beacon root and the same epoch. No I/O: the reads are in `@zkb/data`.
 */
import { concatHex, decodeAbiParameters, encodeAbiParameters, encodeFunctionData, hexToBytes, numberToHex, padHex, sha256, toHex, type Address, type Hex } from "viem";

/** The EIP-4788 beacon roots contract, on every chain that has it. */
export const BEACON_ROOTS_ADDRESS: Address = "0x000f3df6d732807ef1319fb7b8bb8522d0beac02";

/** The marker of the progressive `BeaconState` (Gloas on), as `ForkShape.PROGRESSIVE`. */
export const PROGRESSIVE_SHAPE = 255;

/** The allowed shapes, in the order in which the gate tries them (`ForkShape.allowedShapes`): plain depths, then progressive. */
export const ALLOWED_SHAPES: readonly number[] = [5, 6, 7, PROGRESSIVE_SHAPE];

/** The depth of the three field `Fork` container. */
const FORK_DEPTH = 2;
/** The position of `fork` among the `BeaconState` fields. */
const FORK_FIELD_INDEX = 3n;
/** The position of `genesis_validators_root` among the `BeaconState` fields. */
const GENESIS_VALIDATORS_ROOT_FIELD_INDEX = 1n;
/** `fork.current_version` in the progressive state: node 42 times 4, plus 1. */
const PROGRESSIVE_VERSION_GINDEX = 169n;
/** `genesis_validators_root` in the progressive state. */
const PROGRESSIVE_GENESIS_VALIDATORS_ROOT_GINDEX = 40n;
const PROGRESSIVE_VERSION_LENGTH = 7;
const PROGRESSIVE_GENESIS_VALIDATORS_ROOT_LENGTH = 5;

const ZERO_CHUNK: Hex = `0x${"00".repeat(32)}`;

/** Whether a shape is in the allowed set (`ForkShape.isAllowed`). */
export const isAllowedShape = (shape: number): boolean => ALLOWED_SHAPES.includes(shape);

/** The generalized index of `fork.current_version` in a plain tree of a depth (`ForkShape.plainVersionGindex`). */
export const plainVersionGindex = (depth: number): bigint => (((1n << BigInt(depth)) + FORK_FIELD_INDEX) * 4n) + 1n;

/** The generalized index of `fork.current_version` for a shape (`ForkShape.versionGindex`). */
export const versionGindex = (shape: number): bigint => (shape === PROGRESSIVE_SHAPE ? PROGRESSIVE_VERSION_GINDEX : plainVersionGindex(shape));

/** The generalized index of `genesis_validators_root` for a shape (`ForkShape.genesisValidatorsRootGindex`). */
export const genesisValidatorsRootGindex = (shape: number): bigint =>
  shape === PROGRESSIVE_SHAPE ? PROGRESSIVE_GENESIS_VALIDATORS_ROOT_GINDEX : (1n << BigInt(shape)) + GENESIS_VALIDATORS_ROOT_FIELD_INDEX;

/** The number of entries in the version branch of a shape. */
export const versionBranchLength = (shape: number): number => (shape === PROGRESSIVE_SHAPE ? PROGRESSIVE_VERSION_LENGTH : shape + FORK_DEPTH);

/** The number of entries in the genesis validators root branch of a shape. */
export const genesisValidatorsRootBranchLength = (shape: number): number => (shape === PROGRESSIVE_SHAPE ? PROGRESSIVE_GENESIS_VALIDATORS_ROOT_LENGTH : shape);

/** The tree depth that a version branch length implies, or zero below the `Fork` depth (`ForkShape.depthOfVersionBranch`). */
export const depthOfVersionBranch = (length: number): number => (length < FORK_DEPTH ? 0 : length - FORK_DEPTH);

/** The SHA-256 of two chunks, as SSZ hashes a node. */
export const hashPair = (left: Hex, right: Hex): Hex => sha256(concatHex([left, right]));

/** A little endian `uint64` in a 32 byte chunk. */
const uint64Chunk = (value: bigint): Hex => padHex(toHex(hexToBytes(padHex(numberToHex(value), { size: 8 })).reverse()), { size: 32, dir: "right" });

/** A beacon block header, as the gate hashes it. */
export interface BeaconBlockHeader {
  readonly slot: bigint;
  readonly proposerIndex: bigint;
  readonly parentRoot: Hex;
  readonly stateRoot: Hex;
  readonly bodyRoot: Hex;
}

/** The hash tree root of a header: five chunks, padded to eight (`SSZ.hashTreeRootMemory`). */
export const beaconHeaderRoot = (header: BeaconBlockHeader): Hex =>
  hashPair(
    hashPair(hashPair(uint64Chunk(header.slot), uint64Chunk(header.proposerIndex)), hashPair(header.parentRoot, header.stateRoot)),
    hashPair(hashPair(header.bodyRoot, ZERO_CHUNK), hashPair(ZERO_CHUNK, ZERO_CHUNK)),
  );

/** The depth of a generalized index: the number of bits below the leading one. */
const depthOfGindex = (gindex: bigint): number => gindex.toString(2).length - 1;

/**
 * Whether `leaf` sits at `gindex` under `root`, given the siblings from the leaf up, deepest first (`SSZ.isValidBranchMemory`).
 * A branch whose length is not the depth of the index is false (the contract reverts there; the gate never reaches it,
 * because it checks the lengths first).
 */
export const isValidBranch = (leaf: Hex, branch: readonly Hex[], gindex: bigint, root: Hex): boolean => {
  if (gindex < 1n || branch.length !== depthOfGindex(gindex)) return false;
  let node = leaf;
  branch.forEach((sibling, level) => {
    node = (gindex >> BigInt(level)) & 1n ? hashPair(sibling, node) : hashPair(node, sibling);
  });
  return node.toLowerCase() === root.toLowerCase();
};

/** A fork version (4 bytes) as the 32 byte leaf that the gate checks: `bytes32(version)`, padded right. */
export const versionLeaf = (version: Hex): Hex => padHex(version, { size: 32, dir: "right" });

/** The verdict of {@link judgeForkEvidence}, as `ForkShape.Verdict`. */
export type ForkVerdict = "Allowed" | "VersionProofInvalid" | "GenesisValidatorsRootProofInvalid" | "ShapeNotAllowed";

/**
 * Judges the evidence of the EIP-4788 path, as `ForkShape.judge`: each allowed shape whose version branch length fits is
 * tried in order; the first for which both branches verify is the shape.
 *
 * @returns The verdict, and the shape when the verdict is `Allowed` (else 0).
 */
export const judgeForkEvidence = (input: {
  readonly stateRoot: Hex;
  readonly version: Hex;
  readonly branch: readonly Hex[];
  readonly genesisValidatorsRootBranch: readonly Hex[];
  readonly genesisValidatorsRoot: Hex;
}): { readonly verdict: ForkVerdict; readonly shape: number } => {
  let anyCandidate = false;
  let versionProven = false;
  for (const shape of ALLOWED_SHAPES) {
    if (input.branch.length !== versionBranchLength(shape)) continue;
    anyCandidate = true;
    if (!isValidBranch(versionLeaf(input.version), input.branch, versionGindex(shape), input.stateRoot)) continue;
    versionProven = true;
    if (
      input.genesisValidatorsRootBranch.length === genesisValidatorsRootBranchLength(shape) &&
      isValidBranch(input.genesisValidatorsRoot, input.genesisValidatorsRootBranch, genesisValidatorsRootGindex(shape), input.stateRoot)
    ) {
      return { verdict: "Allowed", shape };
    }
  }
  if (!anyCandidate) return { verdict: "ShapeNotAllowed", shape: 0 };
  return { verdict: versionProven ? "GenesisValidatorsRootProofInvalid" : "VersionProofInvalid", shape: 0 };
};

/** The beacon clock of a gate: its immutables `genesisTime`, `secondsPerSlot` and `slotsPerEpoch`. */
export interface BeaconClock {
  readonly genesisTime: bigint;
  readonly secondsPerSlot: bigint;
  readonly slotsPerEpoch: bigint;
}

/**
 * The epoch of a block time, as the gate counts it (`_currentEpoch`).
 *
 * @throws Error before the genesis time (the gate reverts `BeforeGenesis`).
 */
export const gateEpochAt = (timestamp: bigint, clock: BeaconClock): bigint => {
  if (timestamp < clock.genesisTime) throw new Error(`the time ${timestamp} lies before the genesis time ${clock.genesisTime} of the gate`);
  return (timestamp - clock.genesisTime) / clock.secondsPerSlot / clock.slotsPerEpoch;
};

/** The first second of the epoch after `epoch`: a confirmation of `epoch` must land in a block before this time. */
export const gateEpochEnd = (epoch: bigint, clock: BeaconClock): bigint => clock.genesisTime + (epoch + 1n) * clock.slotsPerEpoch * clock.secondsPerSlot;

/** The proof that the chain is in a fork version: the `ForkEvidence` struct of the gate. */
export interface ForkEvidence {
  /** The timestamp key of the beacon roots contract: the time of the execution block that holds the header root. */
  readonly timestamp: bigint;
  readonly header: BeaconBlockHeader;
  /** `fork.current_version`, 4 bytes. */
  readonly version: Hex;
  /** From the version leaf to `header.stateRoot`, deepest first. */
  readonly branch: readonly Hex[];
  /** From `genesis_validators_root` to `header.stateRoot`, deepest first. */
  readonly genesisValidatorsRootBranch: readonly Hex[];
}

/** The ABI type of `ForkEvidence`, which `confirm`, `admit` and `seal` decode from their `bytes` argument. */
export const FORK_EVIDENCE_ABI = [
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

/** `BeaconForkGate.confirm(bytes evidence)`. */
const CONFIRM_ABI = [{ type: "function", name: "confirm", inputs: [{ name: "evidence", type: "bytes" }], outputs: [], stateMutability: "nonpayable" }] as const;

/** `abi.encode(ForkEvidence)`: the `bytes` that `confirm` takes. */
export const encodeForkEvidence = (evidence: ForkEvidence): Hex =>
  encodeAbiParameters(FORK_EVIDENCE_ABI, [{ ...evidence, branch: [...evidence.branch], genesisValidatorsRootBranch: [...evidence.genesisValidatorsRootBranch] }]);

/** The reverse of {@link encodeForkEvidence}. @throws when the bytes do not decode. */
export const decodeForkEvidence = (encoded: Hex): ForkEvidence => {
  const [decoded] = decodeAbiParameters(FORK_EVIDENCE_ABI, encoded);
  return decoded;
};

/** The calldata of `confirm(abi.encode(evidence))`. */
export const confirmCalldata = (evidence: ForkEvidence): Hex => encodeFunctionData({ abi: CONFIRM_ABI, functionName: "confirm", args: [encodeForkEvidence(evidence)] });

/** The errors of `confirm` that the evidence can cause, by their name in the gate. */
export type ConfirmRefusal =
  | "BeaconRootUnavailable"
  | "HeaderRootMismatch"
  | "HeaderNotInCurrentEpoch"
  | "GenesisValidatorsRootBranchInvalid"
  | "ForkProofInvalid"
  | "ShapeNotAllowed";

/** The answer of {@link checkConfirmEvidence}. */
export type ConfirmCheck = { readonly ok: true; readonly shape: number } | { readonly ok: false; readonly error: ConfirmRefusal; readonly detail: string };

/**
 * The checks of `confirm` on the evidence, in the order of the contract (`_requireBeaconHeader`, the epoch rule,
 * `_requireAllowedShapeProven`). The caller supplies what the contract reads from the chain.
 *
 * @param input.beaconRoot What the beacon roots contract returns for `evidence.timestamp`; zero when it returns nothing.
 * @param input.epoch The epoch of the block that the confirmation lands in.
 * @param input.slotsPerEpoch The `slotsPerEpoch` of the gate.
 * @param input.genesisValidatorsRoot The `genesisValidatorsRoot` of the gate.
 */
export const checkConfirmEvidence = (input: {
  readonly evidence: ForkEvidence;
  readonly beaconRoot: Hex;
  readonly epoch: bigint;
  readonly slotsPerEpoch: bigint;
  readonly genesisValidatorsRoot: Hex;
}): ConfirmCheck => {
  const { evidence } = input;
  if (BigInt(input.beaconRoot) === 0n) return { ok: false, error: "BeaconRootUnavailable", detail: `no beacon root for the time ${evidence.timestamp}` };
  const headerRoot = beaconHeaderRoot(evidence.header);
  if (headerRoot.toLowerCase() !== input.beaconRoot.toLowerCase()) {
    return { ok: false, error: "HeaderRootMismatch", detail: `the header hashes to ${headerRoot}, the beacon roots contract holds ${input.beaconRoot}` };
  }
  const headerEpoch = evidence.header.slot / input.slotsPerEpoch;
  if (headerEpoch !== input.epoch) return { ok: false, error: "HeaderNotInCurrentEpoch", detail: `the header is in epoch ${headerEpoch}, the block in epoch ${input.epoch}` };
  const { verdict, shape } = judgeForkEvidence({ ...evidence, stateRoot: evidence.header.stateRoot, genesisValidatorsRoot: input.genesisValidatorsRoot });
  if (verdict === "Allowed") return { ok: true, shape };
  if (verdict === "GenesisValidatorsRootProofInvalid") return { ok: false, error: "GenesisValidatorsRootBranchInvalid", detail: "the genesis validators root branch does not verify" };
  if (verdict === "VersionProofInvalid") return { ok: false, error: "ForkProofInvalid", detail: "the version branch does not verify at any allowed shape" };
  return { ok: false, error: "ShapeNotAllowed", detail: `a version branch of ${evidence.branch.length} entries implies depth ${depthOfVersionBranch(evidence.branch.length)}` };
};

// ------------------------------------------------------------------ compact multiproofs

/** The bits of a byte string, most significant first. */
const bitsOf = (bytes: Uint8Array): number[] => [...bytes].flatMap((byte) => Array.from({ length: 8 }, (_, bit) => (byte >> (7 - bit)) & 1));

/**
 * The descriptor of a compact multiproof for some leaves: the nodes of the smallest tree that holds them, in depth first
 * order (left before right), 0 for a node whose children follow and 1 for a node that the proof gives, padded with zeros
 * to whole bytes. This is the format of the `/eth/v0/beacon/proof/state/{state_id}?format=<descriptor>` endpoint of
 * Lodestar.
 *
 * @throws Error for an empty list or an index below 1.
 */
export const compactMultiproofDescriptor = (gindices: readonly bigint[]): Hex => {
  if (gindices.length === 0 || gindices.some((gindex) => gindex < 1n)) throw new Error("a multiproof needs leaves with generalized indices of 1 or more");
  const onPath = (node: bigint): boolean =>
    gindices.some((leaf) => {
      for (let at = leaf; at >= node; at >>= 1n) if (at === node) return true;
      return false;
    });
  const bits: number[] = [];
  const visit = (node: bigint): void => {
    if (gindices.includes(node) || !onPath(node)) {
      bits.push(1);
      return;
    }
    bits.push(0);
    visit(2n * node);
    visit(2n * node + 1n);
  };
  visit(1n);
  while (bits.length % 8 !== 0) bits.push(0);
  const bytes = Uint8Array.from({ length: bits.length / 8 }, (_, index) => bits.slice(index * 8, index * 8 + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
  return toHex(bytes);
};

/**
 * Rebuilds the tree of a compact multiproof: every node that the proof gives or implies, by generalized index, and the root.
 *
 * @throws Error when the descriptor and the leaves do not form one tree (bits run out, leaves are left over or missing,
 * or the padding holds a one).
 */
export const compactMultiproofNodes = (descriptor: Hex, leaves: readonly Hex[]): { readonly root: Hex; readonly nodes: ReadonlyMap<bigint, Hex> } => {
  const bits = bitsOf(hexToBytes(descriptor));
  const nodes = new Map<bigint, Hex>();
  let bit = 0;
  let leaf = 0;
  const build = (gindex: bigint): Hex => {
    if (bit >= bits.length) throw new Error("the multiproof descriptor ends inside the tree");
    let node: Hex;
    if (bits[bit++] === 1) {
      const given = leaves[leaf++];
      if (given === undefined) throw new Error("the multiproof has fewer leaves than its descriptor");
      node = given.toLowerCase() as Hex;
    } else {
      const left = build(2n * gindex);
      node = hashPair(left, build(2n * gindex + 1n));
    }
    nodes.set(gindex, node);
    return node;
  };
  const root = build(1n);
  if (leaf !== leaves.length) throw new Error("the multiproof has more leaves than its descriptor");
  if (bits.length - bit >= 8 || bits.slice(bit).includes(1)) throw new Error("the multiproof descriptor has bits after the tree");
  return { root, nodes };
};

/**
 * The leaf at a generalized index and its branch, deepest first, from the nodes of a multiproof.
 *
 * @throws Error when the tree lacks the leaf or a sibling.
 */
export const branchFromNodes = (nodes: ReadonlyMap<bigint, Hex>, gindex: bigint): { readonly leaf: Hex; readonly branch: readonly Hex[] } => {
  const leaf = nodes.get(gindex);
  if (leaf === undefined) throw new Error(`the multiproof has no node ${gindex}`);
  const branch: Hex[] = [];
  for (let at = gindex; at > 1n; at >>= 1n) {
    const sibling = nodes.get(at ^ 1n);
    if (sibling === undefined) throw new Error(`the multiproof has no sibling ${at ^ 1n} of node ${at}`);
    branch.push(sibling);
  }
  return { leaf, branch };
};

/** The two leaves that the evidence of a shape proves: the version, then the genesis validators root. */
export const forkProofGindices = (shape: number): readonly [bigint, bigint] => [versionGindex(shape), genesisValidatorsRootGindex(shape)];

/**
 * The evidence of a shape from a compact multiproof of a state.
 *
 * @param input.timestamp The time of the execution block whose beacon root is the root of `header`.
 * @param input.header The header whose state the multiproof covers.
 * @param input.shape The shape whose two leaves the multiproof holds.
 * @throws Error when the multiproof does not hash to `header.stateRoot`, lacks a node, or its version leaf is not a
 * 4 byte value padded with zeros.
 */
export const forkEvidenceFromMultiproof = (input: {
  readonly timestamp: bigint;
  readonly header: BeaconBlockHeader;
  readonly shape: number;
  readonly descriptor: Hex;
  readonly leaves: readonly Hex[];
}): ForkEvidence => {
  const { root, nodes } = compactMultiproofNodes(input.descriptor, input.leaves);
  if (root !== input.header.stateRoot.toLowerCase()) throw new Error(`the multiproof hashes to ${root}, not to the state root ${input.header.stateRoot}`);
  const [versionAt, rootAt] = forkProofGindices(input.shape);
  const version = branchFromNodes(nodes, versionAt);
  const genesisValidatorsRoot = branchFromNodes(nodes, rootAt);
  const versionBytes = version.leaf.slice(0, 10) as Hex;
  if (versionLeaf(versionBytes) !== version.leaf) throw new Error(`the leaf at ${versionAt} is not a fork version: ${version.leaf}`);
  return { timestamp: input.timestamp, header: input.header, version: versionBytes, branch: version.branch, genesisValidatorsRootBranch: genesisValidatorsRoot.branch };
};
