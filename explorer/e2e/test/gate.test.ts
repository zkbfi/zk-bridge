import { describe, expect, it } from "bun:test";
import { sha256, toHex, type Hex } from "viem";
import { buildGateEvidence, forkState, GENESIS_VALIDATORS_ROOT_GENERALIZED_INDEX, hashPair, headerRoot, isValidBranch, VERSION_GENERALIZED_INDEX, branchOf } from "../src/gate.ts";

const ROOT: Hex = `0x${"ab".repeat(32)}`;

describe("fork state", () => {
  it("proves the supported version at the generalized index that the gate computes", () => {
    // The gate checks the branch at ((2**depth + 3) * 4) + 1 for a state of depth 5. A branch that only fits some other
    // index would pass a shape check and fail on chain, so the test walks the branch the way the gate does.
    const state = forkState("0x03000000", "0x02000000", 9n, ROOT);
    const leaf: Hex = `0x03000000${"00".repeat(28)}`;
    expect(state.branch).toHaveLength(7);
    expect(isValidBranch(leaf, state.branch, VERSION_GENERALIZED_INDEX, state.stateRoot)).toBe(true);
  });

  it("fails for another version, so the branch binds the version", () => {
    const state = forkState("0x03000000", "0x02000000", 9n, ROOT);
    const other: Hex = `0x04000000${"00".repeat(28)}`;
    expect(isValidBranch(other, state.branch, VERSION_GENERALIZED_INDEX, state.stateRoot)).toBe(false);
  });
});

describe("genesis validators root branch", () => {
  it("proves the genesis validators root at field 1 of the state, as the gate checks it", () => {
    const state = forkState("0x03000000", "0x02000000", 9n, ROOT);
    expect(state.genesisValidatorsRootBranch).toHaveLength(5);
    expect(isValidBranch(ROOT, state.genesisValidatorsRootBranch, GENESIS_VALIDATORS_ROOT_GENERALIZED_INDEX, state.stateRoot)).toBe(true);
  });

  it("fails for another root, so the branch binds the root", () => {
    const state = forkState("0x03000000", "0x02000000", 9n, ROOT);
    const other: Hex = `0x${"cd".repeat(32)}`;
    expect(isValidBranch(other, state.genesisValidatorsRootBranch, GENESIS_VALIDATORS_ROOT_GENERALIZED_INDEX, state.stateRoot)).toBe(false);
  });
});

describe("merkle helpers", () => {
  it("builds the branch of any leaf of a full tree", () => {
    const leaves = Array.from({ length: 8 }, (_, index) => sha256(toHex(`leaf ${index}`)));
    for (const index of [0, 3, 7]) {
      const { branch, root } = branchOf(leaves, index);
      expect(isValidBranch(leaves[index]!, branch, BigInt(8 + index), root)).toBe(true);
    }
  });

  it("hashes a header as five chunks padded to eight", () => {
    const zero: Hex = `0x${"00".repeat(32)}`;
    const header = { slot: 1n, proposerIndex: 0n, parentRoot: zero, stateRoot: zero, bodyRoot: zero };
    const slotChunk: Hex = `0x01${"00".repeat(31)}`;
    const expected = hashPair(hashPair(hashPair(slotChunk, zero), hashPair(zero, zero)), hashPair(hashPair(zero, zero), hashPair(zero, zero)));
    expect(headerRoot(header)).toBe(expected);
  });
});

describe("gate evidence", () => {
  it("puts the header slot in the epoch of the time and writes the root under the ring position", () => {
    const evidence = buildGateEvidence({ timestamp: 1_800_000_000n, genesisTime: 1_700_000_000n, secondsPerSlot: 12n, slotsPerEpoch: 32n, version: "0x03000000", genesisValidatorsRoot: ROOT });
    expect(evidence.epoch).toBe((100_000_000n / 12n) / 32n);
    expect(BigInt(evidence.storageWrites[0]!.slot)).toBe(1_800_000_000n % 8191n);
    expect(BigInt(evidence.storageWrites[0]!.value)).toBe(1_800_000_000n);
    expect(BigInt(evidence.storageWrites[1]!.slot)).toBe((1_800_000_000n % 8191n) + 8191n);
    expect(evidence.storageWrites[1]!.value).toBe(evidence.beaconRoot);
  });

  it("refuses a time before the genesis of the gate", () => {
    expect(() => buildGateEvidence({ timestamp: 10n, genesisTime: 100n, secondsPerSlot: 12n, slotsPerEpoch: 32n, version: "0x03000000", genesisValidatorsRoot: ROOT })).toThrow("before the genesis time");
  });
});
