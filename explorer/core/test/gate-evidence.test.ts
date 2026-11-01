import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { padHex, sha256, toHex, type Hex } from "viem";
import {
  ALLOWED_SHAPES,
  BEACON_ROOTS_ADDRESS,
  beaconHeaderRoot,
  branchFromNodes,
  checkConfirmEvidence,
  compactMultiproofDescriptor,
  compactMultiproofNodes,
  confirmCalldata,
  decodeForkEvidence,
  depthOfVersionBranch,
  encodeForkEvidence,
  forkEvidenceFromMultiproof,
  forkProofGindices,
  gateEpochAt,
  gateEpochEnd,
  genesisValidatorsRootBranchLength,
  genesisValidatorsRootGindex,
  hashPair,
  isAllowedShape,
  isValidBranch,
  judgeForkEvidence,
  plainVersionGindex,
  PROGRESSIVE_SHAPE,
  versionBranchLength,
  versionGindex,
  versionLeaf,
  type BeaconBlockHeader,
  type ForkEvidence,
} from "../src/index.js";

/**
 * One real Sepolia epoch, recorded read-only from public endpoints by `explorer/data/scripts/capture-gate-fixture.mjs`.
 * The forge test `test/hardened/GateEvidenceSepolia.t.sol` feeds the same calldata to the real gate.
 */
const fixture = JSON.parse(readFileSync(new URL("../../../test/hardened/fixtures/gate_evidence_sepolia.json", import.meta.url), "utf8")) as {
  block: { timestamp: string; parentBeaconBlockRoot: Hex };
  reads: { genesisTime: string; secondsPerSlot: string; slotsPerEpoch: string; genesisValidatorsRoot: Hex };
  beaconResponses: { path: string; body: { data: { header?: { message: Record<string, string> }; leaves?: Hex[]; descriptor?: Hex } } }[];
  expected: {
    epoch: string;
    forkVersion: Hex;
    shape: number;
    validUntil: string;
    branch: Hex[];
    genesisValidatorsRootBranch: Hex[];
    encoded: Hex;
    calldata: Hex;
  };
};

const message = fixture.beaconResponses[0]!.body.data.header!.message;
const header: BeaconBlockHeader = {
  slot: BigInt(message.slot!),
  proposerIndex: BigInt(message.proposer_index!),
  parentRoot: message.parent_root as Hex,
  stateRoot: message.state_root as Hex,
  bodyRoot: message.body_root as Hex,
};
const proof = fixture.beaconResponses[1]!.body.data as { leaves: Hex[]; descriptor: Hex };
const timestamp = BigInt(fixture.block.timestamp);
const beaconRoot = fixture.block.parentBeaconBlockRoot;
const genesisValidatorsRoot = fixture.reads.genesisValidatorsRoot;
const clock = { genesisTime: BigInt(fixture.reads.genesisTime), secondsPerSlot: BigInt(fixture.reads.secondsPerSlot), slotsPerEpoch: BigInt(fixture.reads.slotsPerEpoch) };
const epoch = BigInt(fixture.expected.epoch);

const evidence = (): ForkEvidence => forkEvidenceFromMultiproof({ timestamp, header, shape: PROGRESSIVE_SHAPE, descriptor: proof.descriptor, leaves: proof.leaves });
const check = (changed: ForkEvidence, root: Hex = beaconRoot, at: bigint = epoch) =>
  checkConfirmEvidence({ evidence: changed, beaconRoot: root, epoch: at, slotsPerEpoch: clock.slotsPerEpoch, genesisValidatorsRoot });
const flip = (value: Hex): Hex => padHex(toHex(BigInt(value) ^ 1n), { size: 32 });

