import { createHash } from "node:crypto";
import { keccak256, type Hex } from "viem";
import { z } from "zod";
import { decodeLightClientOutput, PROOF_DIRECTIONS, type ProofDirection } from "@zk-bridge/shared";
import { proofCacheEntrySchema } from "@zk-bridge/shared/prover";

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
