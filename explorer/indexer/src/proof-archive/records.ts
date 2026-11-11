import { createHash } from "node:crypto";
import { keccak256, type Hex } from "viem";
import { z } from "zod";
import { decodeLightClientOutput, PROOF_DIRECTIONS, type ProofDirection } from "@zk-bridge/shared";
import { checkForkProofRecord, proofCacheEntrySchema } from "@zk-bridge/shared/prover";

/**
 * The rows of the proof archive as plain records: the shape of the read routes, of the export files (one JSON record a
 * line) and of the import. Numbers that can pass 2^53 (slots, block numbers of a light client output) are decimal strings.
 */

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/);
const decimal = z.string().regex(/^\d+$/);

/** An `eth_getProof` answer: a proof cache entry (`proof-cache.ts`) with the host it came from. */
export const storageProofRecordSchema = proofCacheEntrySchema.extend({ sourceHost: z.string().nullable().default(null) });
export type StorageProofRecord = z.infer<typeof storageProofRecordSchema>;

/** One light client update proof. The fields after `publicValues` up to `executionBlockNumber` derive from it. */
export const lightClientProofRecordSchema = z.object({
  pair: z.string().min(1),
  direction: z.enum(PROOF_DIRECTIONS),
  startSlot: decimal,
  newSlot: decimal,
  proofHash: hex,
  proof: hex,
  publicValues: hex,
  startRoot: hex,
  newRoot: hex,
  executionBlockHash: hex,
  executionBlockNumber: decimal,
  /** The program key and the whole proof message, when the proof came as a message (board, backend). */
  programKey: hex.nullable().default(null),
  payload: hex.nullable().default(null),
  /** The `update` transaction that posted it, when the indexer saw one. */
  postedChainId: z.number().int().positive().nullable().default(null),
  postedTransactionHash: hex.nullable().default(null),
  postedBlockNumber: decimal.nullable().default(null),
  boardMessageHash: hex.nullable().default(null),
  backendJobId: z.string().nullable().default(null),
  /** Where the archive first got it: `calldata`, `backend-board`, `backend-held`, `import`. */
  source: z.string().min(1),
});
export type LightClientProofRecord = z.infer<typeof lightClientProofRecordSchema>;

/** The delivery evidence of a message, with the JSON text exactly as the backend stored it. */
export const evidenceRecordSchema = z.object({
  messageId: hex,
  bodyHash: hex,
  pair: z.string().min(1),
  direction: z.enum(PROOF_DIRECTIONS),
  body: z.string(),
  storedAt: z.number().int().nullable().default(null),
  source: z.string().min(1),
});
export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;

/** The parts of a light client proof that do not derive from the proof and the public values. */
export type LightClientProofExtras = Partial<
  Pick<LightClientProofRecord, "programKey" | "payload" | "postedChainId" | "postedTransactionHash" | "postedBlockNumber" | "boardMessageHash" | "backendJobId">
>;

/**
 * Builds the record of a light client proof from the proof and its public values.
 *
 * @throws When the public values are not 352 bytes.
 */
export function lightClientRecord(input: {
  readonly pair: string;
  readonly direction: ProofDirection;
  readonly proof: Hex;
  readonly publicValues: Hex;
  readonly source: string;
  readonly extras?: LightClientProofExtras;
}): LightClientProofRecord {
  const output = decodeLightClientOutput(input.publicValues);
  return {
    pair: input.pair,
    direction: input.direction,
    startSlot: output.previousHeadSlot.toString(),
    newSlot: output.newHeadSlot.toString(),
    proofHash: keccak256(input.proof),
    proof: input.proof.toLowerCase(),
    publicValues: input.publicValues.toLowerCase(),
    startRoot: output.previousHeaderRoot,
    newRoot: output.newHeaderRoot,
    executionBlockHash: output.executionBlockHash,
    executionBlockNumber: output.executionBlockNumber.toString(),
    programKey: null,
    payload: null,
    postedChainId: null,
    postedTransactionHash: null,
    postedBlockNumber: null,
    boardMessageHash: null,
    backendJobId: null,
    ...input.extras,
    source: input.source,
  };
}

/** Whether the derived fields of a record (from a file, so not trusted) match its proof and public values. */
export function lightClientRecordConsistent(record: LightClientProofRecord): boolean {
  try {
    const rebuilt = lightClientRecord({ pair: record.pair, direction: record.direction, proof: record.proof as Hex, publicValues: record.publicValues as Hex, source: record.source });
    return (["startSlot", "newSlot", "proofHash", "proof", "publicValues", "startRoot", "newRoot", "executionBlockHash", "executionBlockNumber"] as const).every(
      (field) => rebuilt[field].toLowerCase() === record[field].toLowerCase(),
    );
  } catch {
    return false;
  }
}

/** The record of a piece of evidence. `bodyHash` is the SHA-256 of the text as stored. */
export function evidenceRecord(input: { readonly messageId: string; readonly pair: string; readonly direction: ProofDirection; readonly body: string; readonly storedAt: number | null; readonly source: string }): EvidenceRecord {
  return {
    messageId: input.messageId.toLowerCase(),
    bodyHash: `0x${createHash("sha256").update(input.body).digest("hex")}`,
    pair: input.pair,
    direction: input.direction,
    body: input.body,
    storedAt: input.storedAt,
    source: input.source,
  };
}

/** The format tag of a handoff update record. */
export const HANDOFF_FORMAT = "zkb-handoff-update/1";
/** Slots in a sync-committee period: 8192 on all four chains. */
export const SLOTS_PER_PERIOD = 8192;
const HANDOFF_ROOT = /^0x[0-9a-fA-F]{64}$/;
const INTEGER_COLUMN = 2_147_483_647;