describe("the gindices of ForkShape", () => {
  it("are the values of the contract", () => {
    expect(ALLOWED_SHAPES).toEqual([5, 6, 7, 255]);
    expect(BEACON_ROOTS_ADDRESS).toBe("0x000f3df6d732807ef1319fb7b8bb8522d0beac02");
    expect([5, 6, 7].map(plainVersionGindex)).toEqual([141n, 269n, 525n]);
    expect(versionGindex(PROGRESSIVE_SHAPE)).toBe(169n);
    expect(versionGindex(6)).toBe(269n);
    expect(genesisValidatorsRootGindex(PROGRESSIVE_SHAPE)).toBe(40n);
    expect(genesisValidatorsRootGindex(5)).toBe(33n);
    expect([5, 6, 7, 255].map(versionBranchLength)).toEqual([7, 8, 9, 7]);
    expect([5, 6, 7, 255].map(genesisValidatorsRootBranchLength)).toEqual([5, 6, 7, 5]);
    expect(depthOfVersionBranch(1)).toBe(0);
    expect(depthOfVersionBranch(9)).toBe(7);
    expect(isAllowedShape(255)).toBe(true);
    expect(isAllowedShape(8)).toBe(false);
    expect(forkProofGindices(PROGRESSIVE_SHAPE)).toEqual([169n, 40n]);
  });
});

describe("the recorded Sepolia epoch", () => {
  it("has a header that hashes to the root of the beacon roots contract", () => {
    expect(beaconHeaderRoot(header)).toBe(beaconRoot);
  });

  it("asked for the descriptor of the two progressive leaves, and the proof hashes to the state root", () => {
    expect(compactMultiproofDescriptor([169n, 40n])).toBe("0x231f80");
    expect(proof.descriptor).toBe("0x231f80");
    expect(fixture.beaconResponses[1]!.path).toContain("format=0x231f80");
    expect(compactMultiproofNodes(proof.descriptor, proof.leaves).root).toBe(header.stateRoot);
  });

  it("gives the evidence that the builder recorded, and it passes every check of confirm", () => {
    const built = evidence();
    expect(built.version).toBe(fixture.expected.forkVersion);
    expect(built.version).toBe("0x90000076");
    expect(built.branch).toEqual(fixture.expected.branch);
    expect(built.genesisValidatorsRootBranch).toEqual(fixture.expected.genesisValidatorsRootBranch);
    expect(check(built)).toEqual({ ok: true, shape: PROGRESSIVE_SHAPE });
    expect(encodeForkEvidence(built)).toBe(fixture.expected.encoded);
    expect(confirmCalldata(built)).toBe(fixture.expected.calldata);
    expect(decodeForkEvidence(fixture.expected.encoded)).toEqual(built);
  });

  it("is refused with the error of the contract when a piece is wrong", () => {
    const built = evidence();
    expect(check(built, padHex("0x0", { size: 32 }))).toMatchObject({ ok: false, error: "BeaconRootUnavailable" });
    expect(check(built, flip(beaconRoot))).toMatchObject({ ok: false, error: "HeaderRootMismatch" });
    expect(check({ ...built, header: { ...header, proposerIndex: header.proposerIndex + 1n } })).toMatchObject({ ok: false, error: "HeaderRootMismatch" });
    expect(check(built, beaconRoot, epoch + 1n)).toMatchObject({ ok: false, error: "HeaderNotInCurrentEpoch" });
    expect(check({ ...built, version: "0x90000075" })).toMatchObject({ ok: false, error: "ForkProofInvalid" });
    expect(check({ ...built, branch: built.branch.map((node, index) => (index === 3 ? flip(node) : node)) })).toMatchObject({ ok: false, error: "ForkProofInvalid" });
    expect(check({ ...built, genesisValidatorsRootBranch: [flip(built.genesisValidatorsRootBranch[0]!), ...built.genesisValidatorsRootBranch.slice(1)] })).toMatchObject({
      ok: false,
      error: "GenesisValidatorsRootBranchInvalid",
    });
    expect(check({ ...built, genesisValidatorsRootBranch: built.genesisValidatorsRootBranch.slice(1) })).toMatchObject({ ok: false, error: "GenesisValidatorsRootBranchInvalid" });
    expect(check({ ...built, branch: built.branch.slice(0, 3) })).toEqual({ ok: false, error: "ShapeNotAllowed", detail: "a version branch of 3 entries implies depth 1" });
  });

  it("names the epoch and its end with the clock of the gate", () => {
    expect(gateEpochAt(timestamp + clock.secondsPerSlot, clock)).toBe(epoch);
    expect(gateEpochEnd(epoch, clock)).toBe(BigInt(fixture.expected.validUntil));
    expect(gateEpochAt(gateEpochEnd(epoch, clock), clock)).toBe(epoch + 1n);
    expect(() => gateEpochAt(clock.genesisTime - 1n, clock)).toThrow(/before the genesis time/);
  });
});

