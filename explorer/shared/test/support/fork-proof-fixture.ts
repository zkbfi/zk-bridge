import { hashPair } from "@zkb/core";
import { padHex, type Hex } from "viem";

const chunk = (byte: number): Hex => `0x${byte.toString(16).padStart(2, "0").repeat(32)}` as Hex;

/** The siblings of the leaf at `index` of a full tree over `leaves` (a power of two), deepest first, and the root. */
function branchOf(leaves: readonly Hex[], index: number): { readonly branch: Hex[]; readonly root: Hex } {
  const branch: Hex[] = [];
  let level = [...leaves];
  let at = index;
  while (level.length > 1) {
    branch.push(level[at ^ 1] as Hex);
    const next: Hex[] = [];
    for (let position = 0; position < level.length; position += 2) next.push(hashPair(level[position] as Hex, level[position + 1] as Hex));
    level = next;
    at >>= 1;
  }
  return { branch, root: level[0] as Hex };
}

/**
 * A plain `BeaconState` of `depth` (2^depth field roots) with a `Fork` at field 3 and a genesis validators root at field
 * 1, and the fork proof record of it, as the prover prints it (sorted keys). The other fields are arbitrary chunks.
 */
export function forkProofRecordFixture(options: {
  readonly chainId?: number;
  readonly depth?: number;
  readonly seed?: number;
  readonly slot?: number;
  readonly executionBlockNumber?: number;
  readonly version?: Hex;
} = {}): { readonly text: string; readonly stateRoot: Hex; readonly value: Record<string, unknown> } {
  const depth = options.depth ?? 6;
  const seed = options.seed ?? 0x10;
  const version = options.version ?? "0x90000075";
  const genesisValidatorsRoot = chunk(seed + 1);
  const previous = padHex("0x90000074", { size: 32, dir: "right" });
  const current = padHex(version, { size: 32, dir: "right" });
  const epochChunk = chunk(seed + 2);
  const zero = chunk(0);
  const forkLeaves = [previous, current, epochChunk, zero];
  const fields = Array.from({ length: 2 ** depth }, (_, index) => chunk((seed + 3 + index) % 256));
  fields[1] = genesisValidatorsRoot;
  fields[3] = branchOf(forkLeaves, 0).root;
  const inFork = branchOf(forkLeaves, 1).branch;
  const { branch: forkBranch, root: stateRoot } = branchOf(fields, 3);
  const value = {
    blockRoot: chunk(seed + 4),
    chainId: options.chainId ?? 943,
    executionBlockHash: chunk(seed + 5),
    executionBlockNumber: options.executionBlockNumber ?? 1234,
    format: "zkb-fork-proof/1",
    genesisValidatorsRoot,
    genesisValidatorsRootBranch: branchOf(fields, 1).branch,
    shape: depth,
    slot: options.slot ?? 5678,
    stateRoot,
    version,
    versionBranch: [...inFork, ...forkBranch],
  };
  return { text: JSON.stringify(value), stateRoot, value };
}
