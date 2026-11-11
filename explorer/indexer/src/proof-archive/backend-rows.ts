import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import type { Hex } from "viem";
import { z } from "zod";
import { PROOF_DIRECTIONS, tryDecodeProofMessage } from "@zk-bridge/shared";
import { evidenceRecord, forkProofArchiveRecord, handoffRecord, lightClientRecord } from "./records";
import { logArchive } from "./runtime";
import { emptyTally, type ProofArchive, type UpsertTally } from "./store";

/**
 * The proofs of the backend (explorer/backend): the proof the msgboard indexer keeps (`proofs`), the proofs the prover
 * sent back for jobs (`webhook_proofs`, posted to the board or still held), and the delivery evidence of messages
 * (`evidence`). A held proof exists nowhere else, and the backend drops a held proof whose job ended and evidence whose
 * message was delivered, so the archive takes a copy of each. The backend also captures the handoff update of every
 * sync-committee period of each source chain (`handoff_updates`), which the archive keeps for good, and the fork proof of each source block that carries a message (`fork_proofs`),
 * likewise. Two ways in: the backend's private route
 * `GET /archive/proofs` (polled by the indexer) and a snapshot of its SQLite file (the export and import scripts).
 */

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/);
const direction = z.enum(PROOF_DIRECTIONS);

/** The rows, as the backend route sends them and as {@link readBackendSnapshot} reads them. */
export const backendRowsSchema = z.object({
  board: z.array(z.object({ direction, payload: hex, storedAt: z.number() })).default([]),
  held: z
    .array(z.object({ jobId: z.string(), direction, payload: hex, storedAt: z.number(), postedAt: z.number().nullable(), messageHash: hex.nullable() }))
    .default([]),
  evidence: z.array(z.object({ messageId: hex, direction, body: z.string(), storedAt: z.number() })).default([]),
  /** The handoff updates the backend stored in the last 7 days (older ones come in with the nightly snapshot). */
  handoffs: z.array(z.object({ chainId: z.number().int(), period: z.number().int(), record: z.string(), storedAt: z.number() })).default([]),
  /** The fork proofs of source blocks the backend stored in the last 7 days (older ones come in with the nightly snapshot). */
  forkProofs: z.array(z.object({ chainId: z.number().int(), stateRoot: z.string(), record: z.string(), storedAt: z.number() })).default([]),
});
export type BackendRows = z.infer<typeof backendRowsSchema>;

/** What an ingest did: the upsert outcomes, and the rows that were not a valid proof message. */
export type IngestTally = UpsertTally & { invalid: number };

/** Puts the backend rows into the archive. Evidence carries no pair, so it takes `pairName`. */
export async function ingestBackendRows(archive: ProofArchive, pairName: string, rows: BackendRows): Promise<IngestTally> {
  const tally: IngestTally = { ...emptyTally(), invalid: 0 };
  const proofs = [
    ...rows.board.map((row) => ({ payload: row.payload as Hex, source: "backend-board", jobId: null, messageHash: null })),
    ...rows.held.map((row) => ({ payload: row.payload as Hex, source: "backend-held", jobId: row.jobId, messageHash: row.messageHash })),
  ];
  for (const proof of proofs) {
    const decoded = tryDecodeProofMessage(proof.payload);
    if (!decoded.ok) {
      tally.invalid += 1;
      continue;
    }
    const message = decoded.message;
    const record = lightClientRecord({
      pair: message.pair,
      direction: message.direction,
      proof: message.proof,
      publicValues: message.publicValues,
      source: proof.source,
      extras: { programKey: message.programKey.toLowerCase(), payload: proof.payload.toLowerCase(), backendJobId: proof.jobId, boardMessageHash: proof.messageHash?.toLowerCase() ?? null },
    });
    tally[await archive.putLightClientProof(record)] += 1;
  }
  for (const row of rows.evidence) {
    const record = evidenceRecord({ messageId: row.messageId, pair: pairName, direction: row.direction, body: row.body, storedAt: row.storedAt, source: "backend" });
    tally[await archive.putEvidence(record)] += 1;
  }
  for (const row of rows.handoffs) {
    const checked = handoffRecord({ chainId: row.chainId, period: row.period, record: row.record, storedAt: row.storedAt, source: "backend" });
    if (!checked.ok) {
      tally.invalid += 1;
      logArchive("warn", "proof_archive_handoff_refused", { chainId: row.chainId, period: row.period, reason: checked.reason });
      continue;
    }
    const outcome = await archive.putHandoff(checked.record);
    tally[outcome] += 1;
    if (outcome === "conflict") logArchive("warn", "proof_archive_conflict", { table: "handoff_updates", chainId: row.chainId, period: row.period });
  }
  for (const row of rows.forkProofs) {
    const checked = forkProofArchiveRecord({ chainId: row.chainId, stateRoot: row.stateRoot, record: row.record, storedAt: row.storedAt, source: "backend" });
    if (!checked.ok) {
      tally.invalid += 1;
      logArchive("warn", "proof_archive_fork_proof_refused", { chainId: row.chainId, stateRoot: row.stateRoot, reason: checked.reason });
      continue;
    }
    const outcome = await archive.putForkProof(checked.record);
    tally[outcome] += 1;
    if (outcome === "conflict") logArchive("warn", "proof_archive_conflict", { table: "fork_proofs", chainId: row.chainId, stateRoot: row.stateRoot });
  }
  return tally;
}