/** A plain state tree of a depth: `Fork` at field 3, the genesis validators root at field 1, filler elsewhere. */
const plainState = (depth: number, version: Hex) => {
  const fork = [versionLeaf("0x01020304"), versionLeaf(version), padHex("0x07", { size: 32, dir: "right" }), padHex("0x0", { size: 32 })];
  const forkRoot = hashPair(hashPair(fork[0]!, fork[1]!), hashPair(fork[2]!, fork[3]!));
  const fields = Array.from({ length: 2 ** depth }, (_, field) => (field === 3 ? forkRoot : field === 1 ? genesisValidatorsRoot : sha256(toHex(`field ${field}`))));
  // Every node of the tree by generalized index, the fork container below field 3.
  const nodes = new Map<bigint, Hex>();
  const first = 1n << BigInt(depth);
  fields.forEach((field, index) => nodes.set(first + BigInt(index), field));
  for (let at = first - 1n; at >= 1n; at -= 1n) nodes.set(at, hashPair(nodes.get(2n * at)!, nodes.get(2n * at + 1n)!));
  const forkAt = first + 3n;
  [fork[0]!, fork[1]!, fork[2]!, fork[3]!].forEach((leaf, index) => nodes.set(forkAt * 4n + BigInt(index), leaf));
  nodes.set(forkAt * 2n, hashPair(fork[0]!, fork[1]!));
  nodes.set(forkAt * 2n + 1n, hashPair(fork[2]!, fork[3]!));
  return { stateRoot: nodes.get(1n)!, branch: branchFromNodes(nodes, plainVersionGindex(depth)).branch, genesisValidatorsRootBranch: branchFromNodes(nodes, genesisValidatorsRootGindex(depth)).branch };
};

describe("judgeForkEvidence", () => {
  it("finds each plain depth of the allowed set", () => {
    for (const depth of [5, 6, 7]) {
      const state = plainState(depth, "0x06000000");
      expect(judgeForkEvidence({ ...state, version: "0x06000000", genesisValidatorsRoot }), `depth ${depth}`).toEqual({ verdict: "Allowed", shape: depth });
    }
  });

  it("refuses a depth outside the set, and a previous version at the current position", () => {
    const deep = plainState(8, "0x07000000");
    expect(judgeForkEvidence({ ...deep, version: "0x07000000", genesisValidatorsRoot })).toEqual({ verdict: "ShapeNotAllowed", shape: 0 });
    const state = plainState(6, "0x06000000");
    expect(judgeForkEvidence({ ...state, version: "0x01020304", genesisValidatorsRoot }).verdict).toBe("VersionProofInvalid");
    expect(judgeForkEvidence({ ...state, version: "0x06000000", genesisValidatorsRoot: flip(genesisValidatorsRoot) }).verdict).toBe("GenesisValidatorsRootProofInvalid");
  });
});