/**
 * The handoff update of one sync-committee period of a source chain, as the backend captured it: a complete,
 * prover-ready light client update that carries the committee of the next period. `record` is the JSON text exactly as
 * the backend stored it (compact, sorted keys), so the bytes and the hash hold; `sha256` is the hex SHA-256 of that
 * text. The slots are read from the text. The zk proof checks the committee signatures, so the data is untrusted.
 */
export const handoffRecordSchema = z.object({
  chainId: z.number().int().positive().max(INTEGER_COLUMN),
  period: z.number().int().nonnegative().max(INTEGER_COLUMN),
  record: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  attestedSlot: z.number().int().nonnegative(),
  finalizedSlot: z.number().int().nonnegative(),
  storedAt: z.number().int().nullable().default(null),
  source: z.string().min(1),
});
export type HandoffRecord = z.infer<typeof handoffRecordSchema>;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Checks a handoff update text against the key it is stored under and builds its archive record. A text that fails
 * is refused with the reason (never the text itself).
 */
export function handoffRecord(input: { readonly chainId: number; readonly period: number; readonly record: string; readonly storedAt: number | null; readonly source: string }): { ok: true; record: HandoffRecord } | { ok: false; reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(input.record);
  } catch {
    return { ok: false, reason: "the record is not JSON" };
  }
  if (!isObject(value)) return { ok: false, reason: "the record is not an object" };
  if (value.format !== HANDOFF_FORMAT) return { ok: false, reason: "the record has another format" };
  const whole = (item: unknown): item is number => typeof item === "number" && Number.isSafeInteger(item) && item >= 0;
  if (!whole(value.chainId) || value.chainId !== input.chainId || !whole(value.period) || value.period !== input.period) return { ok: false, reason: "the chain or period differs from the key" };
  if (input.chainId < 1 || input.chainId > INTEGER_COLUMN || input.period > INTEGER_COLUMN) return { ok: false, reason: "the chain or period is out of range" };
  const { attestedSlot, signatureSlot, finalizedSlot } = value;
  if (!whole(attestedSlot) || !whole(signatureSlot) || Math.floor(attestedSlot / SLOTS_PER_PERIOD) !== input.period || Math.floor(signatureSlot / SLOTS_PER_PERIOD) !== input.period) {
    return { ok: false, reason: "a slot is not in the period" };
  }
  if (!whole(finalizedSlot) || finalizedSlot > attestedSlot) return { ok: false, reason: "the finalized slot is not a slot up to the attested one" };
  if (typeof value.nextSyncCommitteeRoot !== "string" || !HANDOFF_ROOT.test(value.nextSyncCommitteeRoot)) return { ok: false, reason: "the next sync committee root is not 32 bytes of hex" };
  if (!isObject(value.update) || !isObject(value.update.next_sync_committee)) return { ok: false, reason: "the update has no next sync committee" };
  return {
    ok: true,
    record: {
      chainId: input.chainId,
      period: input.period,
      record: input.record,
      sha256: createHash("sha256").update(input.record).digest("hex"),
      attestedSlot,
      finalizedSlot,
      storedAt: input.storedAt,
      source: input.source,
    },
  };
}

/**
 * The fork proof of one source beacon block: the `MessageProof.sourceFork` (the fork version and the genesis validators
 * root, each proven under the state root of the block), saved while a beacon node still serves the state. `record` is the
 * JSON text exactly as the backend stored it (canonical, sorted keys), so the bytes and the hash hold; `sha256` is the hex
 * SHA-256 of that text. The other fields are read from the text. Several messages in one block share one record; the key
 * is the chain and the state root. The data is public and untrusted: every holder checks it with `checkForkProofRecord`.
 */
export const forkProofRecordSchema = z.object({
  chainId: z.number().int().positive().max(INTEGER_COLUMN),
  stateRoot: z.string().regex(/^0x[0-9a-f]{64}$/),
  slot: z.number().int().nonnegative(),
  blockRoot: z.string().regex(/^0x[0-9a-f]{64}$/),
  executionBlockNumber: z.number().int().nonnegative(),
  executionBlockHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  shape: z.number().int().nonnegative().max(INTEGER_COLUMN),
  record: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  storedAt: z.number().int().nullable().default(null),
  source: z.string().min(1),
});
export type ForkProofArchiveRecord = z.infer<typeof forkProofRecordSchema>;

/**
 * Checks a fork proof text against the key it is stored under (the whole check of `checkForkProofRecord`: the shape and
 * both branches against the state root) and builds its archive record. A text that fails is refused with the reason
 * (never the text itself).
 */
export function forkProofArchiveRecord(input: { readonly chainId: number; readonly stateRoot: string; readonly record: string; readonly storedAt: number | null; readonly source: string }): { ok: true; record: ForkProofArchiveRecord } | { ok: false; reason: string } {
  if (input.chainId < 1 || input.chainId > INTEGER_COLUMN) return { ok: false, reason: "the chain is out of range" };
  const checked = checkForkProofRecord(input.record, { chainId: input.chainId, stateRoot: input.stateRoot });
  if (!checked.ok) return { ok: false, reason: checked.reason };
  const { chainId, slot, blockRoot, stateRoot, executionBlockNumber, executionBlockHash, shape } = checked.record;
  return {
    ok: true,
    record: {
      chainId,
      stateRoot,
      slot,
      blockRoot,
      executionBlockNumber,
      executionBlockHash,
      shape,
      record: input.record,
      sha256: createHash("sha256").update(input.record).digest("hex"),
      storedAt: input.storedAt,
      source: input.source,
    },
  };
}
