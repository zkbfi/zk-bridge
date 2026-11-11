/**
 * The fork proof record: the `MessageProof.sourceFork` of one source block, saved while a beacon node still serves the
 * state of that block. The prover prints it (`zk-bridge-prover fork-proof`), the backend keeps it
 * (`explorer/backend/src/archive/fork-proofs.ts`), the proof archive of the indexer keeps it for good and publishes it,
 * and the prover reads it back at `<base>/<chainId>/<stateRoot>.json` when no node serves the state any more.
 *
 * Owner, 2026-11-10: "yes, and save fork proofs in the watcher too".
 *
 * A record is public chain data and is not trusted by anyone who reads it. This check is the one every holder runs
 * before it keeps a record: the shape, and both branches against the state root by the rule of `ForkShape.judge`, with
 * the genesis validators root that the record names. The prover runs the same rule again with the genesis validators root
 * of its own chain before it uses a record, and the bridge runs it on chain.
 */
import { judgeForkEvidence } from "@zkb/core";
import type { Hex } from "viem";

/** The `format` field of a record. */
export const FORK_PROOF_RECORD_FORMAT = "zkb-fork-proof/1";

/** What a checked record holds. */
export interface ForkProofRecord {
  /** The record exactly as printed: canonical JSON with sorted keys, which every holder stores and hashes. */
  readonly text: string;
  readonly chainId: number;
  /** The slot of the beacon block whose state the proof is of: the `sourceHeader` of the message proof. */
  readonly slot: number;
  /** The hash tree root of that beacon block header. */
  readonly blockRoot: Hex;
  /** The state root of that header: the key of the record. */
  readonly stateRoot: Hex;
  /** The execution block of the messages (from Gloas on, the block before the beacon block, whose bid names it). */
  readonly executionBlockNumber: number;
  readonly executionBlockHash: Hex;
  /** The shape that the proof proves: a plain depth (5, 6, 7) or 255 for the progressive state. */
  readonly shape: number;
}

const HASH = /^0x[0-9a-f]{64}$/;
const VERSION = /^0x[0-9a-f]{8}$/;

const isWhole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isHash = (value: unknown): value is Hex => typeof value === "string" && HASH.test(value);
const isBranch = (value: unknown): value is Hex[] => Array.isArray(value) && value.every(isHash);

/**
 * Checks a record text. A record passes when it parses, names the format, carries every field in its form (hashes as
 * lower-case 0x hex), and its two branches prove its version and its genesis validators root under its state root at the
 * shape it names.
 *
 * @param text The record as printed or stored.
 * @param expected What the holder asks for: the chain, and the state root when the holder looks one up.
 * @returns The record, or the reason it was refused (a few words, never the text).
 */
export function checkForkProofRecord(
  text: string,
  expected: { readonly chainId: number; readonly stateRoot?: string },
): { readonly ok: true; readonly record: ForkProofRecord } | { readonly ok: false; readonly reason: string } {
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, reason: "not a JSON object" };
    value = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "not JSON" };
  }
  if (value.format !== FORK_PROOF_RECORD_FORMAT) return { ok: false, reason: "unknown format" };
  if (value.chainId !== expected.chainId) return { ok: false, reason: "another chain" };
  const { slot, executionBlockNumber, shape, blockRoot, stateRoot, executionBlockHash, genesisValidatorsRoot, version, versionBranch, genesisValidatorsRootBranch } = value;
  if (!isWhole(slot) || !isWhole(executionBlockNumber) || !isWhole(shape)) return { ok: false, reason: "a number is missing" };
  if (![blockRoot, stateRoot, executionBlockHash, genesisValidatorsRoot].every(isHash)) return { ok: false, reason: "a hash is missing or not lower-case 0x hex" };
  if (expected.stateRoot !== undefined && stateRoot !== expected.stateRoot.toLowerCase()) return { ok: false, reason: "another state root" };
  if (typeof version !== "string" || !VERSION.test(version)) return { ok: false, reason: "the version is not 4 bytes of 0x hex" };
  if (!isBranch(versionBranch) || !isBranch(genesisValidatorsRootBranch)) return { ok: false, reason: "a branch is not a list of hashes" };
  const judged = judgeForkEvidence({
    stateRoot: stateRoot as Hex,
    version: version as Hex,
    branch: versionBranch,
    genesisValidatorsRootBranch,
    genesisValidatorsRoot: genesisValidatorsRoot as Hex,
  });
  if (judged.verdict !== "Allowed") return { ok: false, reason: `the branches do not prove it (${judged.verdict})` };
  if (judged.shape !== shape) return { ok: false, reason: `it names shape ${shape}, the branches prove shape ${judged.shape}` };
  return {
    ok: true,
    record: {
      text,
      chainId: expected.chainId,
      slot,
      blockRoot: blockRoot as Hex,
      stateRoot: stateRoot as Hex,
      executionBlockNumber,
      executionBlockHash: executionBlockHash as Hex,
      shape,
    },
  };
}