const tableExists = (database: DatabaseSync, name: string): boolean =>
  database.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

/**
 * Reads the proof tables of a backend SQLite file, read only. A table that the file lacks gives no rows. Rows that do
 * not parse (a board row whose body is not the stored JSON) are left out and counted in `skipped`.
 */
export function readBackendSnapshot(path: string): { rows: BackendRows; skipped: number } {
  // Loaded when used: Ponder runs every file under src/ through Vite 5, which cannot resolve `node:sqlite`, and the live
  // archiver imports this module for its schema and ingest only.
  const { DatabaseSync: Database } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  const database = new Database(path, { readOnly: true });
  try {
    let skipped = 0;
    type Board = { direction: string; body: string; stored_at: number };
    const board = tableExists(database, "proofs")
      ? (database.prepare("SELECT direction, body, stored_at FROM proofs ORDER BY direction").all() as Board[]).flatMap((row) => {
          try {
            return [{ direction: row.direction, payload: (JSON.parse(row.body) as { payload: unknown }).payload, storedAt: row.stored_at }];
          } catch {
            skipped += 1;
            return [];
          }
        })
      : [];
    type Held = { job_id: string; direction: string; payload: string; stored_at: number; posted_at: number | null; message_hash: string | null };
    const held = tableExists(database, "webhook_proofs")
      ? (database.prepare("SELECT job_id, direction, payload, stored_at, posted_at, message_hash FROM webhook_proofs ORDER BY stored_at, job_id").all() as Held[]).map((row) => ({
          jobId: row.job_id,
          direction: row.direction,
          payload: row.payload,
          storedAt: row.stored_at,
          postedAt: row.posted_at,
          messageHash: row.message_hash,
        }))
      : [];
    type Evidence = { message_id: string; direction: string; body: string; stored_at: number };
    const evidence = tableExists(database, "evidence")
      ? (database.prepare("SELECT message_id, direction, body, stored_at FROM evidence ORDER BY message_id").all() as Evidence[]).map((row) => ({
          messageId: row.message_id,
          direction: row.direction,
          body: row.body,
          storedAt: row.stored_at,
        }))
      : [];
    type Handoff = { chain_id: number; period: number; record: string; stored_at: number };
    const handoffs = tableExists(database, "handoff_updates")
      ? (database.prepare("SELECT chain_id, period, record, stored_at FROM handoff_updates ORDER BY chain_id, period").all() as Handoff[]).map((row) => ({
          chainId: row.chain_id,
          period: row.period,
          record: row.record,
          storedAt: row.stored_at,
        }))
      : [];
    type ForkProof = { chain_id: number; state_root: string; record: string; stored_at: number };
    const forkProofs = tableExists(database, "fork_proofs")
      ? (database.prepare("SELECT chain_id, state_root, record, stored_at FROM fork_proofs ORDER BY chain_id, state_root").all() as ForkProof[]).map((row) => ({
          chainId: row.chain_id,
          stateRoot: row.state_root,
          record: row.record,
          storedAt: row.stored_at,
        }))
      : [];
    const parsed = backendRowsSchema.safeParse({ board, held, evidence, handoffs, forkProofs });
    if (!parsed.success) throw new Error(`the backend file holds rows of an unknown shape: ${parsed.error.issues[0]?.path.join(".")}`);
    return { rows: parsed.data, skipped };
  } finally {
    database.close();
  }
}