describe("isValidBranch", () => {
  it("is false for a generalized index of zero and for a branch of another length", () => {
    const state = plainState(5, "0x06000000");
    expect(isValidBranch(versionLeaf("0x06000000"), state.branch, plainVersionGindex(5), state.stateRoot)).toBe(true);
    expect(isValidBranch(versionLeaf("0x06000000"), state.branch, 0n, state.stateRoot)).toBe(false);
    expect(isValidBranch(versionLeaf("0x06000000"), state.branch.slice(1), plainVersionGindex(5), state.stateRoot)).toBe(false);
  });
});

describe("compact multiproofs", () => {
  const leaf = (n: number): Hex => padHex(toHex(n), { size: 32 });

  it("describes and rebuilds a proof of one leaf", () => {
    // Node 5: root 0, node 2 0, node 4 1, node 5 1, node 3 1, then zeros.
    expect(compactMultiproofDescriptor([5n])).toBe("0x38");
    const { root, nodes } = compactMultiproofNodes("0x38", [leaf(4), leaf(5), leaf(3)]);
    expect(root).toBe(hashPair(hashPair(leaf(4), leaf(5)), leaf(3)));
    expect(branchFromNodes(nodes, 5n)).toEqual({ leaf: leaf(5), branch: [leaf(4), leaf(3)] });
    expect(compactMultiproofDescriptor([1n])).toBe("0x80");
  });

  it("refuses a malformed request or proof", () => {
    expect(() => compactMultiproofDescriptor([])).toThrow(/generalized indices/);
    expect(() => compactMultiproofDescriptor([0n])).toThrow(/generalized indices/);
    expect(() => compactMultiproofNodes("0x00", [leaf(1)])).toThrow(/ends inside the tree/);
    expect(() => compactMultiproofNodes("0x38", [leaf(4), leaf(5)])).toThrow(/fewer leaves/);
    expect(() => compactMultiproofNodes("0x38", [leaf(4), leaf(5), leaf(3), leaf(6)])).toThrow(/more leaves/);
    expect(() => compactMultiproofNodes("0x39", [leaf(4), leaf(5), leaf(3)])).toThrow(/bits after the tree/);
    expect(() => compactMultiproofNodes("0x3800", [leaf(4), leaf(5), leaf(3)])).toThrow(/bits after the tree/);
  });

  it("names a node that the proof lacks", () => {
    const { nodes } = compactMultiproofNodes("0x38", [leaf(4), leaf(5), leaf(3)]);
    expect(() => branchFromNodes(nodes, 9n)).toThrow(/no node 9/);
    const partial = new Map(nodes);
    partial.delete(4n);
    expect(() => branchFromNodes(partial, 5n)).toThrow(/no sibling 4 of node 5/);
  });

  it("refuses evidence from a proof of another state, and a version leaf that is not four bytes", () => {
    expect(() => forkEvidenceFromMultiproof({ timestamp, header: { ...header, stateRoot: flip(header.stateRoot) }, shape: PROGRESSIVE_SHAPE, descriptor: proof.descriptor, leaves: proof.leaves })).toThrow(/not to the state root/);
    // Shape 5 asks for nodes that a progressive proof does not hold.
    expect(() => forkEvidenceFromMultiproof({ timestamp, header, shape: 5, descriptor: proof.descriptor, leaves: proof.leaves })).toThrow(/no node/);
    // A version leaf with a fifth byte is no fork version, even in a tree that hashes to the state root.
    const { nodes } = compactMultiproofNodes(proof.descriptor, proof.leaves);
    const leaves = [...proof.leaves];
    leaves[4] = padHex("0x9000007601", { size: 32, dir: "right" });
    const tampered = compactMultiproofNodes(proof.descriptor, leaves);
    expect(tampered.root).not.toBe(nodes.get(1n));
    expect(() => forkEvidenceFromMultiproof({ timestamp, header: { ...header, stateRoot: tampered.root }, shape: PROGRESSIVE_SHAPE, descriptor: proof.descriptor, leaves })).toThrow(/is not a fork version/);
  });
});
